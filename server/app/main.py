"""Paperless — document conversion API.

Routes
------
GET  /api/health                    liveness probe (no auth, no rate limit)
GET  /api/formats                   supported conversion matrix + options
POST /api/convert                   synchronous convert -> download or preview
POST /api/batch                     multi-file async batch -> job ids
GET  /api/batch/{batch_id}          batch job statuses
GET  /api/batch/{batch_id}/download zip of all finished results
GET  /api/jobs/{job_id}             single job status + progress
GET  /api/jobs/{job_id}/result      converted file for a finished job
POST /api/share                     store a preview -> short-lived share URL
GET  /s/{token}                     public share view (no API key needed)
POST /api/pdf/info                  page count of an uploaded PDF
GET  /docs, /openapi.json           interactive public API documentation
GET  /                              serves the built React client

Auth: set PAPERLESS_API_KEYS to require X-API-Key on /api/*. Rate limiting via
PAPERLESS_RATE_LIMIT (requests/minute, default 120). See app/security.py.
"""
from __future__ import annotations

import io
import logging
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .converters import (
    CLEANUP_KEYS,
    CONVERSION_MATRIX,
    ConversionError,
    MEDIA_TYPES,
    convert_document,
    dependency_status,
    docx_to_preview_html,
    markdown_from_zip,
    normalize_format,
    parse_cleanup,
    pdf_page_count,
)
from .jobs import SHARE_TTL_SECONDS, job_manager, share_store
from .security import API_KEYS, RATE_LIMIT_PER_MINUTE, security_middleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("paperless")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_BATCH_FILES = 20

app = FastAPI(
    title="Paperless API",
    version="2.0.0",
    description=(
        "Convert Markdown, Word, PDF and HTML documents. "
        "Set the X-API-Key header if this instance has keys configured."
    ),
)

app.middleware("http")(security_middleware)

_missing_tools = sorted(name for name, ok in dependency_status().items() if not ok)
if _missing_tools:
    logger.warning(
        "Missing external tools: %s. Conversions that need them will return "
        "a 422 with install instructions.",
        ", ".join(_missing_tools),
    )

# CORS is only needed when the Vite dev server (5173) talks to the API (8000).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "Content-Disposition",
        "X-Conversion",
        "X-Preview-Rendition",
        "X-Media-Note",
    ],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _cleanup_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


async def _save_upload(file: UploadFile, dest: Path) -> None:
    size = 0
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "File exceeds the 50 MB upload limit.")
            out.write(chunk)
    if size == 0:
        raise HTTPException(400, "The uploaded file is empty.")


def _validate_route(filename: str | None, target_raw: str) -> tuple[str, str]:
    original_name = filename or "document"
    suffix = Path(original_name).suffix.lower().lstrip(".")
    source = normalize_format(suffix)
    target = normalize_format(target_raw)
    if source is None:
        raise HTTPException(400, f"Unsupported source file type: .{suffix or '?'}")
    if target is None:
        raise HTTPException(400, "Unsupported target format.")
    if source == target:
        raise HTTPException(400, "Source and target formats are the same.")
    if target not in CONVERSION_MATRIX.get(source, set()):
        raise HTTPException(400, f"Conversion {source} → {target} is not supported.")
    return source, target


def _merge_cleanup(cleanup: str, emdash: str) -> frozenset[str]:
    opts = set(parse_cleanup(cleanup))
    if emdash.strip().lower() in {"1", "true", "yes", "on"}:
        opts.add("emdash")
    return frozenset(opts)


# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "tools": dependency_status()}


@app.get("/api/formats")
def formats() -> dict:
    return {
        "matrix": {src: sorted(targets) for src, targets in CONVERSION_MATRIX.items()},
        "cleanupOptions": sorted(CLEANUP_KEYS),
        "maxUploadBytes": MAX_UPLOAD_BYTES,
        "maxBatchFiles": MAX_BATCH_FILES,
        "apiKeyRequired": bool(API_KEYS),
        "rateLimitPerMinute": RATE_LIMIT_PER_MINUTE,
    }


