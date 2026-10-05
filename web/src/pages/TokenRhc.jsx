import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useWallet, cancelled } from "../lib/wallet.jsx";
import { describeRules, duration, short, eth, usd } from "../lib/format.js";
import { parseWallets } from "../lib/lists.js";
import Copy from "../lib/Copy.jsx";
import Logo from "../components/Logo.jsx";

/**
 * A Hooker token on Robinhood Chain: our curve (evm/src/HookerLaunchpad.sol), then a Pons V2 coin.
 * Every transaction comes from the API as {chainId, to, data, value}; the EVM wallet only sends it.
 */
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const units = (v) => Number(BigInt(v ?? 0) / 10n ** 12n) / 1e6; // 18 decimals → a number of whole tokens
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}M` : n.toLocaleString(undefined, { maximumFractionDigits: 0 }));

function Trade({ t, refresh }) {
  const { evmAddress, sendEvm, connect } = useWallet();
  const [side, setSide] = useState("buy");
  const [amount, setAmount] = useState("0.02");
  const [bal, setBal] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const loadBal = useCallback(() => { if (evmAddress) api.evmBalance(t.mint, evmAddress).then(setBal).catch(() => {}); }, [evmAddress, t.mint]);
  useEffect(() => { loadBal(); }, [loadBal]);

  async function go() {
    setMsg(null);
    try {
      const { address: me } = await connect("evm");
      setBusy("Preparing…");
      let tx;
      if (side === "buy") {
        if (!(Number(amount) > 0)) throw new Error("Enter an amount.");
        const q = await api.evmQuote(t.mint, { eth: String(Number(amount)) });
        tx = await api.evmBuyTx({ token: t.mint, eth: String(Number(amount)), minTokensOut: ((BigInt(q.tokens) * 97n) / 100n).toString() });
      } else {
        const b = BigInt((await api.evmBalance(t.mint, me)).amount);
        const amt = (b * BigInt(Math.round(Number(amount) * 100))) / 10_000n;
        if (amt <= 0n) throw new Error("Nothing to sell.");
        tx = await api.evmSellTx({ token: t.mint, amount: amt.toString() });
      }
      // ask the chain first: a refused trade is explained before the wallet opens
      const sim = await api.evmSimulate({ from: me, ...tx });
      if (!sim.ok) throw new Error(sim.error);
      setBusy("Approve in your wallet…");
      await sendEvm(tx, { onSent: () => setBusy("Sending…") });
      setMsg({ ok: true, text: side === "buy" ? "Bought." : "Sold." });
      loadBal(); refresh();
    } catch (e) {
      setMsg({ ok: false, text: cancelled(e) ? "Cancelled in the wallet." : e.message });
    } finally { setBusy(null); }
  }

  const isDev = same(evmAddress, t.creator);
  const listBlocked = side === "buy" && !isDev && bal && (t.rules?.allowlist ? !bal.listed : t.rules?.blocklist ? bal.listed : false);
  const quick = side === "buy" ? ["0.01", "0.02", "0.05", "0.1"] : ["25", "50", "75", "100"];
  return (
    <section className="panel trade">
      <div className="tabs">
        <button className={side === "buy" ? "on" : ""} onClick={() => { setSide("buy"); setAmount("0.02"); }}>Buy</button>
        <button className={side === "sell" ? "on sell" : ""} onClick={() => { setSide("sell"); setAmount("100"); }}>Sell</button>
      </div>
      {listBlocked ? (
        <p className="note">{t.rules.allowlist ? "Your wallet is not on this token's allowlist, so it cannot buy. You can still sell what you hold." : "Your wallet is on this token's blocklist, so it cannot buy."}</p>
      ) : (
        <>
          <div className="field">
            <span className="label">{side === "buy" ? "You pay" : "You sell"}{evmAddress && bal && <b className="mono" style={{ fontWeight: 400 }}>{side === "buy" ? eth(bal.eth, 4) : `${fmtTokens(units(bal.amount))} $${t.symbol}`}</b>}</span>
            <div className="amount"><input type="number" min="0" step={side === "buy" ? "0.01" : "5"} value={amount} onChange={(e) => setAmount(e.target.value)} /><span>{side === "buy" ? "ETH" : "%"}</span></div>
            <div className="quick">{quick.map((v) => <button type="button" key={v} className={amount === v ? "on" : ""} onClick={() => setAmount(v)}>{side === "buy" ? `${v} ETH` : `${v}%`}</button>)}</div>
          </div>
          <button className={`btn big ${side === "buy" ? "green" : ""}`} disabled={!!busy} onClick={() => { go(); }}>{busy ?? (evmAddress ? (side === "buy" ? "Buy" : "Sell") : "Connect and trade")}</button>
        </>
      )}
      {msg && <p className={msg.ok ? "good" : "err"}>{msg.text}</p>}
      <p className="hint">On Robinhood Chain, paid in ETH. A buy bigger than what is left of the curve only takes what is left, and the rest comes back.</p>
    </section>
  );
}

function CreatorPanel({ t, refresh }) {
  const { evmAddress, sendEvm } = useWallet();
  const [fees, setFees] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (same(evmAddress, t.creator)) api.evmWallet(evmAddress).then((w) => setFees(w.creatorFeesEth)).catch(() => {}); }, [evmAddress, t.creator]);
  if (!same(evmAddress, t.creator)) return null;
  const hasList = t.rules?.allowlist || t.rules?.blocklist;
  const parsed = parseWallets(text, "rhc");
  async function run(label, fn) {
    setMsg(null);
    try { setBusy(label); await fn(); refresh(); }
    catch (e) { setMsg({ ok: false, text: cancelled(e) ? "Cancelled in the wallet." : e.message }); }
    finally { setBusy(null); }
  }
  return (
    <section className="panel">
      <h3>You launched this</h3>
      <p className="hint" style={{ marginBottom: 14 }}>Your fee on every trade is collected in ETH, for all your Robinhood Chain launches together. {fees != null && <>Waiting: <b>{eth(fees, 5)}</b>.</>}</p>
      <button className="btn small ghost" disabled={!!busy || !fees} onClick={() => run("Claiming…", async () => { await sendEvm(await api.evmClaimTx()); setFees(0); setMsg({ ok: true, text: "Claimed. It is in your wallet." }); })}>Claim trading fees</button>
      {hasList && t.status === "trading" && (
        <div className="listtools">
          <h3 style={{ marginTop: 18 }}>Your {t.rules.allowlist ? "allowlist" : "blocklist"}</h3>
          <p className="hint" style={{ marginBottom: 12 }}>You can add wallets for the first day after launch, until you seal it.</p>
          <textarea rows={4} className="mono-area" value={text} onChange={(e) => setText(e.target.value)} placeholder="0x addresses, one per line" />
          {parsed.invalid.length > 0 && <p className="err" style={{ fontSize: 13 }}>Not wallet addresses: {parsed.invalid.slice(0, 3).join(", ")}</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small ghost" disabled={!!busy || !parsed.wallets.length} onClick={() => run("Adding…", async () => {
              for (let i = 0; i < parsed.wallets.length; i += 500) await sendEvm(await api.evmListTx({ token: t.mint, wallets: parsed.wallets.slice(i, i + 500) }));
              setText(""); setMsg({ ok: true, text: "Added." });
            })}>Add {parsed.wallets.length || ""} wallet{parsed.wallets.length === 1 ? "" : "s"}</button>
            <button className="btn small ghost" disabled={!!busy} onClick={() => run("Sealing…", async () => { await sendEvm(await api.evmSealTx({ token: t.mint })); setMsg({ ok: true, text: "Sealed." }); })}>Seal the list</button>
          </div>
        </div>
      )}
      {busy && <p className="hint">{busy}</p>}
      {msg && <p className={msg.ok ? "good" : "err"}>{msg.text}</p>}
    </section>
  );
}

function Trades({ t }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => api.evmTrades(t.mint).then((d) => { if (live) setList(d.trades); }).catch(() => {});
    load();
    const i = setInterval(() => { if (!document.hidden) load(); }, 6_000);
    return () => { live = false; clearInterval(i); };
  }, [t.mint]);
  if (!list?.length) return null;
  return (
    <section className="panel">
      <h3>Trades</h3>
      <div className="trades">
        {list.slice(0, 25).map((x) => (
          <a key={x.tx + x.trader + x.tokens} className={`trow ${x.isBuy ? "buy" : "sell"}`} href={`https://robinhoodchain.blockscout.com/tx/${x.tx}`} target="_blank" rel="noreferrer">
            <span className="mono">{short(x.trader)}</span>
            <b>{x.isBuy ? "Buy" : "Sell"}</b>
            <span>{eth(Number(x.eth), 4)}</span>
            <span className="muted">{fmtTokens(Number(x.tokens))}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function Launched({ t, image, onClose }) {
  const url = `${window.location.origin}/t/${t.mint}`;
  const post = `https://x.com/intent/post?text=${encodeURIComponent(`I just launched $${t.symbol} on @hookerdotfun`)}&url=${encodeURIComponent(url)}`;
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-box launched" onClick={(e) => e.stopPropagation()}>
        <Logo src={t.meta?.image} className="launched-img" lazy={false} fallback={image} blank={<div className="launched-img blank"><img src="/logo-full.png" alt="" /></div>} />
        <div className="launched-ok"><span className="vmark ok"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 7" /></svg></span>Launched</div>
        <h3 className="modal-title" style={{ marginBottom: 6 }}>Your token is live</h3>
        <p className="muted center" style={{ margin: "0 0 18px" }}><b className="tsym-in">${t.symbol}</b> is trading on Hooker, on Robinhood Chain.</p>
        <div className="launched-ca"><b>CA</b><span className="ca-addr">{t.mint}</span><Copy text={t.mint} /></div>
        <div className="launched-row">
          <a className="btn green" href={post} target="_blank" rel="noreferrer">Share on X</a>
          <button type="button" className="btn ghost" onClick={onClose}>View token</button>
        </div>
      </div>
    </div>
  );
}

