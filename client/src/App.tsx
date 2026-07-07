import * as React from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Copy,
  Download,
  FileDiff,
  FileText,
  ImageIcon,
  Info,
  KeyRound,
  Loader2,
  Moon,
  Pencil,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  Sun,
  UploadCloud,
  X,
} from "lucide-react";
import { toast } from "sonner";

import BatchConvert from "@/components/BatchConvert";
import CleanupOptions, { cleanupToParam } from "@/components/CleanupOptions";
import DiffView from "@/components/DiffView";
import MarkdownPreview from "@/components/MarkdownPreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, getApiKey, readError, setApiKey } from "@/lib/api";
import { cn, themedPreviewHtml } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------
type Fmt = "md" | "docx" | "pdf" | "html";

const FORMATS: Record<Fmt, { label: string; ext: string; mime: string }> = {
  md: { label: "Markdown", ext: ".md", mime: "text/markdown" },
  docx: {
    label: "Word",
    ext: ".docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  pdf: { label: "PDF", ext: ".pdf", mime: "application/pdf" },
  html: { label: "HTML", ext: ".html", mime: "text/html" },
};

const MATRIX: Record<Fmt, Fmt[]> = {
  md: ["docx", "pdf", "html"],
  docx: ["md", "pdf", "html"],
  pdf: ["docx", "md", "html"],
  html: ["md", "docx", "pdf"],
};

const EDITABLE: ReadonlySet<Fmt> = new Set(["md", "html"]);
const ACCEPT = ".md,.markdown,.docx,.pdf,.html,.htm";
const MAX_BYTES = 50 * 1024 * 1024;
const EDIT_DEBOUNCE_MS = 700;

function detectFormat(name: string): Fmt | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["md", "markdown", "mdown"].includes(ext)) return "md";
  if (["docx", "doc"].includes(ext)) return "docx";
  if (ext === "pdf") return "pdf";
  if (["html", "htm"].includes(ext)) return "html";
  return null;
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename\*?=(?:UTF-8''|")?([^";\n]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : fallback;
}

function countEmdashes(text: string, isHtml: boolean): number {
  let count = (text.match(/\u2014/g) ?? []).length;
  if (isHtml) count += (text.match(/&mdash;|&#8212;|&#x2014;/gi) ?? []).length;
  return count;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------
function FormatTag({
  fmt,
  active,
  dimmed,
}: {
  fmt: Fmt;
  active?: boolean;
  dimmed?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs font-medium tracking-tight transition-colors",
        active
          ? "border-primary/40 bg-accent text-accent-foreground"
          : "border-border bg-secondary text-secondary-foreground",
        dimmed && "opacity-40"
      )}
    >
      {FORMATS[fmt].ext}
    </span>
  );
}

/** Signature element: an animated dashed "paper trail" between formats. */
function Trail({ live }: { live: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-12 shrink-0 sm:w-16"
      viewBox="0 0 80 16"
      fill="none"
      preserveAspectRatio="none"
    >
      <line
        x1="2"
        y1="8"
        x2="70"
        y2="8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="2 7"
        className={cn("text-muted-foreground/50", live && "animate-trail-dash text-primary")}
      />
      <path
        d="M70 3.5 76 8l-6 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("text-muted-foreground/50", live && "text-primary")}
      />
    </svg>
  );
}

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      kind: "html" | "pdf" | "md";
      html?: string;
      mdText?: string;
      pdfUrl?: string;
      isRendition: boolean;
      hasMediaZip: boolean;
    };

type RecentItem = {
  id: string;
  from: Fmt;
  to: Fmt;
  name: string;
  url: string;
  size: number;
};

type Mode = "convert" | "batch" | "mdpreview";

