import * as React from "react";
import {
  ArrowRight,
  Download,
  FileText,
  FolderDown,
  Loader2,
  Play,
  RotateCcw,
  SlidersHorizontal,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import CleanupOptions, { cleanupToParam } from "@/components/CleanupOptions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { apiFetch, readError } from "@/lib/api";
import { cn } from "@/lib/utils";

type Fmt = "md" | "docx" | "pdf" | "html";
const EXT: Record<Fmt, string> = { md: ".md", docx: ".docx", pdf: ".pdf", html: ".html" };
const TARGETS: Fmt[] = ["md", "docx", "pdf", "html"];
const ACCEPT = ".md,.markdown,.docx,.pdf,.html,.htm";
const MAX_FILES = 20;
const MAX_BYTES = 50 * 1024 * 1024;
const POLL_MS = 1200;

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

type Item = { id: string; file: File; source: Fmt };
type JobInfo = {
  id: string;
  filename: string;
  source: Fmt;
  target: Fmt;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  downloadName: string | null;
};

function Tag({ fmt, active }: { fmt: Fmt; active?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs font-medium",
        active
          ? "border-primary/40 bg-accent text-accent-foreground"
          : "border-border bg-secondary text-secondary-foreground"
      )}
    >
      {EXT[fmt]}
    </span>
  );
}

