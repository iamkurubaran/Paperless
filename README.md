# paperless.

Convert documents without losing a thing. Markdown, Word, PDF, or HTML in — any of the other three out, with formatting, tables, and images preserved.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://python.org)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-339933.svg)](https://nodejs.org)
[![Docker ready](https://img.shields.io/badge/docker-ready-2496ED.svg)](https://www.docker.com)
[![Support @iamkurubaran on Chai4Me](https://chai4.me/badge.svg)](https://chai4.me/iamkurubaran)

## Live demo

- https://gopaperless.onrender.com/

## Overview

Paperless is a document conversion platform that preserves layout and structure across Markdown, Word, PDF, and HTML formats. The app uses a strong toolchain for each conversion path so the output stays faithful to the source.

## Supported conversions

| From | To |
| --- | --- |
| Markdown (`.md`) | Word, PDF, HTML |
| Word (`.docx`) | Markdown, PDF, HTML |
| PDF (`.pdf`) | Word, Markdown, HTML |
| HTML (`.html`) | Markdown, Word, PDF |

## Stack

- Frontend: React 18 + TypeScript + Vite + Tailwind + shadcn/ui
- Backend: Python FastAPI
- Deployment: Docker + Render

## Running locally

### Docker (recommended)

```bash
docker compose up --build
# open http://localhost:8000
```

### Development mode

Server (Python 3.11+, plus `pandoc` and `libreoffice-writer` on your PATH):

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Client (Node.js 18+):

```bash
cd client
npm install
npm run dev
# open http://localhost:5173
```

## API highlights

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/convert` | Convert an uploaded file to a new format |
| `GET` | `/api/formats` | Supported conversion matrix and limits |
| `GET` | `/api/health` | Liveness probe |

## Developer notes

- Uploads are capped at 50 MB.
- Batch conversion, OCR, diff views, and API key support are available in the current experience.
- The UI offers a live preview, in-browser editing, and cleanup options for markdown and HTML content.

## Deployment

Render reads the included blueprint and deploys the Docker image automatically. For heavier conversions, use a plan with more RAM than the free tier.

## Contributing

Contributions are welcome. If you would like to help improve conversion quality, add new formats, or improve the developer experience, open an issue or submit a pull request.

## License

MIT © Kurubaran Anandhan
