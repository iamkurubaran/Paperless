# ---------------------------------------------------------------------------
# Stage 1 — build the React client
# ---------------------------------------------------------------------------
FROM node:20-alpine AS client-build
WORKDIR /build
COPY client/package.json client/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — Python API + conversion toolchain
# ---------------------------------------------------------------------------
FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

# pandoc            md/html/docx interconversion
# libreoffice-writer docx -> pdf with full layout fidelity
# pango/harfbuzz    WeasyPrint's HTML -> PDF renderer
# libgl1/libglib    pdf2docx (OpenCV) runtime
# tesseract/ghostscript  OCR for scanned PDFs (ocrmypdf)
# fonts             consistent text rendering in PDFs
RUN apt-get update && apt-get install -y --no-install-recommends \
        pandoc \
        tesseract-ocr \
        tesseract-ocr-eng \
        ghostscript \
        libreoffice-writer \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libharfbuzz0b \
        libharfbuzz-subset0 \
        libffi8 \
        libgl1 \
        libglib2.0-0 \
        fonts-dejavu \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server/app ./app
COPY --from=client-build /build/dist ./static

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