export default function BatchConvert() {
  const [items, setItems] = React.useState<Item[]>([]);
  const [target, setTarget] = React.useState<Fmt | null>(null);
  const [cleanup, setCleanup] = React.useState<Set<string>>(new Set());
  const [showOptions, setShowOptions] = React.useState(false);
  const [batchId, setBatchId] = React.useState<string | null>(null);
  const [jobs, setJobs] = React.useState<JobInfo[]>([]);
  const [starting, setStarting] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const running = jobs.some((j) => j.status === "queued" || j.status === "running");
  const doneCount = jobs.filter((j) => j.status === "done").length;

  // ---- intake --------------------------------------------------------------
  const addFiles = (list: FileList | File[] | null | undefined) => {
    if (!list) return;
    const next: Item[] = [];
    let rejected = 0;
    for (const f of Array.from(list)) {
      const fmt = detectFormat(f.name);
      if (!fmt || f.size > MAX_BYTES) {
        rejected++;
        continue;
      }
      next.push({ id: crypto.randomUUID(), file: f, source: fmt });
    }
    if (rejected > 0) {
      toast.error(`${rejected} file(s) skipped`, {
        description: "Only .md, .docx, .pdf and .html files up to 50 MB are supported.",
      });
    }
    setItems((prev) => {
      const merged = [...prev, ...next].slice(0, MAX_FILES);
      if (prev.length + next.length > MAX_FILES) {
        toast.error(`A batch holds up to ${MAX_FILES} files.`);
      }
      return merged;
    });
  };

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  const resetAll = () => {
    setItems([]);
    setTarget(null);
    setBatchId(null);
    setJobs([]);
    if (inputRef.current) inputRef.current.value = "";
  };

  // ---- start + poll ----------------------------------------------------------
  const skipped = target ? items.filter((i) => i.source === target) : [];
  const convertible = target ? items.filter((i) => i.source !== target) : [];

  const start = async () => {
    if (!target || convertible.length === 0 || starting) return;
    setStarting(true);
    try {
      const form = new FormData();
      convertible.forEach((i) => form.append("files", i.file));
      form.append("target", target);
      form.append("cleanup", cleanupToParam(cleanup));

      const res = await apiFetch("/api/batch", { method: "POST", body: form });
      if (!res.ok) throw new Error(await readError(res, "Could not start the batch."));
      const data = await res.json();
      setBatchId(data.batchId);
      setJobs(data.jobs);
      if (skipped.length > 0) {
        toast.info(`${skipped.length} file(s) skipped`, {
          description: `They are already ${EXT[target]} files.`,
        });
      }
    } catch (err) {
      toast.error("Batch failed to start", {
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setStarting(false);
    }
  };

  React.useEffect(() => {
    if (!batchId || !running) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await apiFetch(`/api/batch/${batchId}`);
        if (!res.ok) return;
        const data = await res.json();
        setJobs(data.jobs);
      } catch {
        /* transient network error — keep polling */
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [batchId, running]);

  // ---- downloads -------------------------------------------------------------
  const saveBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const downloadJob = async (job: JobInfo) => {
    try {
      const res = await apiFetch(`/api/jobs/${job.id}/result`);
      if (!res.ok) throw new Error(await readError(res, "Download failed."));
      saveBlob(await res.blob(), job.downloadName ?? "converted");
    } catch (err) {
      toast.error("Download failed", {
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    }
  };

  const downloadAll = async () => {
    if (!batchId) return;
    try {
      const res = await apiFetch(`/api/batch/${batchId}/download`);
      if (!res.ok) throw new Error(await readError(res, "Download failed."));
      saveBlob(await res.blob(), "paperless-batch.zip");
    } catch (err) {
      toast.error("Download failed", {
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    }
  };

  // ---------------------------------------------------------------------------
  return (
    <Card className="animate-fade-up">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="font-display text-lg">Batch conversion</CardTitle>
          <CardDescription>
            Up to {MAX_FILES} files at once, converted in the background with live
            progress. Results stay available for 15 minutes.
          </CardDescription>
        </div>
        {(items.length > 0 || jobs.length > 0) && (
          <Button variant="ghost" size="sm" onClick={resetAll} disabled={running || starting}>
            <RotateCcw /> Start over
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Intake — hidden once a batch is running */}
        {jobs.length === 0 && (
          <>
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
                addFiles(e.dataTransfer.files);
              }}
              className={cn(
                "flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                dragOver
                  ? "border-primary bg-accent"
                  : "border-input bg-muted/40 hover:border-primary/50 hover:bg-accent/60"
              )}
            >
              <UploadCloud className={cn("h-6 w-6", dragOver ? "text-primary" : "text-muted-foreground")} />
              <span className="text-sm font-medium">
                Drop files here, or <span className="text-primary">browse</span>
              </span>
              <span className="text-xs text-muted-foreground">
                Mixed formats welcome — each converts from its own type.
              </span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {items.length > 0 && (
              <div className="space-y-2">
                {items.map((i) => {
                  const isSkipped = target !== null && i.source === target;
                  return (
                    <div
                      key={i.id}
                      className={cn(
                        "flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2",
                        isSkipped && "opacity-50"
                      )}
                    >
                      <FileText className="h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate text-sm">{i.file.name}</span>
                      <Tag fmt={i.source} />
                      {isSkipped && (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          already {EXT[target!]}
                        </Badge>
                      )}
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        {prettySize(i.file.size)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeItem(i.id)}
                        aria-label={`Remove ${i.file.name}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {items.length > 0 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Convert everything to
                  </span>
                  {TARGETS.map((t) => (
                    <Button
                      key={t}
                      type="button"
                      size="sm"
                      variant={target === t ? "default" : "outline"}
                      onClick={() => setTarget(t)}
                      aria-pressed={target === t}
                      className="font-mono text-xs"
                    >
                      {EXT[t]}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowOptions((s) => !s)}
                    aria-expanded={showOptions}
                  >
                    <SlidersHorizontal /> Cleanup
                    {cleanup.size > 0 && (
                      <Badge variant="secondary" className="ml-1">{cleanup.size}</Badge>
                    )}
                  </Button>
                </div>
                {showOptions && (
                  <div className="rounded-md border bg-muted/30 p-4">
                    <CleanupOptions value={cleanup} onChange={setCleanup} />
                  </div>
                )}
                <Button size="lg" onClick={start} disabled={!target || convertible.length === 0 || starting}>
                  {starting ? (
                    <><Loader2 className="animate-spin" /> Starting…</>
                  ) : (
                    <>
                      <Play /> Convert {convertible.length || ""} file
                      {convertible.length === 1 ? "" : "s"}
                    </>
                  )}
                </Button>
              </div>
            )}
          </>
        )}

        {/* Progress + results */}
        {jobs.length > 0 && (
          <div className="space-y-4">
            <div className="space-y-2">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-md border bg-muted/30 px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <Tag fmt={job.source} />
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <Tag fmt={job.target} active />
                    <span className="min-w-0 flex-1 truncate text-sm">{job.filename}</span>
                    {job.status === "done" ? (
                      <Button variant="outline" size="sm" onClick={() => downloadJob(job)}>
                        <Download /> Save
                      </Button>
                    ) : job.status === "error" ? (
                      <Badge variant="destructive" className="gap-1 font-normal">
                        <XCircle className="h-3 w-3" /> failed
                      </Badge>
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {job.status === "queued" ? "queued" : "converting"}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <Progress
                      value={job.progress}
                      className={cn(job.status === "error" && "[&>div]:bg-destructive")}
                    />
                  </div>
                  {job.status === "error" && (
                    <p className="mt-1.5 text-xs text-destructive">{job.message}</p>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={downloadAll} disabled={doneCount === 0}>
                <FolderDown /> Download all as .zip
              </Button>
              <p className="text-xs text-muted-foreground">
                {running
                  ? `${doneCount} of ${jobs.length} finished…`
                  : `${doneCount} of ${jobs.length} converted successfully.`}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