# ---------------------------------------------------------------------------
# Synchronous convert (single file, preview or download)
# ---------------------------------------------------------------------------
@app.post("/api/convert")
async def convert(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    target: str = Form(...),
    mode: str = Form("download"),
    emdash: str = Form("0"),
    cleanup: str = Form(""),
    pages: str = Form(""),
) -> Response:
    source, target = _validate_route(file.filename, target)
    preview = mode.strip().lower() == "preview"
    opts = _merge_cleanup(cleanup, emdash)

    workdir = Path(tempfile.mkdtemp(prefix="paperless-"))
    try:
        input_path = workdir / f"input.{source}"
        await _save_upload(file, input_path)

        stem = Path(file.filename or "document").stem or "document"
        result_path = convert_document(
            input_path, source, target, workdir,
            cleanup=opts, pages=pages or None, title=stem,
        )

        if preview:
            response = _preview_response(result_path, target, workdir)
            _cleanup_dir(workdir)
            return response

        stem = Path(file.filename or "document").stem or "converted"
        out_ext = result_path.suffix.lstrip(".")
        background.add_task(_cleanup_dir, workdir)
        return FileResponse(
            path=result_path,
            filename=f"{stem}.{out_ext}",
            media_type=MEDIA_TYPES.get(out_ext, "application/octet-stream"),
            headers={"X-Conversion": f"{source}->{target}"},
        )
    except HTTPException:
        _cleanup_dir(workdir)
        raise
    except ConversionError as exc:
        _cleanup_dir(workdir)
        logger.exception("Conversion failed")
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        _cleanup_dir(workdir)
        logger.exception("Unexpected conversion error")
        raise HTTPException(500, "Conversion failed unexpectedly. Please try again.") from exc


def _preview_response(result_path: Path, target: str, workdir: Path) -> Response:
    """Build an in-memory response the client can render on screen."""
    headers: dict[str, str] = {}
    if target == "md":
        if result_path.suffix == ".zip":
            text = markdown_from_zip(result_path)
            headers["X-Media-Note"] = "1"
        else:
            text = result_path.read_text(encoding="utf-8", errors="replace")
        return Response(text, media_type="text/markdown; charset=utf-8", headers=headers)
    if target == "html":
        html = result_path.read_text(encoding="utf-8", errors="replace")
        return Response(html, media_type="text/html; charset=utf-8")
    if target == "pdf":
        return Response(
            result_path.read_bytes(),
            media_type="application/pdf",
            headers={"Content-Disposition": "inline; filename=preview.pdf"},
        )
    # docx -> HTML rendition for on-screen display
    rendition = docx_to_preview_html(result_path, workdir)
    return Response(
        rendition.read_text(encoding="utf-8", errors="replace"),
        media_type="text/html; charset=utf-8",
        headers={"X-Preview-Rendition": "html"},
    )


# ---------------------------------------------------------------------------
# Async batch jobs
# ---------------------------------------------------------------------------
@app.post("/api/batch")
async def create_batch(
    files: list[UploadFile] = File(...),
    target: str = Form(...),
    emdash: str = Form("0"),
    cleanup: str = Form(""),
) -> dict:
    if not files:
        raise HTTPException(400, "No files uploaded.")
    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(400, f"A batch can contain at most {MAX_BATCH_FILES} files.")

    opts = _merge_cleanup(cleanup, emdash)
    batch_id = uuid.uuid4().hex
    jobs = []
    for upload in files:
        source, tgt = _validate_route(upload.filename, target)
        workdir = Path(tempfile.mkdtemp(prefix="paperless-job-"))
        try:
            input_path = workdir / f"input.{source}"
            await _save_upload(upload, input_path)
        except HTTPException:
            _cleanup_dir(workdir)
            raise
        job = job_manager.submit(
            batch_id=batch_id,
            filename=upload.filename or "document",
            source=source,
            target=tgt,
            input_path=input_path,
            workdir=workdir,
            cleanup=opts,
            pages=None,
        )
        jobs.append(job.public())
    return {"batchId": batch_id, "jobs": jobs}


@app.get("/api/batch/{batch_id}")
def batch_status(batch_id: str) -> dict:
    jobs = job_manager.batch(batch_id)
    if not jobs:
        raise HTTPException(404, "Batch not found (results expire after 15 minutes).")
    return {"batchId": batch_id, "jobs": [j.public() for j in jobs]}