function useTheme() {
  const [dark, setDark] = React.useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem("paperless-theme");
      if (stored === "dark") return true;
      if (stored === "light") return false;
    } catch {
      /* storage unavailable */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      window.localStorage.setItem("paperless-theme", dark ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const { dark, toggle: toggleTheme } = useTheme();
  const [mode, setMode] = React.useState<Mode>("convert");
  const [visited, setVisited] = React.useState<Set<Mode>>(new Set(["convert"]));

  // API key mini-panel
  const [keyOpen, setKeyOpen] = React.useState(false);
  const [keyDraft, setKeyDraft] = React.useState(getApiKey() ?? "");

  const [file, setFile] = React.useState<File | null>(null);
  const [source, setSource] = React.useState<Fmt | null>(null);
  const [target, setTarget] = React.useState<Fmt | null>(null);

  // Cleanup options + PDF page selection
  const [cleanup, setCleanup] = React.useState<Set<string>>(new Set());
  const [showCleanup, setShowCleanup] = React.useState(false);
  const [pages, setPages] = React.useState("");
  const [livePages, setLivePages] = React.useState("");
  const [pageCount, setPageCount] = React.useState<number | null>(null);
  const cleanupParam = cleanupToParam(cleanup);

  // Editable source text (md / html only)
  const [text, setText] = React.useState<string | null>(null);
  const [originalText, setOriginalText] = React.useState<string | null>(null);
  const [liveText, setLiveText] = React.useState<string | null>(null);
  const [showDiff, setShowDiff] = React.useState(false);

  const [preview, setPreview] = React.useState<PreviewState>({ status: "idle" });
  const [downloading, setDownloading] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [recent, setRecent] = React.useState<RecentItem[]>([]);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const pdfUrlRef = React.useRef<string | null>(null);
  const seqRef = React.useRef(0);

  const editable = source !== null && EDITABLE.has(source);
  const edited =
    editable && text !== null && originalText !== null && text !== originalText;

  const switchMode = (m: Mode) => {
    setMode(m);
    setVisited((v) => new Set(v).add(m));
  };

  // ---- file intake ---------------------------------------------------------
  const takeFile = React.useCallback(async (f: File | undefined | null) => {
    if (!f) return;
    const fmt = detectFormat(f.name);
    if (!fmt) {
      toast.error("Unsupported file type", {
        description: "Paperless converts .md, .docx, .pdf and .html files.",
      });
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error("File too large", { description: "The upload limit is 50 MB." });
      return;
    }
    setFile(f);
    setSource(fmt);
    setTarget(null);
    setCleanup(new Set());
    setShowCleanup(false);
    setPages("");
    setLivePages("");
    setPageCount(null);
    setShowDiff(false);
    setPreview({ status: "idle" });
    if (EDITABLE.has(fmt)) {
      const content = await f.text();
      setText(content);
      setOriginalText(content);
      setLiveText(content);
    } else {
      setText(null);
      setOriginalText(null);
      setLiveText(null);
    }
    if (fmt === "pdf") {
      const form = new FormData();
      form.append("file", f);
      apiFetch("/api/pdf/info", { method: "POST", body: form })
        .then(async (res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && typeof data.pages === "number") setPageCount(data.pages);
        })
        .catch(() => undefined);
    }
  }, []);

  const reset = () => {
    abortRef.current?.abort();
    setFile(null);
    setSource(null);
    setTarget(null);
    setCleanup(new Set());
    setShowCleanup(false);
    setPages("");
    setLivePages("");
    setPageCount(null);
    setText(null);
    setOriginalText(null);
    setLiveText(null);
    setShowDiff(false);
    setPreview({ status: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  };

  // ---- debounce edits + page spec -----------------------------------------
  React.useEffect(() => {
    if (text === null) return;
    const t = window.setTimeout(() => setLiveText(text), EDIT_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [text]);

  React.useEffect(() => {
    const t = window.setTimeout(() => setLivePages(pages), EDIT_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [pages]);

  // The exact payload used for preview, share and download, so they all match.
  const buildPayload = React.useCallback((): File | null => {
    if (!file || !source) return null;
    if (editable && text !== null) {
      return new File([text], file.name, { type: FORMATS[source].mime });
    }
    return file;
  }, [file, source, editable, text]);

  const buildForm = React.useCallback(
    (payload: File, tgt: Fmt, mode: string, pageSpec: string): FormData => {
      const form = new FormData();
      form.append("file", payload);
      form.append("target", tgt);
      form.append("mode", mode);
      form.append("cleanup", cleanupParam);
      form.append("pages", pageSpec);
      return form;
    },
    [cleanupParam]
  );

  // ---- live preview --------------------------------------------------------
  React.useEffect(() => {
    if (!file || !source || !target) return;

    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPreview({ status: "loading" });

    const payload =
      editable && liveText !== null
        ? new File([liveText], file.name, { type: FORMATS[source].mime })
        : file;

    const form = buildForm(payload, target, "preview", source === "pdf" ? livePages : "");

    apiFetch("/api/convert", { method: "POST", body: form, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res, "Preview failed."));
        const isRendition = res.headers.get("X-Preview-Rendition") === "html";
        const hasMediaZip = res.headers.get("X-Media-Note") === "1";

        if (target === "pdf") {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          if (seq !== seqRef.current) {
            URL.revokeObjectURL(url);
            return;
          }
          if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
          pdfUrlRef.current = url;
          setPreview({
            status: "ready",
            kind: "pdf",
            pdfUrl: url,
            isRendition: false,
            hasMediaZip: false,
          });
          return;
        }

        const textBody = await res.text();
        if (seq !== seqRef.current) return;
        if (target === "md") {
          setPreview({
            status: "ready",
            kind: "md",
            mdText: textBody,
            isRendition: false,
            hasMediaZip,
          });
        } else {
          setPreview({
            status: "ready",
            kind: "html",
            html: textBody,
            isRendition,
            hasMediaZip: false,
          });
        }
      })
      .catch((err) => {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setPreview({
          status: "error",
          message: err instanceof Error ? err.message : "Preview failed.",
        });
      });

    return () => controller.abort();
  }, [file, source, target, cleanupParam, livePages, liveText, editable, buildForm]);

  React.useEffect(
    () => () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    },
    []
  );

  // ---- download / copy / share ---------------------------------------------
  const download = async () => {
    const payload = buildPayload();
    if (!payload || !source || !target || downloading) return;
    setDownloading(true);
    try {
      const form = buildForm(payload, target, "download", source === "pdf" ? pages : "");
      const res = await apiFetch("/api/convert", { method: "POST", body: form });
      if (!res.ok) {
        throw new Error(await readError(res, "Conversion failed. Please try another file."));
      }
      const blob = await res.blob();
      const fallback = `${payload.name.replace(/\.[^.]+$/, "")}.${target}`;
      const name = filenameFromDisposition(res.headers.get("Content-Disposition"), fallback);
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setRecent((list) =>
        [
          { id: crypto.randomUUID(), from: source, to: target, name, url, size: blob.size },
          ...list,
        ].slice(0, 8)
      );
      toast.success("Converted and downloaded", {
        description: name.endsWith(".zip")
          ? `${name} — Markdown plus its images, zipped together.`
          : name,
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
    } catch (err) {
      toast.error("Couldn't convert this file", {
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setDownloading(false);
    }
  };

  const copyPreview = async () => {
    if (preview.status !== "ready") return;
    const content = preview.kind === "md" ? preview.mdText : preview.html;
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      toast.success(`Copied ${preview.kind === "md" ? "Markdown" : "HTML"} to the clipboard`);
    } catch {
      toast.error("Couldn't access the clipboard.");
    }
  };

  const sharePreview = async () => {
    const payload = buildPayload();
    if (!payload || !source || !target || sharing) return;
    setSharing(true);
    try {
      const form = buildForm(payload, target, "share", source === "pdf" ? pages : "");
      const res = await apiFetch("/api/share", { method: "POST", body: form });
      if (!res.ok) throw new Error(await readError(res, "Could not create a share link."));
      const data = await res.json();
      const url = `${window.location.origin}${data.url}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Share link copied", {
          description: "Anyone with the link can view it for the next hour.",
        });
      } catch {
        toast.success("Share link ready", { description: url });
      }
    } catch (err) {
      toast.error("Couldn't share", {
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setSharing(false);
    }
  };

  const targets = source ? MATRIX[source] : [];
  const busy = preview.status === "loading" || downloading;
  const emdashCount =
    editable && text !== null ? countEmdashes(text, source === "html") : null;
  const workspaceOpen = Boolean(file && source && target);
  const wide = workspaceOpen || mode !== "convert";
  const canCopy =
    preview.status === "ready" &&
    (preview.kind === "md" || (preview.kind === "html" && !preview.isRendition));

  // ---------------------------------------------------------------------------
  return (
    <div
      className={cn(
        "mx-auto flex min-h-screen w-full flex-col px-4 py-10 transition-all duration-300 sm:px-6",
        wide ? "max-w-6xl" : "max-w-3xl"
      )}
    >
      {/* Header */}
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            paperless<span className="text-primary">.</span>
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Convert documents without losing a thing.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <div className="mr-2 hidden items-center gap-1.5 md:flex" aria-hidden="true">
            <FormatTag fmt={source ?? "md"} active={!!source} />
            <Trail live={busy} />
            <FormatTag fmt={target ?? "pdf"} active={!!target} />
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setKeyOpen((o) => !o)}
            aria-label="API key settings"
            aria-expanded={keyOpen}
            className={cn(getApiKey() && "text-primary")}
          >
            <KeyRound className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      {/* API key panel */}
      {keyOpen && (
        <div className="mb-6 flex animate-fade-up flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3">
          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="API key (only needed if this server requires one)"
            aria-label="API key"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            size="sm"
            onClick={() => {
              setApiKey(keyDraft);
              setKeyOpen(false);
              toast.success(keyDraft.trim() ? "API key saved" : "API key cleared");
            }}
          >
            Save
          </Button>
        </div>
      )}

      {/* Mode switcher */}
      <div
        role="tablist"
        aria-label="Workspace mode"
        className="mb-6 inline-flex self-start rounded-lg border bg-muted/60 p-1"
      >
        {(
          [
            { id: "convert", label: "Convert" },
            { id: "batch", label: "Batch" },
            { id: "mdpreview", label: "Preview Markdown" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={mode === tab.id}
            onClick={() => switchMode(tab.id)}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mode === tab.id
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {visited.has("batch") && (
        <div className={cn(mode !== "batch" && "hidden")}>
          <BatchConvert />
        </div>
      )}
      {visited.has("mdpreview") && (
        <div className={cn(mode !== "mdpreview" && "hidden")}>
          <MarkdownPreview dark={dark} />
        </div>
      )}

      <div className={cn(mode !== "convert" && "hidden")}>
        {/* Step 1+2 — file and route */}
        <Card className="animate-fade-up">
          <CardHeader>
            <CardTitle className="font-display text-lg">Convert a document</CardTitle>
            <CardDescription>
              Pick a file and a target format — the full converted document appears
              live before you download it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!file ? (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  void takeFile(e.dataTransfer.files?.[0]);
                }}
                className={cn(
                  "flex w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  dragOver
                    ? "border-primary bg-accent"
                    : "border-input bg-muted/40 hover:border-primary/50 hover:bg-accent/60"
                )}
              >
                <span
                  className={cn(
                    "flex h-12 w-12 items-center justify-center rounded-full bg-card shadow-sm",
                    dragOver ? "text-primary" : "text-muted-foreground"
                  )}
                >
                  <UploadCloud className="h-6 w-6" />
                </span>
                <span className="text-sm font-medium">
                  Drop a file here, or <span className="text-primary">browse</span>
                </span>
                <span className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  {(Object.keys(FORMATS) as Fmt[]).map((f) => (
                    <FormatTag key={f} fmt={f} />
                  ))}
                  <span className="ml-1">up to 50 MB</span>
                </span>
              </button>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-card text-primary shadow-sm">
                    <FileText className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {file.name}
                      {edited && (
                        <Badge variant="secondary" className="ml-2 gap-1 font-normal">
                          <Pencil className="h-3 w-3" /> edited
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {FORMATS[source!].label} · {prettySize(file.size)}
                      {editable && " · editable"}
                      {source === "pdf" && pageCount !== null && ` · ${pageCount} pages`}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={reset}
                    disabled={downloading}
                    aria-label="Remove file"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                {/* route + options */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        From
                      </span>
                      <FormatTag fmt={source!} active />
                    </div>
                    <Trail live={busy} />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        To
                      </span>
                      {targets.map((t) => (
                        <Button
                          key={t}
                          type="button"
                          size="sm"
                          variant={target === t ? "default" : "outline"}
                          onClick={() => setTarget(t)}
                          aria-pressed={target === t}
                          className="font-mono text-xs"
                        >
                          {FORMATS[t].ext}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowCleanup((s) => !s)}
                    aria-expanded={showCleanup}
                  >
                    <SlidersHorizontal /> Cleanup
                    {cleanup.size > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {cleanup.size}
                      </Badge>
                    )}
                  </Button>

                  {source === "pdf" && (
                    <label className="flex items-center gap-2 text-sm">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Pages
                      </span>
                      <input
                        type="text"
                        value={pages}
                        onChange={(e) => setPages(e.target.value)}
                        placeholder="all"
                        aria-label="Page range, for example 1-5, 8"
                        className="h-8 w-28 rounded-md border border-input bg-card px-2.5 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      <span className="text-xs text-muted-foreground">
                        e.g. 1-5, 8{pageCount !== null && ` · of ${pageCount}`}
                      </span>
                    </label>
                  )}
                </div>

                {showCleanup && (
                  <div className="animate-fade-up rounded-md border bg-muted/30 p-4">
                    <CleanupOptions value={cleanup} onChange={setCleanup} />
                    {cleanup.has("emdash") && emdashCount !== null && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {emdashCount} em dash{emdashCount === 1 ? "" : "es"} found in the
                        source.
                      </p>
                    )}
                  </div>
                )}

                {!target && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Info className="h-3.5 w-3.5" /> Choose a target format to open the
                    live preview.
                  </p>
                )}
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => void takeFile(e.target.files?.[0])}
            />
          </CardContent>
        </Card>

        {/* Step 3 — workspace: source (editor/diff) + live target preview */}
        {workspaceOpen && (
          <div className="mt-6 grid animate-fade-up gap-6 lg:grid-cols-2">
            {/* Source pane */}
            <Card className="flex flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <div>
                  <CardTitle className="flex items-center gap-2 font-display text-base">
                    Source <FormatTag fmt={source!} active />
                  </CardTitle>
                  <CardDescription>
                    {editable
                      ? "Edit here — the preview follows your changes."
                      : `${FORMATS[source!].label} files aren't editable in the browser; the preview uses the original file.`}
                  </CardDescription>
                </div>
                {edited && (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant={showDiff ? "default" : "outline"}
                      size="sm"
                      onClick={() => setShowDiff((s) => !s)}
                      aria-pressed={showDiff}
                    >
                      <FileDiff /> {showDiff ? "Editor" : "Changes"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setText(originalText);
                        setLiveText(originalText);
                        setShowDiff(false);
                      }}
                    >
                      <RotateCcw /> Reset
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex-1 pb-6">
                {editable ? (
                  showDiff && edited ? (
                    <DiffView
                      before={originalText ?? ""}
                      after={text ?? ""}
                      className="h-[26rem] lg:h-[32rem]"
                    />
                  ) : (
                    <Textarea
                      value={text ?? ""}
                      onChange={(e) => setText(e.target.value)}
                      spellCheck={false}
                      aria-label="Source document editor"
                      className="h-[26rem] w-full resize-none font-mono text-xs leading-relaxed lg:h-[32rem]"
                    />
                  )
                ) : (
                  <div className="flex h-[26rem] flex-col items-center justify-center gap-3 rounded-md border bg-muted/30 text-center lg:h-[32rem]">
                    <FileText className="h-10 w-10 text-muted-foreground/60" />
                    <div>
                      <p className="text-sm font-medium">{file!.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {FORMATS[source!].label} · {prettySize(file!.size)}
                        {source === "pdf" && pageCount !== null && ` · ${pageCount} pages`}
                      </p>
                    </div>
                    <p className="max-w-64 text-xs text-muted-foreground">
                      Tip: convert to Markdown or HTML first if you want to edit the
                      content, then convert onward.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Preview pane */}
            <Card className="flex flex-col">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 font-display text-base">
                    Preview <FormatTag fmt={target!} active />
                    {preview.status === "loading" ? (
                      <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> updating
                      </span>
                    ) : preview.status === "ready" ? (
                      <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> live
                      </span>
                    ) : null}
                  </CardTitle>
                  <CardDescription>
                    {preview.status === "ready" && preview.isRendition
                      ? "Shown as HTML — the download is the exact Word file."
                      : preview.status === "ready" && preview.hasMediaZip
                        ? "Images extracted — the download is a .zip with the .md and its media."
                        : "The complete converted document, exactly what you'll download."}
                  </CardDescription>
                </div>
                <div className="flex shrink-0 gap-2">
                  {canCopy && (
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={copyPreview}
                      aria-label="Copy converted output"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={sharePreview}
                    disabled={sharing || preview.status !== "ready"}
                    aria-label="Create a share link"
                  >
                    {sharing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Share2 className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    onClick={download}
                    disabled={downloading || preview.status === "loading"}
                  >
                    {downloading ? (
                      <>
                        <Loader2 className="animate-spin" /> Converting…
                      </>
                    ) : (
                      <>
                        <Download /> {FORMATS[target!].ext}
                      </>
                    )}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex-1 pb-6">
                <div className="h-[26rem] overflow-hidden rounded-md border bg-card lg:h-[32rem]">
                  {preview.status === "loading" && (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <p className="text-xs">Converting the full document…</p>
                    </div>
                  )}
                  {preview.status === "error" && (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                      <AlertTriangle className="h-6 w-6 text-destructive" />
                      <p className="text-sm font-medium">Preview unavailable</p>
                      <p className="max-w-72 text-xs text-muted-foreground">
                        {preview.message}
                      </p>
                    </div>
                  )}
                  {preview.status === "ready" && preview.kind === "pdf" && preview.pdfUrl && (
                    <iframe
                      key={preview.pdfUrl}
                      src={preview.pdfUrl}
                      title="PDF preview"
                      className="h-full w-full"
                    />
                  )}
                  {preview.status === "ready" && preview.kind === "html" && (
                    <iframe
                      sandbox=""
                      srcDoc={themedPreviewHtml(preview.html ?? "", dark)}
                      title="Document preview"
                      className="h-full w-full bg-white dark:bg-[#0d1117]"
                    />
                  )}
                  {preview.status === "ready" && preview.kind === "md" && (
                    <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
                      {preview.mdText}
                    </pre>
                  )}
                </div>
                {preview.status === "ready" && preview.hasMediaZip && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ImageIcon className="h-3.5 w-3.5" />
                    Image links point to the media/ folder inside the downloaded zip.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Recent conversions */}
        {recent.length > 0 && (
          <Card className="mt-6 animate-fade-up">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="font-display text-base">Recent conversions</CardTitle>
                <CardDescription>Available until you close this tab.</CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  recent.forEach((r) => URL.revokeObjectURL(r.url));
                  setRecent([]);
                }}
              >
                <RotateCcw /> Clear
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {recent.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2"
                >
                  <FormatTag fmt={r.from} dimmed />
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <FormatTag fmt={r.to} active />
                  <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {prettySize(r.size)}
                  </span>
                  <Button asChild variant="outline" size="sm">
                    <a href={r.url} download={r.name}>
                      <Download /> Save
                    </a>
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Supported routes */}
        <section className="mt-10">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Every route, both directions
          </h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {(Object.keys(MATRIX) as Fmt[]).map((from) => (
              <div key={from} className="space-y-1.5">
                {MATRIX[from].map((to) => (
                  <div key={to} className="flex items-center gap-1.5 text-xs">
                    <FormatTag fmt={from} />
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <FormatTag fmt={to} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>

      <Separator className="mt-10" />
      <footer className="flex flex-wrap items-center justify-between gap-2 py-5 text-xs text-muted-foreground">
        <span>
          Files are converted in memory and deleted right after — share links expire in
          an hour, batch results in 15 minutes.
        </span>
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" className="font-mono">
            v2.0
          </Badge>
          paperless
        </span>
      </footer>
    </div>
  );
}
