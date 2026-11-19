// Single-threaded bcrypt cost-10 timing for the two Node implementations (sync calls: no event-loop effects).
import bcryptjs from "bcryptjs";
import bcrypt from "bcrypt";
const N = Number(process.argv[2] ?? 40);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function run(name, hash, verify) {
  for (let i = 0; i < 3; i++) hash("password123", 10);
  const h = hash("password123", 10), hs = [], vs = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); hash("password123", 10); hs.push(performance.now() - t); }
  for (let i = 0; i < N; i++) { const t = performance.now(); if (!verify("password123", h)) throw new Error("verify failed"); vs.push(performance.now() - t); }
  console.log(JSON.stringify({ impl: name, n: N, hashMsMedian: +med(hs).toFixed(2), hashMsMin: +Math.min(...hs).toFixed(2), hashMsMax: +Math.max(...hs).toFixed(2), verifyMsMedian: +med(vs).toFixed(2) }));
}
run("node bcryptjs (pure JS, used by this repo)", bcryptjs.hashSync, bcryptjs.compareSync);
run("node bcrypt (native addon)", bcrypt.hashSync, bcrypt.compareSync);
