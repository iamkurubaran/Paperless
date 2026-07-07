import { Switch } from "@/components/ui/switch";

export const CLEANUP_RULES: { key: string; label: string; hint: string }[] = [
  { key: "emdash", label: "Em dashes → hyphens", hint: "— becomes -" },
  { key: "quotes", label: "Smart quotes → straight", hint: "“ ” ‘ ’ become \" and '" },
  { key: "spaces", label: "Collapse double spaces", hint: "between words only" },
  { key: "trailing", label: "Trim trailing whitespace", hint: "end of each line" },
  { key: "newlines", label: "Normalize line endings", hint: "CRLF becomes LF" },
];

export function cleanupToParam(opts: ReadonlySet<string>): string {
  return Array.from(opts).sort().join(",");
}

export default function CleanupOptions({
  value,
  onChange,
  disabled,
}: {
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  const toggle = (key: string, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(key);
    else next.delete(key);
    onChange(next);
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {CLEANUP_RULES.map((rule) => (
        <label key={rule.key} className="flex cursor-pointer items-center gap-2.5 text-sm">
          <Switch
            checked={value.has(rule.key)}
            onCheckedChange={(on) => toggle(rule.key, on)}
            disabled={disabled}
            aria-label={rule.label}
          />
          <span>
            {rule.label}
            <span className="ml-1.5 text-xs text-muted-foreground">{rule.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
