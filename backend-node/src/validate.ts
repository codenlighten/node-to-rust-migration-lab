// Hand-written validation. The error messages are part of the API contract and are
// reproduced byte-for-byte in backend-rust/src/validate.rs.
export type Detail = { field: string; message: string };
export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Code points, not UTF-16 units, so lengths match Rust's chars().count().
const cpLen = (s: string) => [...s].length;

export function str(o: Obj, f: string, min: number, max: number, d: Detail[], required = true): string | undefined {
  const v = o[f];
  if (v === undefined || v === null) {
    if (required) d.push({ field: f, message: "is required" });
    return undefined;
  }
  if (typeof v !== "string") { d.push({ field: f, message: "must be a string" }); return undefined; }
  const n = cpLen(v);
  if (n < min || n > max) { d.push({ field: f, message: `must be between ${min} and ${max} characters` }); return undefined; }
  return v;
}

export function int(o: Obj, f: string, min: number, max: number, d: Detail[], required = true): number | undefined {
  const v = o[f];
  if (v === undefined || v === null) {
    if (required) d.push({ field: f, message: "is required" });
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) { d.push({ field: f, message: "must be an integer" }); return undefined; }
  if (v < min || v > max) { d.push({ field: f, message: `must be between ${min} and ${max}` }); return undefined; }
  return v;
}

export function bool(o: Obj, f: string, d: Detail[]): boolean | undefined {
  const v = o[f];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") { d.push({ field: f, message: "must be a boolean" }); return undefined; }
  return v;
}

// Intentionally simple and dependency-free: no whitespace, one '@', non-empty local part,
// domain containing an interior '.'.
export function validEmail(s: string): boolean {
  if (/\s/.test(s)) return false;
  const parts = s.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain) return false;
  const dot = domain.indexOf(".");
  return dot > 0 && !domain.endsWith(".");
}

export const MAX_INT32 = 2147483647;
