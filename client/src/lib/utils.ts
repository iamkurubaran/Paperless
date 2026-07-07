import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Overrides the server's light print stylesheet inside preview iframes when
// the app is in dark mode. Display-only: copy/share/download keep the
// original light document.
const DARK_PREVIEW_CSS = `<style data-paperless-dark-preview>
  :root { color-scheme: dark; }
  body { background: #0d1117; color: #d6dde6; }
  h1, h2, h3, h4, h5, h6 { color: #f0f3f8; }
  a { color: #8ab4ff; }
  blockquote { color: #a3adba; border-left-color: #3d4653; }
  code, kbd { background: #1c2230; }
  pre { background: #151b26; border-color: #2b3442; }
  pre code { background: none; }
  th { background: #1c2230; }
  th, td { border-color: #3d4653; }
  tr:nth-child(even) td { background: #141a24; }
  hr { border-top-color: #2b3442; }
</style>`;

export function themedPreviewHtml(html: string, dark: boolean): string {
  if (!dark) return html;
  const at = html.lastIndexOf("</body>");
  if (at === -1) return html + DARK_PREVIEW_CSS;
  return html.slice(0, at) + DARK_PREVIEW_CSS + html.slice(at);
}
