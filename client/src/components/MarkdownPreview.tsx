import * as React from "react";
import { AlertTriangle, Eraser, Eye, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, readError } from "@/lib/api";
import { cn, themedPreviewHtml } from "@/lib/utils";

const DEBOUNCE_MS = 600;
const MAX_BYTES = 50 * 1024 * 1024;

const SAMPLE = `# Start typing, or open a .md file

Everything renders **live** as you write — headings, *emphasis*,
\`inline code\`, [links](https://example.com), and more.

| Feature | Supported |
|---------|-----------|
| Tables  | ✔         |
| Task lists | ✔      |

- [x] Write markdown
- [ ] Watch it render

> This is a preview-only space. Nothing is saved or downloaded.
`;

type RenderState =
  | { status: "empty" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; html: string };

export default function MarkdownPreview({ dark = false }: { dark?: boolean }) {
  const [text, setText] = React.useState(SAMPLE);
  const [liveText, setLiveText] = React.useState(SAMPLE);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [render, setRender] = React.useState<RenderState>({ status: "loading" });
  const [dragOver, setDragOver] = React.useState(false);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const seqRef = React.useRef(0);

  // Debounce keystrokes.
  React.useEffect(() => {
    const t = window.setTimeout(() => setLiveText(text), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [text]);

  // Render via the same pipeline conversions use, so the preview is faithful.
  React.useEffect(() => {
    if (!liveText.trim()) {
      setRender({ status: "empty" });
      return;
    }
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRender({ status: "loading" });

    const form = new FormData();
    form.append("file", new File([liveText], "preview.md", { type: "text/markdown" }));
    form.append("target", "html");
    form.append("mode", "preview");
    form.append("emdash", "0");

    apiFetch("/api/convert", { method: "POST", body: form, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(await readError(res, "Rendering failed."));
        }
        const html = await res.text();
        if (seq !== seqRef.current) return;
        setRender({ status: "ready", html });
      })
      .catch((err) => {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setRender({
          status: "error",
          message: err instanceof Error ? err.message : "Rendering failed.",
        });
      });

    return () => controller.abort();
  }, [liveText]);

  const openFile = async (f: File | undefined | null) => {
    if (!f) return;
    const ext = f.name.toLowerCase().split(".").pop() ?? "";
    if (!["md", "markdown", "mdown", "txt"].includes(ext)) {
      toast.error("Not a markdown file", {
        description: "Open a .md, .markdown or .txt file to preview it.",
      });
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error("File too large", { description: "The limit is 50 MB." });
      return;
    }
    const content = await f.text();
    setText(content);
    setLiveText(content); // render immediately, skip the debounce
    setFileName(f.name);
  };

  const clear = () => {
    setText("");
    setLiveText("");
    setFileName(null);
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div
      className="grid animate-fade-up gap-6 lg:grid-cols-2"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void openFile(e.dataTransfer.files?.[0]);
      }}
    >
      {/* Editor pane */}
      <Card className={cn("flex flex-col transition-colors", dragOver && "border-primary")}>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 font-display text-base">
              Markdown
              {fileName && (
                <Badge variant="secondary" className="max-w-40 truncate font-normal">
                  {fileName}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Type here, or drop a .md file anywhere on this panel.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              <FileUp /> Open .md
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clear}
              disabled={!text}
              aria-label="Clear editor"
            >
              <Eraser /> Clear
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-2 pb-6">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder="# Hello, paperless"
            aria-label="Markdown editor"
            className="h-[26rem] w-full flex-1 resize-none font-mono text-xs leading-relaxed lg:h-[32rem]"
          />
          <p className="text-right text-xs text-muted-foreground">
            {words} {words === 1 ? "word" : "words"} · {text.length} characters
          </p>
        </CardContent>
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.mdown,.txt"
          className="hidden"
          onChange={(e) => void openFile(e.target.files?.[0])}
        />
      </Card>

      {/* Rendered pane — view only */}
      <Card className="flex flex-col">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 font-display text-base">
              Rendered
              {render.status === "loading" ? (
                <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> updating
                </span>
              ) : render.status === "ready" ? (
                <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> live
                </span>
              ) : null}
            </CardTitle>
            <CardDescription>How your markdown reads as a document.</CardDescription>
          </div>
          <Badge variant="outline" className="shrink-0 gap-1 font-normal text-muted-foreground">
            <Eye className="h-3 w-3" /> Preview only
          </Badge>
        </CardHeader>
        <CardContent className="flex-1 pb-6">
          <div className="h-[26rem] overflow-hidden rounded-md border bg-card lg:h-[33.5rem]">
            {render.status === "empty" && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                <Eye className="h-8 w-8 opacity-50" />
                <p className="text-sm font-medium text-foreground">Nothing to preview yet</p>
                <p className="text-xs">Start typing on the left, or open a .md file.</p>
              </div>
            )}
            {render.status === "loading" && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p className="text-xs">Rendering…</p>
              </div>
            )}
            {render.status === "error" && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <AlertTriangle className="h-6 w-6 text-destructive" />
                <p className="text-sm font-medium">Preview unavailable</p>
                <p className="max-w-72 text-xs text-muted-foreground">{render.message}</p>
              </div>
            )}
            {render.status === "ready" && (
              <iframe
                sandbox=""
                srcDoc={themedPreviewHtml(render.html, dark)}
                title="Rendered markdown preview"
                className="h-full w-full bg-white dark:bg-[#0d1117]"
              />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
