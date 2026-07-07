"""In-process async job queue and short-lived share store for Paperless.

Jobs run in a small thread pool (the conversion toolchain is subprocess- and
C-extension-bound, so threads are fine). Everything is in memory + temp dirs,
sized for a single-instance deployment; a janitor thread evicts anything older
than the TTL.
"""
from __future__ import annotations

import secrets
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .converters import ConversionError, convert_document

JOB_TTL_SECONDS = 15 * 60
SHARE_TTL_SECONDS = 60 * 60
SHARE_MAX_ITEMS = 200
SHARE_MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_WORKERS = 2


@dataclass
class Job:
    id: str
    batch_id: str
    filename: str
    source: str
    target: str
    workdir: Path
    cleanup: frozenset[str] = frozenset()
    pages: str | None = None
    status: str = "queued"  # queued | running | done | error
    progress: int = 0
    message: str = "Waiting in queue"
    result_path: Path | None = None
    download_name: str | None = None
    created: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {
            "id": self.id,
            "batchId": self.batch_id,
            "filename": self.filename,
            "source": self.source,
            "target": self.target,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "downloadName": self.download_name,
        }


class JobManager:
    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._janitor = threading.Thread(target=self._janitor_loop, daemon=True)
        self._janitor.start()

    # -- public API ----------------------------------------------------------
    def submit(
        self,
        *,
        batch_id: str,
        filename: str,
        source: str,
        target: str,
        input_path: Path,
        workdir: Path,
        cleanup: frozenset[str],
        pages: str | None,
    ) -> Job:
        job = Job(
            id=uuid.uuid4().hex,
            batch_id=batch_id,
            filename=filename,
            source=source,
            target=target,
            workdir=workdir,
            cleanup=cleanup,
            pages=pages,
        )
        with self._lock:
            self._jobs[job.id] = job
        self._executor.submit(self._run, job, input_path)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def batch(self, batch_id: str) -> list[Job]:
        with self._lock:
            jobs = [j for j in self._jobs.values() if j.batch_id == batch_id]
        return sorted(jobs, key=lambda j: j.created)

    # -- internals -----------------------------------------------------------
    def _run(self, job: Job, input_path: Path) -> None:
        job.status = "running"
        job.progress = 15
        job.message = "Converting…"
        try:
            stem = Path(job.filename).stem or "converted"
            result = convert_document(
                input_path,
                job.source,
                job.target,
                job.workdir,
                cleanup=job.cleanup,
                pages=job.pages,
                title=stem,
            )
            job.result_path = result
            job.download_name = f"{stem}.{result.suffix.lstrip('.')}"
            job.progress = 100
            job.status = "done"
            job.message = "Ready"
        except ConversionError as exc:
            job.status = "error"
            job.progress = 100
            job.message = str(exc)
        except Exception:  # noqa: BLE001
            job.status = "error"
            job.progress = 100
            job.message = "Conversion failed unexpectedly."

    def _janitor_loop(self) -> None:
        while True:
            time.sleep(60)
            cutoff = time.time() - JOB_TTL_SECONDS
            with self._lock:
                stale = [j for j in self._jobs.values() if j.created < cutoff]
                for job in stale:
                    self._jobs.pop(job.id, None)
            for job in stale:
                shutil.rmtree(job.workdir, ignore_errors=True)
            share_store.evict_expired()


@dataclass
class SharedItem:
    token: str
    data: bytes
    media_type: str
    created: float = field(default_factory=time.time)


class ShareStore:
    """Short-lived, in-memory store for shareable preview outputs."""

    def __init__(self) -> None:
        self._items: dict[str, SharedItem] = {}
        self._lock = threading.Lock()

    def put(self, data: bytes, media_type: str) -> str:
        item = SharedItem(token=secrets.token_urlsafe(12), data=data, media_type=media_type)
        with self._lock:
            self._items[item.token] = item
            self._enforce_limits()
        return item.token

    def get(self, token: str) -> SharedItem | None:
        with self._lock:
            item = self._items.get(token)
            if item and time.time() - item.created > SHARE_TTL_SECONDS:
                self._items.pop(token, None)
                return None
            return item

    def evict_expired(self) -> None:
        cutoff = time.time() - SHARE_TTL_SECONDS
        with self._lock:
            for token in [t for t, i in self._items.items() if i.created < cutoff]:
                self._items.pop(token, None)

    def _enforce_limits(self) -> None:
        # Called with the lock held. Drop oldest items past the caps.
        items = sorted(self._items.values(), key=lambda i: i.created)
        total = sum(len(i.data) for i in items)
        while items and (len(items) > SHARE_MAX_ITEMS or total > SHARE_MAX_TOTAL_BYTES):
            oldest = items.pop(0)
            total -= len(oldest.data)
            self._items.pop(oldest.token, None)


job_manager = JobManager()
share_store = ShareStore()