export default function TokenRhc({ mint }) {
  const [search] = useSearchParams();
  const location = useLocation(), navTo = useNavigate();
  const fresh = location.state?.image ?? null;
  const [launched, setLaunched] = useState(search.get("launched") === "1");
  const closeLaunched = useCallback(() => {
    setLaunched(false);
    const q = new URLSearchParams(search); q.delete("launched");
    navTo({ search: q.toString() ? `?${q}` : "" }, { replace: true, state: location.state });
  }, [search, navTo, location.state]);
  const [t, setT] = useState(null);
  const [err, setErr] = useState(null);
  const [, tick] = useState(0);
  const load = useCallback(() => { api.evmToken(mint).then((d) => { setT(d); setErr(null); }).catch((e) => setErr(e.message)); }, [mint]);
  useEffect(() => {
    load();
    const poll = () => { if (!document.hidden) load(); };
    const a = setInterval(poll, 6_000), b = setInterval(() => tick((x) => x + 1), 1_000);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(a); clearInterval(b); document.removeEventListener("visibilitychange", poll); };
  }, [load]);

  if (err && !t) return <div className="empty" style={{ marginTop: 60 }}><span className="err">{err}</span><div><Link to="/" className="btn ghost small">All launches</Link></div></div>;
  if (!t) return <div className="empty" style={{ marginTop: 60 }}>Loading…</div>;
  const g = t.graduated;
  const onPons = g?.ponsToken;
  const windowLeft = t.rules?.earlySecs ? t.createdAt + t.rules.earlySecs - Date.now() / 1000 : 0;
  const at = t.status === "trading" ? 0 : onPons ? 1 : 0.5;
  const ruleText = describeRules({ ...t.rules, dev: t.creator }, { gradSol: t.targetEth, antiSnipe: t.antiSnipe, antiSnipeStartPct: 50, fees: t.fees, chain: "rhc" });

  return (
    <div className="token">
      {launched && <Launched t={t} image={fresh} onClose={closeLaunched} />}
      <div className="token-head">
        <Logo src={t.meta?.image} className="avatar" lazy={false} fallback={fresh} blank={<div className="avatar thumb blank"><img src="/logo-full.png" alt="" /></div>} />
        <div className="info">
          <h1>{t.name} <span className="tsym">${t.symbol}</span></h1>
          {t.meta?.description && <p className="desc">{t.meta.description}</p>}
          <div className="row">
            <span className="ca" style={{ marginTop: 0 }}><b>CA</b><span className="ca-addr">{short(t.mint)}</span><Copy text={t.mint} /></span>
            <span className="chip">Robinhood Chain</span>
            <span className="chip mono">by {short(t.creator)}</span>
            {t.meta?.twitter && <a className="ext" href={t.meta.twitter} target="_blank" rel="noreferrer">X ↗</a>}
            {t.meta?.website && <a className="ext" href={t.meta.website} target="_blank" rel="noreferrer">Website ↗</a>}
            <a className="ext" href={t.explorer} target="_blank" rel="noreferrer">Blockscout ↗</a>
          </div>
        </div>
      </div>

      {search.get("list") === "unfinished" && t.status === "trading" && (
        <p className="note" style={{ marginBottom: 16 }}>Your token is live, but filling its list did not finish. Connect the creator wallet and finish it below: you have a day.</p>
      )}
      <div className="cols">
        <div>
          <section className="panel">
            <div className="phases">
              <div className={at === 0 ? "now" : "done"}><b>01 Hooker</b>{at === 0.5 ? "Graduating" : "Bonding curve"}</div>
              <div className={at === 1 ? "now" : ""}><b>02 Pons</b>Pons coin</div>
            </div>
            {g ? (
              onPons ? (
                <>
                  <div className="grad-head"><h3>Graduated</h3></div>
                  <p className="muted grad-line">The token is now a Pons coin. {g.paid ? "Every holder has received theirs." : "Holders are being paid right now."}</p>
                  <div className="bigstats grad-stats">
                    <div><b>{usd(t.marketCapUsd)}</b><span>market cap</span></div>
                    <div><b>Pons</b><span>{g.phase === 2 ? "graduated on Pons, open market" : "on Pons's bonding curve"}</span></div>
                  </div>
                </>
              ) : (
                <>
                  <h3 style={{ fontSize: 22 }}>Graduating</h3>
                  <p className="muted" style={{ margin: 0 }}>The curve is full. The Pons coin is being launched and every holder will receive theirs automatically.</p>
                </>
              )
            ) : (
              <>
                <div className="label" style={{ marginBottom: 8 }}><span>Bonding curve</span><b>{Math.round(t.progress * 100)}%</b></div>
                <div className="bar big"><span style={{ width: `${Math.max(2, Math.round(t.progress * 100))}%` }} /></div>
                <div className="bigstats">
                  <div><b>{usd(t.marketCapUsd)}</b><span>market cap{t.marketCapEth != null ? ` · ${eth(t.marketCapEth, 2)}` : ""}</span></div>
                  <div><b>{eth(t.raisedEth, 3).replace(" ETH", "")}</b><span>of {eth(t.targetEth, 2)} raised</span></div>
                  <div><b>{Math.round(t.progress * 100)}%</b><span>to Pons</span></div>
                </div>
                {windowLeft > 0 && <p className="note" style={{ marginTop: 14 }}>Launch window: {duration(windowLeft)} left at the tighter wallet cap.</p>}
              </>
            )}
          </section>
          <section className="panel">
            <h3>Rules</h3>
            <ul className="rules">{ruleText.map((x) => <li key={x.t}><div><b>{x.t}</b>{x.d}</div></li>)}</ul>
            <p className="hint">Enforced by the token itself on Robinhood Chain. Nobody can change them.</p>
          </section>
          <Trades t={t} />
        </div>
        <aside className="sticky">
          {t.status === "trading" && <Trade t={t} refresh={load} />}
          {onPons && (
            <section className="panel grad-trade">
              <a className="btn green" href={g.ponsUrl} target="_blank" rel="noreferrer">Trade on Pons <span className="arrow">→</span></a>
              <div className="grad-links">
                <a className="btn ghost small" href={`https://robinhoodchain.blockscout.com/token/${g.ponsToken}`} target="_blank" rel="noreferrer">Blockscout ↗</a>
              </div>
            </section>
          )}
          <CreatorPanel t={t} refresh={load} />
          <p className="hint center" style={{ marginTop: 14 }}><Link to="/" className="link">← All launches</Link></p>
        </aside>
      </div>
    </div>
  );
}
