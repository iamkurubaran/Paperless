"""Conversion engine for Paperless.

Formatting-preservation strategy per route
------------------------------------------
md   -> docx : pandoc (gfm reader keeps tables, task lists, strikethrough)
md   -> html : pandoc standalone + embedded resources + print stylesheet
md   -> pdf  : pandoc -> styled HTML -> WeasyPrint (keeps tables, code, images)
docx -> md   : pandoc gfm writer, media extracted and zipped alongside if present
docx -> html : pandoc standalone, images embedded as data URIs (single file)
docx -> pdf  : LibreOffice headless (highest layout fidelity for Word files)
pdf  -> docx : pdf2docx (rebuilds paragraphs, tables, images, layout)
pdf  -> md   : pymupdf4llm (structure-aware: headings, tables, images)
pdf  -> html : pdf2docx -> pandoc html with embedded images
html -> md   : pandoc gfm writer
html -> docx : pandoc docx writer (downloads/embeds referenced local media)
html -> pdf  : WeasyPrint directly on the HTML (honors the page's own CSS)
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path


class ConversionError(Exception):
    """Raised when a document cannot be converted."""


# ---------------------------------------------------------------------------
# External tools
# ---------------------------------------------------------------------------
# Directories searched in addition to PATH: the server may run under a
# process manager with a trimmed PATH, and LibreOffice on macOS does not add
# itself to PATH at all.
_EXTRA_TOOL_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/LibreOffice.app/Contents/MacOS",
    "/usr/lib/libreoffice/program",
)

_TOOL_HINTS = {
    "pandoc": "brew install pandoc (macOS) or apt-get install pandoc (Debian/Ubuntu)",
    "soffice": "brew install --cask libreoffice (macOS) or apt-get install libreoffice (Debian/Ubuntu)",
    "ocrmypdf": "brew install ocrmypdf (macOS) or apt-get install ocrmypdf (Debian/Ubuntu)",
}


def find_tool(name: str) -> str | None:
    """Resolve an external binary via PATH, then well-known install locations."""
    found = shutil.which(name)
    if found:
        return found
    for directory in _EXTRA_TOOL_DIRS:
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _require_tool(name: str) -> str:
    path = find_tool(name)
    if path is None:
        hint = _TOOL_HINTS.get(name)
        raise ConversionError(
            f"This conversion needs '{name}', which is not installed on the server"
            + (f" — install it with: {hint}" if hint else ".")
        )
    return path


def dependency_status() -> dict[str, bool]:
    """Availability of the external binaries the conversion routes rely on."""
    return {name: find_tool(name) is not None for name in _TOOL_HINTS}


_dylib_search_patched = False


def _patch_dylib_search() -> None:
    """On macOS, let cffi find Homebrew dylibs (pango, gobject, …).

    dyld only honours DYLD_FALLBACK_LIBRARY_PATH captured at process start,
    so WeasyPrint's bare-name dlopens miss /opt/homebrew/lib. cffi falls back
    to ctypes.util.find_library, which we extend to search there.
    """
    global _dylib_search_patched
    if _dylib_search_patched or sys.platform != "darwin":
        return
    _dylib_search_patched = True

    import ctypes.util

    original = ctypes.util.find_library

    def find_library(name: str) -> str | None:
        found = original(name)
        if found:
            return found
        for directory in ("/opt/homebrew/lib", "/usr/local/lib"):
            for candidate in (name, f"{name}.dylib", f"lib{name}.dylib"):
                path = Path(directory) / candidate
                if path.is_file():
                    return str(path)
        return None

    ctypes.util.find_library = find_library


# ---------------------------------------------------------------------------
# Supported formats
# ---------------------------------------------------------------------------
FORMAT_ALIASES = {
    "md": "md",
    "markdown": "md",
    "mdown": "md",
    "docx": "docx",
    "doc": "docx",
    "pdf": "pdf",
    "html": "html",
    "htm": "html",
}

CONVERSION_MATRIX: dict[str, set[str]] = {
    "md": {"docx", "pdf", "html"},
    "docx": {"md", "pdf", "html"},
    "pdf": {"docx", "md", "html"},
    "html": {"md", "docx", "pdf"},
}

MEDIA_TYPES = {
    "md": "text/markdown",
    "html": "text/html",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "zip": "application/zip",
}

# Pandoc reader/writer names. gfm keeps GitHub-style tables, task lists,
# strikethrough and autolinks intact in both directions.
PANDOC_MD = "gfm+footnotes+definition_lists"

# Print stylesheet used for HTML output and for HTML that feeds WeasyPrint.
PRINT_CSS = """
@page { size: A4; margin: 22mm 20mm; }
:root { color-scheme: light; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: "DejaVu Serif", Georgia, "Times New Roman", serif;
  font-size: 11.5pt; line-height: 1.55; color: #1a1a1a;
  max-width: 46em; margin: 0 auto; padding: 0 1em;
}
h1, h2, h3, h4, h5, h6 {
  font-family: "DejaVu Sans", "Helvetica Neue", Arial, sans-serif;
  line-height: 1.25; margin: 1.4em 0 0.5em; page-break-after: avoid;
}
h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.22em; }
p { margin: 0.65em 0; orphans: 3; widows: 3; }
a { color: #1d4ed8; text-decoration: none; }
img { max-width: 100%; height: auto; page-break-inside: avoid; }
figure { margin: 1em 0; }
blockquote {
  margin: 1em 0; padding: 0.2em 1em; color: #444;
  border-left: 3px solid #cbd5e1;
}
code, pre, kbd {
  font-family: "DejaVu Sans Mono", "Courier New", monospace; font-size: 0.92em;
}
code { background: #f3f4f6; padding: 0.1em 0.35em; border-radius: 3px; }
pre {
  background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
  padding: 0.9em 1.1em; overflow-x: auto; white-space: pre-wrap;
  word-wrap: break-word; page-break-inside: avoid;
}
pre code { background: none; padding: 0; }
table {
  border-collapse: collapse; width: 100%; margin: 1em 0;
  page-break-inside: avoid; font-size: 0.95em;
}
th, td { border: 1px solid #cbd5e1; padding: 0.45em 0.7em; text-align: left; }
th { background: #f1f5f9; font-family: "DejaVu Sans", Arial, sans-serif; }
tr:nth-child(even) td { background: #fafafa; }
hr { border: 0; border-top: 1px solid #d1d5db; margin: 2em 0; }
ul, ol { padding-left: 1.6em; }
li { margin: 0.25em 0; }
input[type="checkbox"] { margin-right: 0.4em; }
"""


# ---------------------------------------------------------------------------
# Text cleanup (em dashes, smart quotes, spacing, line endings)
# ---------------------------------------------------------------------------
EMDASH = "\u2014"
EMDASH_HTML_ENTITIES = ("&mdash;", "&#8212;", "&#x2014;", "&#X2014;")

# Cleanup option keys accepted from the API.
CLEANUP_KEYS = frozenset({"emdash", "quotes", "spaces", "trailing", "newlines"})

_SMART_QUOTES = {
    "\u201c": '"', "\u201d": '"', "\u201e": '"',  # “ ” „
    "\u2018": "'", "\u2019": "'", "\u201a": "'",  # ‘ ’ ‚
}
_SMART_QUOTE_ENTITIES = {
    "&ldquo;": '"', "&rdquo;": '"', "&#8220;": '"', "&#8221;": '"',
    "&lsquo;": "'", "&rsquo;": "'", "&#8216;": "'", "&#8217;": "'",
}
_MULTI_SPACE_RE = re.compile(r"(?<=\S) {2,}(?=\S)")
_TRAILING_WS_RE = re.compile(r"[ \t]+$", re.MULTILINE)


def parse_cleanup(value: str | None) -> frozenset[str]:
    if not value:
        return frozenset()
    opts = {part.strip().lower() for part in value.split(",") if part.strip()}
    return frozenset(opts & CLEANUP_KEYS)


def apply_cleanup_text(text: str, opts: frozenset[str], html_entities: bool = False) -> str:
    if "newlines" in opts:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    if "emdash" in opts:
        text = text.replace(EMDASH, "-")
        if html_entities:
            for entity in EMDASH_HTML_ENTITIES:
                text = text.replace(entity, "-")
    if "quotes" in opts:
        for smart, plain in _SMART_QUOTES.items():
            text = text.replace(smart, plain)
        if html_entities:
            for entity, plain in _SMART_QUOTE_ENTITIES.items():
                text = text.replace(entity, plain)
    if "spaces" in opts:
        # Collapse runs of spaces between words only — leading indentation
        # (markdown code blocks) is left untouched.
        text = _MULTI_SPACE_RE.sub(" ", text)
    if "trailing" in opts:
        text = _TRAILING_WS_RE.sub("", text)
    return text


def apply_cleanup_text_file(path: Path, opts: frozenset[str], html_entities: bool = False) -> None:
    if not opts:
        return
    text = path.read_text(encoding="utf-8", errors="replace")
    path.write_text(apply_cleanup_text(text, opts, html_entities), encoding="utf-8")


def apply_cleanup_docx(path: Path, opts: frozenset[str]) -> None:
    """Rewrite XML parts of a .docx. Only character-level substitutions
    (em dashes, smart quotes) are safe inside raw XML; whitespace rules are
    skipped because Word XML uses significant whitespace (xml:space)."""
    subs: list[tuple[bytes, bytes]] = []
    if "emdash" in opts:
        subs += [(EMDASH.encode(), b"-"), (b"&#8212;", b"-"), (b"&#x2014;", b"-")]
    if "quotes" in opts:
        subs += [(k.encode(), v.encode()) for k, v in _SMART_QUOTES.items()]
    if not subs:
        return
    tmp = path.with_name(path.stem + ".clean.docx")
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(
        tmp, "w", zipfile.ZIP_DEFLATED
    ) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename.endswith(".xml"):
                for old, new in subs:
                    data = data.replace(old, new)
            zout.writestr(item, data)
    tmp.replace(path)


# ---------------------------------------------------------------------------
# PDF helpers: page ranges and OCR for scanned documents
# ---------------------------------------------------------------------------
_PAGE_SPEC_RE = re.compile(r"^\s*\d+\s*(-\s*\d+\s*)?(,\s*\d+\s*(-\s*\d+\s*)?)*$")


def parse_page_range(spec: str, total: int) -> list[int]:
    """Parse '1-3, 7' into sorted, unique 0-based page indices."""
    spec = spec.strip()
    if not spec:
        return list(range(total))
    if not _PAGE_SPEC_RE.match(spec):
        raise ConversionError(
            "Invalid page range. Use a format like '1-5, 8' (pages start at 1)."
        )
    pages: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = (int(x) for x in part.split("-"))
        else:
            a = b = int(part)
        if a < 1 or b < a:
            raise ConversionError(f"Invalid page range segment: '{part}'.")
        if a > total:
            raise ConversionError(
                f"Page {a} is out of range — the document has {total} page(s)."
            )
        pages.update(range(a - 1, min(b, total)))
    return sorted(pages)


def pdf_page_count(path: Path) -> int:
    try:
        import fitz  # PyMuPDF
    except Exception as exc:  # pragma: no cover
        raise ConversionError("PDF engine is not available on the server.") from exc
    with fitz.open(str(path)) as doc:
        return doc.page_count


def trim_pdf_pages(src: Path, spec: str, workdir: Path) -> Path:
    try:
        import fitz
    except Exception as exc:  # pragma: no cover
        raise ConversionError("PDF engine is not available on the server.") from exc
    with fitz.open(str(src)) as doc:
        indices = parse_page_range(spec, doc.page_count)
        if len(indices) == doc.page_count:
            return src
        doc.select(indices)
        out = workdir / "input.pages.pdf"
        doc.save(str(out))
    return out


def pdf_has_text_layer(path: Path) -> bool:
    try:
        import fitz
    except Exception:  # pragma: no cover
        return True  # let downstream engines report their own errors
    with fitz.open(str(path)) as doc:
        return any(page.get_text().strip() for page in doc)


def ensure_pdf_text_layer(src: Path, workdir: Path) -> Path:
    """If the PDF has no extractable text (scanned images), OCR it first."""
    if pdf_has_text_layer(src):
        return src
    ocrmypdf = find_tool("ocrmypdf")
    if ocrmypdf is None:
        raise ConversionError(
            "This PDF looks scanned (no text layer) and OCR is not available "
            "on this server."
        )
    out = workdir / "input.ocr.pdf"
    _run(
        [
            ocrmypdf, "--skip-text", "--output-type", "pdf",
            "--optimize", "0", "--quiet", str(src), str(out),
        ],
        cwd=workdir,
        step="OCR (scanned PDF)",
        timeout=600,
    )
    if not out.exists() or out.stat().st_size == 0:
        raise ConversionError("OCR produced no output for this scanned PDF.")
    return out


def normalize_format(value: str | None) -> str | None:
    if not value:
        return None
    return FORMAT_ALIASES.get(value.strip().lower().lstrip("."))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _run(cmd: list[str], cwd: Path, step: str, timeout: int = 180) -> None:
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired as exc:
        raise ConversionError(f"{step} timed out.") from exc
    except FileNotFoundError as exc:
        tool = Path(cmd[0]).name
        hint = _TOOL_HINTS.get(tool)
        raise ConversionError(
            f"{step} failed: '{tool}' is not installed on the server"
            + (f" — install it with: {hint}" if hint else ".")
        ) from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:400]
        raise ConversionError(f"{step} failed. {detail}")


def _pandoc(
    src: Path,
    to: str,
    out: Path,
    *,
    from_fmt: str,
    cwd: Path,
    extra: list[str] | None = None,
) -> None:
    cmd = [
        _require_tool("pandoc"),
        "--from", from_fmt,
        "--to", to,
        "--output", str(out),
        *(extra or []),
        str(src),
    ]
    _run(cmd, cwd=cwd, step="Pandoc conversion")
    if not out.exists() or out.stat().st_size == 0:
        raise ConversionError("Pandoc produced no output.")


def _write_css(workdir: Path) -> Path:
    css = workdir / "print.css"
    css.write_text(PRINT_CSS, encoding="utf-8")
    return css


def _html_to_pdf(html_path: Path, out: Path, base_dir: Path, with_default_css: bool) -> None:
    """Render HTML to PDF with WeasyPrint (imported lazily: heavy native deps)."""
    _patch_dylib_search()
    try:
        from weasyprint import CSS, HTML
    except Exception as exc:  # pragma: no cover
        raise ConversionError(
            "PDF renderer (WeasyPrint) is not available — its native libraries "
            "are missing. Install them with: brew install pango (macOS) or "
            "apt-get install libpango-1.0-0 libpangocairo-1.0-0 (Debian/Ubuntu)."
        ) from exc
    try:
        stylesheets = [CSS(string=PRINT_CSS)] if with_default_css else [
            CSS(string='@page { size: A4; margin: 18mm 16mm; } img { max-width: 100%; }')
        ]
        HTML(filename=str(html_path), base_url=str(base_dir)).write_pdf(
            str(out), stylesheets=stylesheets
        )
    except ConversionError:
        raise
    except Exception as exc:
        raise ConversionError(f"PDF rendering failed: {str(exc)[:400]}") from exc
    if not out.exists() or out.stat().st_size == 0:
        raise ConversionError("PDF rendering produced no output.")


def _docx_to_pdf_libreoffice(src: Path, workdir: Path) -> Path:
    profile = workdir / "lo-profile"
    _run(
        [
            _require_tool("soffice"), "--headless", "--norestore",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to", "pdf:writer_pdf_Export",
            "--outdir", str(workdir), str(src),
        ],
        cwd=workdir,
        step="Word → PDF rendering",
        timeout=240,
    )
    out = workdir / (src.stem + ".pdf")
    if not out.exists():
        candidates = list(workdir.glob("*.pdf"))
        if not candidates:
            raise ConversionError("LibreOffice did not produce a PDF.")
        out = candidates[0]
    return out


def _zip_with_media(primary: Path, media_dir: Path, out_zip: Path) -> Path:
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(primary, primary.name)
        for f in sorted(media_dir.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(media_dir.parent))
    return out_zip


def _media_files(media_dir: Path) -> list[Path]:
    return [f for f in media_dir.rglob("*") if f.is_file()] if media_dir.exists() else []


# ---------------------------------------------------------------------------
# Route implementations
# ---------------------------------------------------------------------------
def _to_html_standalone(
    src: Path, from_fmt: str, workdir: Path, extract_media: bool, title: str | None = None
) -> Path:
    """Produce a single, self-contained HTML file (images inlined as data URIs)."""
    css = _write_css(workdir)
    out = workdir / "output.html"
    # pagetitle fills <title> without rendering pandoc's visible title block,
    # so the document body starts with the user's own content.
    extra = [
        "--standalone",
        "--embed-resources",
        f"--css={css.name}",
        "--metadata", f"pagetitle={title or src.stem}",
        f"--resource-path={workdir}",
    ]
    if extract_media:
        extra.append(f"--extract-media={workdir / 'media'}")
    _pandoc(src, "html5", out, from_fmt=from_fmt, cwd=workdir, extra=extra)
    return out


def _to_markdown(src: Path, from_fmt: str, workdir: Path, extract_media: bool) -> Path:
    out = workdir / "output.md"
    media_dir = workdir / "media"
    extra = ["--wrap=none", "--markdown-headings=atx"]
    if extract_media:
        extra.append(f"--extract-media={media_dir}")
    _pandoc(src, PANDOC_MD, out, from_fmt=from_fmt, cwd=workdir, extra=extra)

    # Make image links relative ("media/...") instead of absolute temp paths.
    text = out.read_text(encoding="utf-8", errors="replace")
    text = text.replace(str(media_dir), "media").replace(str(workdir) + "/", "")
    out.write_text(text, encoding="utf-8")

    if _media_files(media_dir):
        return _zip_with_media(out, media_dir, workdir / "output.zip")
    return out


def _md_or_html_to_pdf(src: Path, from_fmt: str, workdir: Path, title: str | None = None) -> Path:
    out = workdir / "output.pdf"
    if from_fmt == "html":
        # Render the page's own markup/CSS directly for maximum fidelity.
        _html_to_pdf(src, out, base_dir=workdir, with_default_css=False)
    else:
        html = _to_html_standalone(src, PANDOC_MD, workdir, extract_media=False, title=title)
        _html_to_pdf(html, out, base_dir=workdir, with_default_css=True)
    return out


def _to_docx(src: Path, from_fmt: str, workdir: Path) -> Path:
    out = workdir / "output.docx"
    extra = [f"--resource-path={workdir}", f"--extract-media={workdir / 'media'}"]
    _pandoc(src, "docx", out, from_fmt=from_fmt, cwd=workdir, extra=extra)
    return out


def _pdf_to_docx(src: Path, workdir: Path) -> Path:
    try:
        from pdf2docx import Converter
    except Exception as exc:  # pragma: no cover
        raise ConversionError("PDF → Word engine is not available on the server.") from exc
    out = workdir / "output.docx"
    try:
        cv = Converter(str(src))
        try:
            cv.convert(str(out))
        finally:
            cv.close()
    except ConversionError:
        raise
    except Exception as exc:
        raise ConversionError(
            f"Could not rebuild the PDF layout: {str(exc)[:300]}"
        ) from exc
    if not out.exists() or out.stat().st_size == 0:
        raise ConversionError("PDF → Word produced no output.")
    return out


def _pdf_to_markdown(src: Path, workdir: Path) -> Path:
    try:
        import pymupdf4llm
    except Exception as exc:  # pragma: no cover
        raise ConversionError("PDF → Markdown engine is not available.") from exc
    media_dir = workdir / "media"
    media_dir.mkdir(exist_ok=True)
    try:
        md_text = pymupdf4llm.to_markdown(
            str(src), write_images=True, image_path=str(media_dir)
        )
    except Exception as exc:
        raise ConversionError(f"Could not read the PDF: {str(exc)[:300]}") from exc
    if not md_text.strip() and not _media_files(media_dir):
        raise ConversionError(
            "No extractable text found — this PDF may be a scanned image."
        )
    out = workdir / "output.md"
    out.write_text(md_text.replace(str(media_dir), "media"), encoding="utf-8")
    if _media_files(media_dir):
        return _zip_with_media(out, media_dir, workdir / "output.zip")
    return out


def _pdf_to_html(src: Path, workdir: Path, title: str | None = None) -> Path:
    # Rebuild structure with pdf2docx, then emit a self-contained HTML file.
    docx = _pdf_to_docx(src, workdir)
    return _to_html_standalone(docx, "docx", workdir, extract_media=True, title=title)


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------
def convert_document(
    src: Path,
    source: str,
    target: str,
    workdir: Path,
    *,
    cleanup: frozenset[str] = frozenset(),
    pages: str | None = None,
    title: str | None = None,
) -> Path:
    # PDF-only preprocessing: trim to the requested pages, then OCR if scanned.
    if source == "pdf":
        if pages and pages.strip():
            src = trim_pdf_pages(src, pages, workdir)
        src = ensure_pdf_text_layer(src, workdir)

    # Pre-pass: text-based sources get cleaned before converting so every
    # downstream target (including PDF) inherits the changes.
    if cleanup:
        if source in ("md", "html"):
            apply_cleanup_text_file(src, cleanup, html_entities=(source == "html"))
        elif source == "docx":
            apply_cleanup_docx(src, cleanup)

    result = _dispatch(src, source, target, workdir, title)

    # Post-pass: PDF sources can't be edited in place, so clean the output.
    if cleanup and source == "pdf":
        ext = result.suffix.lstrip(".")
        if ext in ("md", "html"):
            apply_cleanup_text_file(result, cleanup, html_entities=(ext == "html"))
        elif ext == "docx":
            apply_cleanup_docx(result, cleanup)
        elif ext == "zip":
            _apply_cleanup_zip_markdown(result, cleanup)
    return result


def _apply_cleanup_zip_markdown(zip_path: Path, opts: frozenset[str]) -> None:
    tmp = zip_path.with_name(zip_path.stem + ".clean.zip")
    with zipfile.ZipFile(zip_path) as zin, zipfile.ZipFile(
        tmp, "w", zipfile.ZIP_DEFLATED
    ) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename.endswith((".md", ".html")):
                text = data.decode("utf-8", errors="replace")
                data = apply_cleanup_text(
                    text, opts, html_entities=item.filename.endswith(".html")
                ).encode("utf-8")
            zout.writestr(item, data)
    tmp.replace(zip_path)


def markdown_from_zip(zip_path: Path) -> str:
    """Pull the primary .md text out of a zipped markdown+media result."""
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.endswith(".md")]
        if not names:
            raise ConversionError("Converted archive contains no markdown file.")
        return zf.read(names[0]).decode("utf-8", errors="replace")


def docx_to_preview_html(docx_path: Path, workdir: Path) -> Path:
    """Render a produced .docx as standalone HTML for on-screen preview."""
    preview_dir = workdir / "docx-preview"
    preview_dir.mkdir(exist_ok=True)
    return _to_html_standalone(docx_path, "docx", preview_dir, extract_media=True)


def _dispatch(
    src: Path, source: str, target: str, workdir: Path, title: str | None = None
) -> Path:
    if source == "md":
        if target == "docx":
            return _to_docx(src, PANDOC_MD, workdir)
        if target == "html":
            return _to_html_standalone(src, PANDOC_MD, workdir, extract_media=False, title=title)
        if target == "pdf":
            return _md_or_html_to_pdf(src, PANDOC_MD, workdir, title=title)

    if source == "docx":
        if target == "md":
            return _to_markdown(src, "docx", workdir, extract_media=True)
        if target == "html":
            return _to_html_standalone(src, "docx", workdir, extract_media=True, title=title)
        if target == "pdf":
            return _docx_to_pdf_libreoffice(src, workdir)

    if source == "html":
        if target == "md":
            return _to_markdown(src, "html", workdir, extract_media=False)
        if target == "docx":
            return _to_docx(src, "html", workdir)
        if target == "pdf":
            return _md_or_html_to_pdf(src, "html", workdir)

    if source == "pdf":
        if target == "docx":
            return _pdf_to_docx(src, workdir)
        if target == "md":
            return _pdf_to_markdown(src, workdir)
        if target == "html":
            return _pdf_to_html(src, workdir, title=title)

    raise ConversionError(f"Conversion {source} → {target} is not supported.")
