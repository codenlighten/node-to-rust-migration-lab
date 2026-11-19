import { useCallback, useEffect, useState } from "react";
import { LogEntry, api, onRequest, setToken, token } from "./api";

type Product = { id: number; sku: string; name: string; description: string; priceCents: number; stock: number };
type Order = { id: number; status: string; totalCents: number; items: { productId: number; quantity: number; unitPriceCents: number }[]; createdAt: string };
type Gw = { mode: "node" | "rust" | "canary"; canaryPercent: number; health: Record<string, { ok: boolean | null }>; events: { ts: string; msg: string }[]; stats: Record<string, { requests: number; avgMs: number }> };

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function App() {
  const [tab, setTab] = useState<"shop" | "orders" | "dashboard">("shop");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  useEffect(() => onRequest((e) => setLog((l) => [e, ...l].slice(0, 30))), []);
  const loadMe = useCallback(async () => {
    if (!token) return setMe(null);
    const r = await api("GET", "/api/me");
    if (r.status === 200) setMe(r.data); else { setToken(null); setMe(null); }
  }, []);
  useEffect(() => { loadMe(); }, [loadMe]);

  return (
    <div className="app">
      <header>
        <h1>Node → Rust Migration Lab</h1>
        <nav>{(["shop", "orders", "dashboard"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</nav>
        <Auth me={me} onChange={loadMe} />
      </header>
      <main>
        {tab === "shop" && <Shop signedIn={!!me} />}
        {tab === "orders" && <Orders signedIn={!!me} />}
        {tab === "dashboard" && <Dashboard />}
      </main>
      <RequestLog log={log} />
    </div>
  );
}

function Auth({ me, onChange }: { me: { email: string; role: string } | null; onChange: () => void }) {
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("password123");
  const [msg, setMsg] = useState("");
  const login = async () => {
    let r = await api("POST", "/api/auth/login", { email, password });
    if (r.status === 401) { // first visit: create the demo account, then sign in
      await api("POST", "/api/auth/register", { email, password, name: email.split("@")[0] });
      r = await api("POST", "/api/auth/login", { email, password });
    }
    if (r.status === 200) { setToken(r.data.token); setMsg(""); onChange(); } else setMsg(r.data?.error?.message ?? "failed");
  };
  if (me) return <div className="auth">{me.email} ({me.role}) <button onClick={() => { setToken(null); onChange(); }}>sign out</button></div>;
  return <div className="auth"><input value={email} onChange={(e) => setEmail(e.target.value)} /><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /><button onClick={login}>sign in / register</button> <span className="err">{msg}</span></div>;
}

function Shop({ signedIn }: { signedIn: boolean }) {
  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState(""); const [sort, setSort] = useState("id"); const [page, setPage] = useState(1);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const r = await api("GET", `/api/products?pageSize=6&page=${page}&sort=${sort}&search=${encodeURIComponent(q)}`);
    if (r.status === 200) { setItems(r.data.items); setTotal(r.data.total); }
  }, [q, sort, page]);
  useEffect(() => { load(); }, [load]);
  const lines = Object.entries(cart).filter(([, n]) => n > 0).map(([id, quantity]) => ({ productId: Number(id), quantity }));
  const checkout = async () => {
    const r = await api("POST", "/api/orders", { items: lines });
    if (r.status === 201) { setMsg(`Order #${r.data.id} placed: ${money(r.data.totalCents)}`); setCart({}); load(); }
    else setMsg(`${r.data?.error?.code}: ${r.data?.error?.message} ${JSON.stringify(r.data?.error?.details ?? "")}`);
  };
  return <section>
    <div className="bar"><input placeholder="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      <select value={sort} onChange={(e) => setSort(e.target.value)}>{["id", "newest", "name", "price_asc", "price_desc"].map((s) => <option key={s}>{s}</option>)}</select>
      <span>{total} products</span></div>
    <div className="grid">{items.map((p) => <div className="card" key={p.id}>
      <b>{p.name}</b><small>{p.sku}</small><p>{p.description}</p>
      <div>{money(p.priceCents)} · {p.stock} in stock</div>
      <button disabled={p.stock === 0} onClick={() => setCart({ ...cart, [p.id]: (cart[p.id] ?? 0) + 1 })}>add ({cart[p.id] ?? 0})</button>
    </div>)}</div>
    <div className="bar"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>prev</button> page {page} <button disabled={page * 6 >= total} onClick={() => setPage(page + 1)}>next</button></div>
    <div className="bar"><button disabled={!signedIn || !lines.length} onClick={checkout}>place order ({lines.length} lines)</button> {!signedIn && "sign in to order"} <span>{msg}</span></div>
  </section>;
}

function Orders({ signedIn }: { signedIn: boolean }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => { const r = await api("GET", "/api/orders?pageSize=20"); if (r.status === 200) setOrders(r.data.items); }, []);
  useEffect(() => { if (signedIn) load(); }, [signedIn, load]);
  const act = async (id: number, what: "pay" | "cancel", cardToken = "tok_ok") => {
    const r = await api("POST", `/api/orders/${id}/${what}`, what === "pay" ? { cardToken } : undefined);
    setMsg(r.status === 200 ? `order ${id} ${r.data.status}` : `${r.data?.error?.code}: ${r.data?.error?.message}`); load();
  };
  if (!signedIn) return <p>Sign in to see your orders.</p>;
  return <section><p>{msg}</p><table><thead><tr><th>#</th><th>status</th><th>total</th><th>items</th><th></th></tr></thead><tbody>
    {orders.map((o) => <tr key={o.id}><td>{o.id}</td><td>{o.status}</td><td>{money(o.totalCents)}</td><td>{o.items.map((i) => `${i.quantity}×#${i.productId}`).join(", ")}</td>
      <td>{o.status === "pending" && <><button onClick={() => act(o.id, "pay")}>pay</button> <button onClick={() => act(o.id, "pay", "tok_decline")}>pay (decline)</button> <button onClick={() => act(o.id, "cancel")}>cancel</button></>}</td></tr>)}
  </tbody></table></section>;
}

