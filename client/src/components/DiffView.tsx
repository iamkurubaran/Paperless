import * as React from "react";
import { diffLines } from "@/lib/diff";
import { cn } from "@/lib/utils";

export default function DiffView({
  before,
  after,
  className,
}: {
  before: string;
  after: string;
  className?: string;
}) {
  const lines = React.useMemo(() => diffLines(before, after), [before, after]);
  const stats = React.useMemo(() => {
    if (!lines) return null;
    return {
      added: lines.filter((l) => l.type === "add").length,
      removed: lines.filter((l) => l.type === "del").length,
    };
  }, [lines]);

  if (!lines) {
    return (
      <div className={cn("flex items-center justify-center rounded-md border bg-muted/30 p-6", className)}>
        <p className="text-xs text-muted-foreground">
          The documents differ too much to diff in the browser — the editor still holds your latest version.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-md border", className)}>
      <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-1.5 text-xs">
        <span className="font-medium">Changes vs. original</span>
        {stats && (
          <span className="text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{stats.removed}</span>
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto font-mono text-xs leading-relaxed">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "flex whitespace-pre-wrap break-words px-3",
              line.type === "add" && "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
              line.type === "del" && "bg-red-500/15 text-red-900 line-through decoration-red-400/60 dark:text-red-200"
            )}
          >
            <span className="mr-2 w-3 shrink-0 select-none text-muted-foreground">
              {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
            </span>
            <span className="min-w-0 flex-1">{line.text || "\u00a0"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
