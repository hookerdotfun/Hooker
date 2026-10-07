import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useMode, inMode } from "../lib/mode.jsx";

// ── the live trades box (real chain data only; the old simulated feed is gone) ─────────────────────────

export function Mark({ ok }) {
  return (
    <span className={`vmark ${ok ? "ok" : "no"}`}>
      {ok
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 7" /></svg>
        : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>}
    </span>
  );
}

export function Row({ r }) {
  return (
    <div className={`feed-row ${r.ok ? "" : "is-no"}`}>
      <Mark ok={r.ok} />
      <span className="what">{r.a}{r.why && <span className="why">{r.why}</span>}</span>
      <span className="who">{r.who}</span>
      <span className={`verdict ${r.ok ? "ok" : "no"}`}>{r.ok ? "passed" : "refused"}</span>
    </div>
  );
}

/**
 * The trades box on /docs: REAL transactions on the Hooker tokens trading now (GET /api/trades), never simulated.
 * Landed buys and sells, and refusals that landed as failed transactions, with the hook's reason.
 */
const fmtSol = (s) => (s >= 1 ? s.toFixed(2) : s >= 0.01 ? s.toFixed(3) : s.toFixed(4));
// a Robinhood Chain trade carries {amount, unit: "ETH"}; a Solana one {sol}
const toRow = (t) => ({
  id: t.sig, ok: t.ok, who: t.who,
  a: t.kind === "buy" ? `Buys $${t.symbol} for ${fmtSol(t.amount ?? t.sol)} ${t.unit ?? "SOL"}` : t.kind === "sell" ? `Sells $${t.symbol} for ${fmtSol(t.amount ?? t.sol)} ${t.unit ?? "SOL"}` : `A trade on $${t.symbol}`,
  why: t.ok ? null : t.why,
});
export function Feed() {
  const { chain, venue } = useMode();
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    const load = () => api.trades(chain).then((d) => { if (live) setData(d); }).catch(() => {});
    load();
    const poll = () => { if (!document.hidden) load(); };
    const t = setInterval(poll, 10_000);
    document.addEventListener("visibilitychange", poll);
    return () => { live = false; clearInterval(t); document.removeEventListener("visibilitychange", poll); };
  }, [chain]);
  // an older API mixes both chains: keep this mode's rows either way
  const rows = (data?.trades ?? []).filter((t) => inMode(t, chain)).map(toRow);
  const refused = rows.filter((r) => !r.ok).length;
  return (
    <div className="feed">
      <div className="feed-head">
        <span className="live"><i />Trades</span>
        <span>Checked<b>{rows.length}</b> &nbsp; <span className="bad">Refused<b>{refused}</b></span></span>
      </div>
      <div className="feed-rows">
        {rows.map((r, i) => <Row key={`${r.id}:${i}`} r={r} />)}
        {data && rows.length === 0 && <div className="feed-empty">{data.tokens ? "No trades on the live tokens yet. Each one shows up here as it lands." : `No ${venue} token is trading on Hooker right now. Every trade shows up here as it lands.`}</div>}
        {!data && <div className="feed-empty">Reading the chain…</div>}
      </div>
    </div>
  );
}

/** A small drawing of each venue: our curve, pump.fun's curve after it, PumpSwap's open market. */
export function Curve({ kind }) {
  const paths = [
    "M4 70 C 60 68, 110 58, 150 40 S 205 10, 226 10",
    "M4 64 C 50 62, 90 54, 130 44 S 200 22, 226 18",
    "M4 50 C 30 34, 50 58, 80 40 S 120 20, 150 34 S 195 14, 226 24",
  ];
  const dot = [[226, 10], [226, 18], [226, 24]][kind];
  return (
    <svg className="jcurve" viewBox="0 0 240 76" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`jc${kind}`} x1="0" x2="1"><stop offset="0" style={{ stopColor: "var(--accent)" }} stopOpacity=".15" /><stop offset="1" style={{ stopColor: "var(--accent-2)" }} /></linearGradient>
        <linearGradient id={`jf${kind}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" style={{ stopColor: "var(--accent)" }} stopOpacity=".22" /><stop offset="1" style={{ stopColor: "var(--accent)" }} stopOpacity="0" /></linearGradient>
      </defs>
      <path d={`${paths[kind]} H 240 V 76 H 4 Z`} fill={`url(#jf${kind})`} />
      <path d={paths[kind]} fill="none" stroke={`url(#jc${kind})`} strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={dot[0]} cy={dot[1]} r="3.5" style={{ fill: "var(--accent-5)" }} />
    </svg>
  );
}

