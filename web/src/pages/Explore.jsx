import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import TokenCard from "../components/TokenCard.jsx";

const SORTS = {
  newest: { label: "Newest", fn: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) },
  cap: { label: "Market cap", fn: (a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1) },
  progress: { label: "Closest to Pumpfun", fn: (a, b) => (b.progress ?? 0) - (a.progress ?? 0) },
};

/** One list: a title with its count, a line under it, sort pills on the right, then the cards. */
function Section({ title, blurb, rows, sorts, sort, setSort, empty, loading }) {
  const shown = useMemo(() => [...rows].sort(SORTS[sort].fn), [rows, sort]);
  return (
    <div className="sect">
      <div className="sect-head">
        <div>
          <h3 className="sect-title">{title}{!loading && <span className="count">{rows.length}</span>}</h3>
          <p className="muted">{blurb}</p>
        </div>
        <div className="pills">
          {sorts.map((k) => <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>{SORTS[k].label}</button>)}
        </div>
      </div>
      {loading ? <div className="empty">Reading the chain</div>
        : shown.length === 0 ? <div className="empty">{empty}</div>
        : <div className="tgrid">{shown.map((l) => <TokenCard key={l.mint} l={l} />)}</div>}
    </div>
  );
}

export default function Explore() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [curveSort, setCurveSort] = useState("newest");
  const [gradSort, setGradSort] = useState("cap");

  useEffect(() => {
    let live = true;
    const load = () => api.launches().then((d) => { if (live) { setData(d.launches); setErr(null); } }).catch((e) => { if (live) setErr(e.message); });
    load();
    const poll = () => { if (!document.hidden) load(); };
    const t = setInterval(poll, 10_000);
    document.addEventListener("visibilitychange", poll);
    return () => { live = false; clearInterval(t); document.removeEventListener("visibilitychange", poll); };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((l) => !needle || [l.meta?.name, l.name, l.meta?.symbol, l.symbol, l.mint].some((v) => v && String(v).toLowerCase().includes(needle)));
  }, [data, q]);
  // ⚠ a launch appears in exactly one list: still on our curve, or graduated into pump.fun
  // a coin launched straight on pump.fun (our $HOOKER) is "on the curve" until pump.fun's own curve fills
  const curving = (l) => l.status === "trading";
  const onCurve = filtered.filter(curving);
  const graduated = filtered.filter((l) => !curving(l));
  const loading = !data && !err;

  return (
    <div className="explore">
      <div className="chead page">
        <div className="eyebrow">Explore</div>
        <h1><span className="grad">Dashboard</span></h1>
        <p className="chead-sub">Launch with any combination of hooks and graduate into a normal Pumpfun token.</p>
        <label className="search wide">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ticker or address" />
        </label>
      </div>
      {err && !data && <p className="err center">{err}</p>}

      <Section title="Graduated" blurb="Tokens that graduated to Pumpfun."
        rows={graduated} sorts={["cap", "newest"]} sort={gradSort} setSort={setGradSort} loading={loading}
        empty={q ? "Nothing matches." : "No token has graduated yet."} />

      <Section title="On the curve" blurb="Tokens still climbing toward Pumpfun."
        rows={onCurve} sorts={["newest", "cap", "progress"]} sort={curveSort} setSort={setCurveSort} loading={loading}
        empty={data?.length ? "Nothing matches." : "Nothing has been launched yet."} />

      <div className="more" style={{ marginTop: 40 }}><Link to="/launch" className="btn green">Launch a token <span className="arrow">→</span></Link></div>
    </div>
  );
}
