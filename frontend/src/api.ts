// The ONLY place the UI talks to the backend. It uses relative URLs through the gateway, so the same
// bundle works against Node or Rust without a rebuild; the backend is chosen at the gateway.
export type LogEntry = { ts: number; method: string; path: string; status: number; ms: number; servedBy: string };
type Listener = (e: LogEntry) => void;
const listeners = new Set<Listener>();
export const onRequest = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };

export let token: string | null = (() => { try { return localStorage.getItem("token"); } catch { return null; } })();
export function setToken(t: string | null) {
  token = t;
  try { t ? localStorage.setItem("token", t) : localStorage.removeItem("token"); } catch { /* storage unavailable */ }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const t0 = performance.now();
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (res.status === 204 ? null : await res.json().catch(() => null)) as T;
  const e: LogEntry = { ts: Date.now(), method, path, status: res.status, ms: Math.round(performance.now() - t0), servedBy: res.headers.get("x-served-by") ?? "?" };
  listeners.forEach((l) => l(e));
  return { status: res.status, data };
}
