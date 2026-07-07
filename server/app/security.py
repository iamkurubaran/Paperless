"""API keys and rate limiting for Paperless.

Configuration (environment variables):
  PAPERLESS_API_KEYS    Comma-separated list of accepted keys. When set, every
                        /api/* route except /api/health requires a matching
                        X-API-Key header (the web UI prompts for it once).
                        When unset (default), the API is open.
  PAPERLESS_RATE_LIMIT  Requests per minute per key (or per client IP when no
                        keys are configured). Default 120. Set 0 to disable.
"""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque

from fastapi import Request
from fastapi.responses import JSONResponse

API_KEYS: frozenset[str] = frozenset(
    key.strip() for key in os.environ.get("PAPERLESS_API_KEYS", "").split(",") if key.strip()
)
RATE_LIMIT_PER_MINUTE: int = int(os.environ.get("PAPERLESS_RATE_LIMIT", "120"))

_EXEMPT_PATHS = {"/api/health"}
_WINDOW_SECONDS = 60.0


class SlidingWindowLimiter:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        if self.limit <= 0:
            return True
        now = time.time()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > _WINDOW_SECONDS:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True


limiter = SlidingWindowLimiter(RATE_LIMIT_PER_MINUTE)


def client_identity(request: Request) -> str:
    key = request.headers.get("x-api-key")
    if key:
        return f"key:{key}"
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() if forwarded else (
        request.client.host if request.client else "unknown"
    )
    return f"ip:{ip}"


async def security_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api") and path not in _EXEMPT_PATHS:
        if API_KEYS:
            provided = request.headers.get("x-api-key", "")
            if provided not in API_KEYS:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "A valid X-API-Key header is required."},
                )
        if not limiter.allow(client_identity(request)):
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Try again in a minute."},
                headers={"Retry-After": "60"},
            )
    return await call_next(request)