@app.get("/api/batch/{batch_id}/download")
def batch_download(batch_id: str) -> Response:
    jobs = [j for j in job_manager.batch(batch_id) if j.status == "done" and j.result_path]
    if not jobs:
        raise HTTPException(404, "No finished files in this batch yet.")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        used: set[str] = set()
        for job in jobs:
            name = job.download_name or job.result_path.name  # type: ignore[union-attr]
            base, dot, ext = name.rpartition(".")
            counter = 1
            while name in used:
                counter += 1
                name = f"{base or ext}-{counter}{dot}{ext if base else ''}"
            used.add(name)
            zf.write(job.result_path, name)  # type: ignore[arg-type]
    return Response(
        buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="paperless-batch.zip"'},
    )


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found (results expire after 15 minutes).")
    return job.public()


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str) -> FileResponse:
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found (results expire after 15 minutes).")
    if job.status == "error":
        raise HTTPException(422, job.message)
    if job.status != "done" or job.result_path is None:
        raise HTTPException(409, "Job is still running.")
    ext = job.result_path.suffix.lstrip(".")
    return FileResponse(
        path=job.result_path,
        filename=job.download_name or f"converted.{ext}",
        media_type=MEDIA_TYPES.get(ext, "application/octet-stream"),
    )


# ---------------------------------------------------------------------------
# Share links (preview outputs, expire after 1 hour)
# ---------------------------------------------------------------------------
@app.post("/api/share")
async def create_share(
    file: UploadFile = File(...),
    target: str = Form(...),
    emdash: str = Form("0"),
    cleanup: str = Form(""),
    pages: str = Form(""),
) -> dict:
    source, target = _validate_route(file.filename, target)
    opts = _merge_cleanup(cleanup, emdash)

    workdir = Path(tempfile.mkdtemp(prefix="paperless-share-"))
    try:
        input_path = workdir / f"input.{source}"
        await _save_upload(file, input_path)
        stem = Path(file.filename or "document").stem or "document"
        result_path = convert_document(
            input_path, source, target, workdir,
            cleanup=opts, pages=pages or None, title=stem,
        )
        if target == "md":
            text = (
                markdown_from_zip(result_path)
                if result_path.suffix == ".zip"
                else result_path.read_text(encoding="utf-8", errors="replace")
            )
            token = share_store.put(text.encode("utf-8"), "text/plain; charset=utf-8")
        elif target == "pdf":
            token = share_store.put(result_path.read_bytes(), "application/pdf")
        else:
            html_path = (
                docx_to_preview_html(result_path, workdir)
                if target == "docx"
                else result_path
            )
            token = share_store.put(
                html_path.read_bytes(), "text/html; charset=utf-8"
            )
        return {"url": f"/s/{token}", "expiresInSeconds": SHARE_TTL_SECONDS}
    except ConversionError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        _cleanup_dir(workdir)


@app.get("/s/{token}")
def view_share(token: str) -> Response:
    item = share_store.get(token)
    if item is None:
        raise HTTPException(404, "This share link has expired or does not exist.")
    return Response(
        item.data,
        media_type=item.media_type,
        headers={"Content-Disposition": "inline"},
    )


# ---------------------------------------------------------------------------
# PDF utilities
# ---------------------------------------------------------------------------
@app.post("/api/pdf/info")
async def pdf_info(file: UploadFile = File(...)) -> dict:
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Upload a PDF to inspect.")
    workdir = Path(tempfile.mkdtemp(prefix="paperless-info-"))
    try:
        pdf_path = workdir / "input.pdf"
        await _save_upload(file, pdf_path)
        try:
            return {"pages": pdf_page_count(pdf_path)}
        except ConversionError as exc:
            raise HTTPException(422, str(exc)) from exc
    finally:
        _cleanup_dir(workdir)


@app.exception_handler(ConversionError)
def conversion_error_handler(_, exc: ConversionError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": str(exc)})


# ---------------------------------------------------------------------------
# Static client (production build). Mounted last so API routes keep priority.
# ---------------------------------------------------------------------------
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="client")
