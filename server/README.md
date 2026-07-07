# Server Setup Guide

This directory contains the FastAPI backend for Paperless.

## Requirements

- Python 3.11 or newer
- pip and virtualenv
- System dependencies for document conversion:
  - `pandoc`
  - `libreoffice-writer`
  - `weasyprint`-compatible system libraries

## Recommended setup

Create and activate a virtual environment:

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
```

Install Python dependencies:

```bash
pip install -r requirements.txt
```

## Run the development server

```bash
uvicorn app.main:app --reload --port 8000
```

The API will be available at:

- http://localhost:8000
- API docs: http://localhost:8000/docs

## Important notes

- The backend exposes conversion endpoints under `/api`.
- The server also serves the built frontend in production.
- Conversion features depend on external document processing tools and libraries.

## Useful commands

```bash
python -m compileall app
```

## Troubleshooting

- If `pandoc` or LibreOffice is missing, conversions will fail or behave unexpectedly.
- If dependencies fail to install, make sure your Python version is 3.11+.
- If the server does not start, verify that the virtual environment is active and that required system packages are installed.
