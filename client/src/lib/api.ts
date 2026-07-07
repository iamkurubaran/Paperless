// Shared API helpers: optional API key handling + fetch wrapper.

const KEY_STORAGE = "paperless-api-key";

let apiKey: string | null = null;
try {
  apiKey = window.localStorage.getItem(KEY_STORAGE);
} catch {
  /* storage unavailable */
}

export function getApiKey(): string | null {
  return apiKey;
}

export function setApiKey(value: string | null): void {
  apiKey = value && value.trim() ? value.trim() : null;
  try {
    if (apiKey) window.localStorage.setItem(KEY_STORAGE, apiKey);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (apiKey) headers.set("X-API-Key", apiKey);
  return fetch(input, { ...init, headers });
}

export async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401) return "This server requires an API key — add one from the key button in the header.";
  if (res.status === 429) return "Rate limit reached — wait a minute and try again.";
  return fallback;
}
