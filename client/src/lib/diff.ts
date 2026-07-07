// Minimal Myers line diff. Returns null when inputs are too large to diff
// comfortably in the browser.

export type DiffLine = { type: "same" | "add" | "del"; text: string };

const MAX_LINES = 5000;
const MAX_D = 2000;

export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;

  // Trim common prefix / suffix to keep the core diff small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const core = myers(a.slice(start, endA), b.slice(start, endB));
  if (core === null) return null;

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: "same", text: a[i] });
  out.push(...core);
  for (let i = endA; i < a.length; i++) out.push({ type: "same", text: a[i] });
  return out;
}

function myers(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((text) => ({ type: "add" as const, text }));
  if (m === 0) return a.map((text) => ({ type: "del" as const, text }));

  const max = Math.min(n + m, MAX_D);
  const offset = max;
  let v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  outer: {
    for (let d = 0; d <= max; d++) {
      trace.push(v.slice());
      const next = v.slice();
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
          x = v[offset + k + 1];
        } else {
          x = v[offset + k - 1] + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x++;
          y++;
        }
        next[offset + k] = x;
        if (x >= n && y >= m) {
          trace.push(next);
          v = next;
          break outer;
        }
      }
      v = next;
      if (d === max) return null; // too different to diff within budget
    }
  }

  // Backtrack.
  const ops: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0 && (x > 0 || y > 0); d--) {
    const prev = trace[d - 1];
    const k = x - y;
    let prevK: number;
    if (k === -(d - 1) || (k !== d - 1 && prev[offset + k - 1] < prev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "same", text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: "add", text: b[y - 1] });
        y--;
      } else {
        ops.push({ type: "del", text: a[x - 1] });
        x--;
      }
    }
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    ops.push({ type: "same", text: a[x - 1] });
    x--;
    y--;
  }
  while (x > 0) {
    ops.push({ type: "del", text: a[--x] });
  }
  while (y > 0) {
    ops.push({ type: "add", text: b[--y] });
  }
  return ops.reverse();
}
