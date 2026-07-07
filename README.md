# paperless.

<p align="center">
  <a href="https://github.com/iamkurubaran/Paperless"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT" /></a>
  <a href="https://github.com/iamkurubaran/Paperless"><img src="https://img.shields.io/badge/python-3.11%2B-blue.svg" alt="Python 3.11+" /></a>
  <a href="https://github.com/iamkurubaran/Paperless"><img src="https://img.shields.io/badge/node-18%2B-339933.svg" alt="Node 18+" /></a>
  <a href="https://github.com/iamkurubaran/Paperless"><img src="https://img.shields.io/badge/docker-ready-2496ED.svg" alt="Docker ready" /></a>
</p>

<p align="center">
  <a href="https://chai4.me/iamkurubaran" target="_blank" title="Support iamkurubaran on Chai4Me" style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;background:#ffffff;padding:8px 32px;border-radius:16px;text-decoration:none;border:1px solid #e5e7eb;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -2px rgba(0,0,0,0.05);transition:transform 0.2s;"><img src="https://chai4.me/icons/wordmark.png" alt="Chai4Me" style="height:32px;object-fit:contain;margin-bottom:4px;"/><span style="color:#6b7280;font-family:sans-serif;font-size:14px;font-weight:600;">@iamkurubaran</span></a>
</p>

Convert documents without losing a thing. Markdown, Word, PDF or HTML in — any of the other three out, with formatting, tables and images preserved.

## Conversion routes (12)

| From | To |
|------|----|
| Markdown (`.md`) | Word, PDF, HTML |
| Word (`.docx`) | Markdown, PDF, HTML |
| PDF (`.pdf`) | Word, Markdown, HTML |
| HTML (`.html`) | Markdown, Word, PDF |

**How formatting is preserved.** Each route uses the strongest tool for the job rather than one generic pipeline: Pandoc (GFM) for Markdown/HTML/Word interconversion, LibreOffice headless for Word → PDF (full layout fidelity), WeasyPrint for Markdown/HTML → PDF, `pdf2docx` for PDF → Word layout reconstruction, and `pymupdf4llm` for structure-aware PDF → Markdown. HTML output is always a single self-contained file with images embedded as data URIs. If a Markdown conversion extracts images, the result arrives as a `.zip` containing the `.md` plus a `media/` folder so links keep working.

## Stack

- **Client:** React 18 + TypeScript + Vite + Tailwind + shadcn/ui (`client/`)
- **Server:** Python FastAPI (`server/`), which also serves the built client in production
- **Deploy:** single Docker image, Render blueprint at the root (`render.yaml`)

## Run locally with Docker (recommended)

```bash
docker compose up --build
# open http://localhost:8000
```

## Run locally for development

Server (needs Python 3.11+, plus `pandoc` and `libreoffice-writer` on your PATH):

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Client (needs Node 18+):

```bash
cd client
npm install
npm run dev
# open http://localhost:5173 — /api requests proxy to :8000
```

## Deploy to Render

1. Push this repository to GitHub/GitLab.
2. In Render: **New + → Blueprint**, select the repo. Render reads `render.yaml`, builds the root Dockerfile and deploys.
   (Or **New + → Web Service** with runtime **Docker** — same result.)
3. Use the **Starter** plan or higher: LibreOffice and WeasyPrint need more than the free tier's 512 MB of RAM.

The container binds to Render's `PORT` automatically and exposes `/api/health` for health checks.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/convert` | multipart form: `file`, `target` (`md`\|`docx`\|`pdf`\|`html`), `mode` (`download`\|`preview`), `emdash` (`0`\|`1`) → converted file or inline preview |
| `GET` | `/api/formats` | supported conversion matrix + upload limit |
| `GET` | `/api/health` | liveness probe |

Uploads are capped at 50 MB, processed in a per-request temp directory, and deleted immediately after the response is sent.

## Live preview, editing and em-dash cleanup

- **Live preview:** once a file and target are selected, the complete converted document renders beside the source and refreshes automatically. HTML and PDF targets preview natively; Markdown previews as the exact output text; Word targets preview as an HTML rendition (the download is the exact `.docx`).
- **In-browser editing:** Markdown and HTML sources open in an editor — the preview follows your edits (debounced ~0.7 s), and the download always uses the edited content.
- **Em-dash option:** a toggle replaces every em dash (`—`, plus `&mdash;`/`&#8212;` in HTML) with a hyphen (`-`) in the converted output. Applied server-side before conversion for text/Word sources and after conversion for PDF sources, so the preview and the downloaded file always match.
- **Markdown preview mode:** a separate "Preview Markdown" tab with a live editor and rendered view — type or open a `.md` file and read it as a document. View-only by design: no convert or download actions. Rendering goes through the same server pipeline as conversions, so it's a faithful representation.

## v2.0 features

- **Batch conversion:** up to 20 mixed-format files at once, converted through an in-process async job queue with per-file progress, individual downloads, and a combined `.zip`. Batch results expire after 15 minutes.
- **OCR for scanned PDFs:** PDFs with no text layer are detected automatically and OCR'd (Tesseract via `ocrmypdf`) before conversion, so scanned documents convert instead of failing.
- **Copy & share:** copy the converted Markdown/HTML straight from the preview pane, or create a share link (`/s/{token}`) that renders the preview for anyone — links expire after one hour and require no API key to view.
- **PDF page ranges:** convert only the pages you need (`1-5, 8`); the page count shows automatically after upload and the live preview reflects the selection.
- **Cleanup options:** beyond em dashes → hyphens, opt into smart quotes → straight, collapsing double spaces (word-internal only, so code indentation survives), trimming trailing whitespace, and CRLF → LF normalization. Applied identically to preview and download.
- **Diff view:** edited Markdown/HTML sources get a "Changes" toggle showing a line-level diff (added/removed) against the original before you convert.
- **Async jobs API:** `POST /api/batch` → `GET /api/jobs/{id}` (status + progress) → `GET /api/jobs/{id}/result`, plus `GET /api/batch/{id}/download` for a zip. Runs in a small worker pool so large conversions don't block or time out the request path.
- **API keys & rate limiting:** set `PAPERLESS_API_KEYS` (comma-separated) to require an `X-API-Key` header on all `/api/*` routes — the web UI has a key field behind the key icon in the header. `PAPERLESS_RATE_LIMIT` caps requests per minute per key/IP (default 120, `0` disables). Interactive API docs live at `/docs`.
- **Dark mode:** toggle in the header; follows your system preference on first visit and remembers your choice.