function Dashboard() {
  const [gw, setGw] = useState<Gw | null>(null);
  const [ver, setVer] = useState<any>(null); const [conc, setConc] = useState<any>(null); const [bench, setBench] = useState<any>(null);
  const refresh = useCallback(async () => { try { setGw(await (await fetch("/__gateway/status")).json()); } catch { setGw(null); } }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    const get = (u: string, set: (v: any) => void) => fetch(u).then((r) => (r.ok ? r.json() : null)).then(set).catch(() => set(null));
    get("/reports/verification.json", setVer); get("/reports/concurrency.json", setConc); get("/benchmarks/latest.json", setBench);
  }, []);
  const route = async (mode: string, extra: object = {}) => { await fetch("/__gateway/route", { method: "POST", body: JSON.stringify({ mode, ...extra }) }); refresh(); };
  return <section className="dash">
    <h2>Production transition</h2>
    {gw ? <>
      <div className="bar">Active backend:
        {(["node", "rust"] as const).map((m) => <button key={m} className={gw.mode === m ? "on" : ""} onClick={() => route(m)}>{m}</button>)}
        <button className={gw.mode === "canary" ? "on" : ""} onClick={() => route("canary", { canaryPercent: 25 })}>canary 25% rust</button>
        <span>health: node {String(gw.health.node.ok)} · rust {String(gw.health.rust.ok)}</span></div>
      <pre className="diagram">{`client → gateway ─┬─(${gw.mode === "node" ? "ACTIVE" : "idle"})→ Node API ──┐\n                  └─(${gw.mode === "rust" ? "ACTIVE" : gw.mode === "canary" ? "25%" : "idle"})→ Rust API ──┴→ MongoDB (shared)`}</pre>
      <p>Requests served so far: node {gw.stats.node.requests} (avg {gw.stats.node.avgMs} ms) · rust {gw.stats.rust.requests} (avg {gw.stats.rust.avgMs} ms). Browser-observed latency includes the proxy hop and is not a benchmark.</p>
      <ul>{gw.events.slice(0, 5).map((e, i) => <li key={i}>{e.ts.slice(11, 19)} {e.msg}</li>)}</ul>
    </> : <p className="err">Gateway not reachable.</p>}

    <h2>Compatibility verification</h2>
    {ver ? <><p className={ver.verified ? "ok" : "err"}><b>{ver.verified ? "VERIFIED" : "FAILED"}</b>: {ver.passed}/{ver.total} scenarios identical, generated {ver.generatedAt}</p>
      <table><tbody>{ver.groups.map((g: any) => <tr key={g.group}><td>{g.group}</td><td>{g.steps.filter((s: any) => s.pass).length}/{g.steps.length} identical</td><td>DB state {g.dbDiff.length ? "differs" : "identical"}</td></tr>)}</tbody></table></>
      : <p>No report yet. Run <code>make verify-migration</code>; this panel shows the saved result, never a hard-coded one.</p>}
    {conc && <p className={conc.pass ? "ok" : "err"}>Concurrency ({conc.customers} customers, {conc.stock} units): <b>{conc.pass ? "PASS" : "FAIL"}</b> — {conc.results.map((r: any) => `${r.backend}: ${r.created201}×201, ${r.conflicts409}×409, stock ${r.finalStock}`).join(" | ")}</p>}

    <h2>Benchmarks</h2>
    {bench ? <pre>{JSON.stringify(bench.summary ?? bench, null, 2)}</pre> : <p>No benchmark results saved yet (<code>make benchmark</code>). Official numbers are produced outside the dashboard.</p>}
  </section>;
}

function RequestLog({ log }: { log: LogEntry[] }) {
  return <footer><b>Request log</b> (which backend served each call)<table><tbody>
    {log.slice(0, 8).map((e, i) => <tr key={i}><td className={`tag ${e.servedBy}`}>{e.servedBy}</td><td>{e.method} {e.path}</td><td>{e.status}</td><td>{e.ms} ms</td></tr>)}
  </tbody></table></footer>;
}
