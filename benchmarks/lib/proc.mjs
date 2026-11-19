// /proc helpers: CPU seconds and RSS of a process tree (a container's main PID plus all descendants).
import { readFileSync, readdirSync } from "node:fs";
const ppidOf = (pid) => { try { return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1]); } catch { return null; } };
export function tree(root) {
  if (root == null) return [];
  const parent = new Map();
  for (const d of readdirSync("/proc")) if (/^\d+$/.test(d)) { const pp = ppidOf(d); if (pp != null) parent.set(Number(d), pp); }
  const out = [Number(root)];
  for (let i = 0; i < out.length; i++) for (const [c, pp] of parent) if (pp === out[i] && !out.includes(c)) out.push(c);
  return out;
}
const cpuOne = (pid) => { try { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / 100; } catch { return 0; } };
const rssOne = (pid) => { try { return Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]) / 1024; } catch { return 0; } };
export const cpuSec = (root) => tree(root).reduce((n, p) => n + cpuOne(p), 0);
export const rssMb = (root) => tree(root).reduce((n, p) => n + rssOne(p), 0);
