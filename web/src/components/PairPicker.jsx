import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { usd } from "../lib/format.js";

/** A pair's icon, or its first letter when the icon does not load (never a broken image). */
function PairIcon({ p, size = 34 }) {
  const [bad, setBad] = useState(false);
  if (!p?.icon || bad) return <span className="pair-ico blank" style={{ width: size, height: size }}>{(p?.symbol ?? "S").replace("$", "").slice(0, 1)}</span>;
  return <img className="pair-ico" src={p.icon} alt="" width={size} height={size} onError={() => setBad(true)} />;
}
export { PairIcon };

const SOL = { mint: null, symbol: "SOL", name: "Solana", icon: null };
/** A token price: $85.3k, $2.71, $0.0042 (a sub-cent price never reads "$0"). */
const price = (p) => (p >= 1 ? usd(p) : p >= 0.01 ? `$${p.toFixed(2)}` : `$${p.toPrecision(2).replace(/^0/, "0")}`);

/**
 * "Pair on Pumpfun": SOL (default) or one of pump.fun's custom pairs with ≥ $1M liquidity (GET /api/pairs).
 * The pair applies to the Pumpfun coin the token graduates into.
 */
export default function PairPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [pairs, setPairs] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => { if (open && !pairs) api.pairs().then((d) => setPairs(d.pairs)).catch((e) => setErr(e.message)); }, [open, pairs]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (pairs ?? []).filter((p) => !n || [p.symbol, p.name, p.mint].some((v) => v && v.toLowerCase().includes(n)));
  }, [pairs, q]);
  const cur = value ?? SOL;
  const pick = (p) => { onChange(p.mint ? p : null); setOpen(false); setQ(""); };

  return (
    <>
      <button type="button" className="pair-pick" onClick={() => setOpen(true)}>
        {cur.mint ? <PairIcon p={cur} size={26} /> : <span className="pair-ico sol">◎</span>}
        <span className="pair-pick-t"><b>{cur.symbol}</b><span>{cur.mint ? cur.name : "the default"}</span></span>
        <span className="pair-pick-go">Change</span>
      </button>
      {open && (
        <div className="modal" onClick={() => setOpen(false)}>
          <div className="modal-box pair-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Select custom pair</h3>
            <label className="search wide" style={{ marginBottom: 10 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for a custom pair" />
            </label>
            <div className="pair-list">
              {!q && <button type="button" className={`pair-row ${!value ? "on" : ""}`} onClick={() => pick(SOL)}><span className="pair-ico sol">◎</span><span className="pair-n"><b>Solana</b><span>SOL · the default</span></span><span /></button>}
              {err && <p className="err">{err}</p>}
              {!pairs && !err && <p className="hint center">Loading Pumpfun's custom pairs…</p>}
              {shown.map((p) => (
                <button type="button" key={p.mint} className={`pair-row ${value?.mint === p.mint ? "on" : ""}`} onClick={() => pick(p)}>
                  <PairIcon p={p} />
                  <span className="pair-n"><b>{p.name || p.symbol}</b><span>{p.symbol}</span></span>
                  <span className="pair-v"><b>{p.usdPrice ? price(p.usdPrice) : ""}</b><span>Liquidity · {usd(p.liquidity)}</span></span>
                </button>
              ))}
              {pairs && shown.length === 0 && <p className="hint center">Nothing matches.</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
