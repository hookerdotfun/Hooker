import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useWallet, cancelled } from "../lib/wallet.jsx";
import { describeRules, duration, short, sol, usd, tokens } from "../lib/format.js";
import Copy from "../lib/Copy.jsx";
import Logo from "../components/Logo.jsx";
import { parseWallets, fillList } from "../lib/lists.js";
import TokenRhc from "./TokenRhc.jsx";

function Trade({ t, refresh }) {
  const { address, connect, signTransaction } = useWallet();
  const [side, setSide] = useState("buy");
  const [amount, setAmount] = useState("0.5");
  const [bal, setBal] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const loadBal = useCallback(() => {
    if (!address) return;
    api.balance(t.mint, address).then(setBal).catch(() => {});
  }, [address, t.mint]);
  useEffect(() => { loadBal(); }, [loadBal]);
  const [onList, setOnList] = useState(null);
  useEffect(() => {
    if (!address || !t.list) { setOnList(null); return; }
    api.listed(t.mint, address).then((x) => setOnList(x.listed)).catch(() => {});
  }, [address, t.mint, t.list]);

  async function go() {
    setMsg(null);
    try {
      const { acct } = await connect();
      let units;
      if (side === "buy") units = BigInt(Math.round(Number(amount) * 1e9));
      else {
        const b = BigInt((await api.balance(t.mint, acct.address)).amount);
        units = (b * BigInt(Math.round(Number(amount) * 100))) / 10_000n;
      }
      if (units <= 0n) throw new Error("Enter an amount.");
      setBusy("Preparing…");
      const built = await api.swapTx({ mint: t.mint, owner: acct.address, side, amount: units.toString() });
      setBusy("Approve in your wallet…");
      const signed = await signTransaction(built.tx, acct.address);
      setBusy("Sending…");
      await api.send(signed);
      setMsg({ ok: true, text: side === "buy" ? "Bought." : "Sold." });
      loadBal(); refresh();
    } catch (e) {
      setMsg({ ok: false, text: cancelled(e) ? "Cancelled in the wallet." : e.message });
    } finally {
      setBusy(null);
    }
  }

  const isDev = address && address === t.creator;
  const listBlocked = side === "buy" && !isDev && t.list && onList !== null && (t.list.kind === "allow" ? !onList : onList);
  const buyBlocked = side === "buy" && (t.rules?.fomoOnly || t.rules?.appOnly || listBlocked);
  const quick = side === "buy" ? ["0.1", "0.5", "1", "2"] : ["25", "50", "75", "100"];
  return (
    <section className="panel trade">
      <div className="tabs">
        <button className={side === "buy" ? "on" : ""} onClick={() => { setSide("buy"); setAmount("0.5"); }}>Buy</button>
        <button className={side === "sell" ? "on sell" : ""} onClick={() => { setSide("sell"); setAmount("100"); }}>Sell</button>
      </div>
      {buyBlocked ? (
        <p className="note">{listBlocked ? (t.list.kind === "allow" ? "Your wallet is not on this token's allowlist, so it cannot buy. You can still sell what you hold." : "Your wallet is on this token's blocklist, so it cannot buy.")
          : t.rules.fomoOnly ? "This token can only be bought in the FOMO app. Search for it there by its address." : "This token can only be bought inside its app."}</p>
      ) : (
        <>
          <div className="field">
            <span className="label">{side === "buy" ? "You pay" : "You sell"}{address && bal && <b className="mono" style={{ fontWeight: 400 }}>{side === "buy" ? sol(bal.sol, 3) : `${tokens(bal.amount)} $${t.meta?.symbol ?? t.symbol}`}</b>}</span>
            <div className="amount"><input type="number" min="0" step={side === "buy" ? "0.1" : "5"} value={amount} onChange={(e) => setAmount(e.target.value)} /><span>{side === "buy" ? "SOL" : "%"}</span></div>
            <div className="quick">{quick.map((v) => <button type="button" key={v} className={amount === v ? "on" : ""} onClick={() => setAmount(v)}>{side === "buy" ? `${v} SOL` : `${v}%`}</button>)}</div>
          </div>
          <button className={`btn big ${side === "buy" ? "green" : ""}`} disabled={!!busy} onClick={() => { go(); }}>{busy ?? (side === "buy" ? "Buy" : "Sell")}</button>
        </>
      )}
      {msg && <p className={msg.ok ? "good" : "err"}>{msg.text}</p>}
      <p className="hint">A buy bigger than what is left of the curve only takes what is left.</p>
    </section>
  );
}

function ListTools({ t, refresh }) {
  const { address, signTransactions } = useWallet();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const now = Date.now() / 1000;
  if (!t.list || t.list.sealed) return null;
  const open = now < t.list.openUntil;
  const parsed = parseWallets(text);
  async function go(seal) {
    setMsg(null);
    try {
      const { tooLate } = await fillList({ mint: t.mint, creator: address, wallets: open ? parsed.wallets : [], seal, signTransactions, onProgress: setBusy });
      setText("");
      setMsg({ ok: true, text: `${seal ? "Sealed." : "Added."}${tooLate.length ? ` ${tooLate.length} wallet${tooLate.length === 1 ? "" : "s"} sort below the last one already listed and cannot be added any more.` : ""}` });
      refresh();
    } catch (e) { setMsg({ ok: false, text: cancelled(e) ? "Cancelled in the wallet." : e.message }); }
    finally { setBusy(null); }
  }
  return (
    <div className="listtools">
      <h3 style={{ marginTop: 18 }}>Your {t.list.kind === "allow" ? "allowlist" : "blocklist"}</h3>
      <p className="hint" style={{ marginBottom: 12 }}>{t.list.count} wallet{t.list.count === 1 ? "" : "s"} on it, not sealed. {open ? "You can add wallets for the first day after launch, then seal it for good." : "The day to add wallets is over; you can still seal it."}</p>
      {open && <textarea rows={4} className="mono-area" value={text} onChange={(e) => setText(e.target.value)} placeholder="Wallet addresses, one per line" />}
      {parsed.invalid.length > 0 && <p className="err" style={{ fontSize: 13 }}>Not wallet addresses: {parsed.invalid.slice(0, 3).join(", ")}</p>}
      <div className="row" style={{ marginTop: 10 }}>
        {open && <button className="btn small ghost" disabled={!!busy || !parsed.wallets.length} onClick={() => { go(false); }}>Add {parsed.wallets.length || ""} wallet{parsed.wallets.length === 1 ? "" : "s"}</button>}
        <button className="btn small ghost" disabled={!!busy} onClick={() => { go(true); }}>{parsed.wallets.length && open ? "Add and seal" : "Seal the list"}</button>
      </div>
      {busy && <p className="hint">{busy}</p>}
      {msg && <p className={msg.ok ? "good" : "err"}>{msg.text}</p>}
    </div>
  );
}

function CreatorPanel({ t, refresh }) {
  const { address, signTransaction } = useWallet();
  const [msg, setMsg] = useState(null);
  if (address !== t.creator) return null;
  async function claim() {
    setMsg(null);
    try {
      const built = await api.claimTx({ mint: t.mint, creator: address });
      await api.send(await signTransaction(built.tx, address));
      setMsg({ ok: true, text: "Claimed." });
    } catch (e) { setMsg({ ok: false, text: cancelled(e) ? "Cancelled in the wallet." : e.message }); }
  }
  return (
    <section className="panel">
      <h3>You launched this</h3>
      <p className="hint" style={{ marginBottom: 14 }}>You earn half of the trading fee on every trade, after Meteora's cut. Claim it any time.</p>
      <button className="btn small ghost" onClick={() => { claim(); }}>Claim trading fees</button>
      {msg && <p className={msg.ok ? "good" : "err"}>{msg.text}</p>}
      <ListTools t={t} refresh={refresh} />
    </section>
  );
}

/** Right after a creator's launch (?launched=1): the token is live. CA to copy, a post for X, then the page. */
function Launched({ t, image, onClose }) {
  const sym = t.meta?.symbol ?? t.symbol;
  const url = `${window.location.origin}/t/${t.mint}`;
  const post = `https://x.com/intent/post?text=${encodeURIComponent(`I just launched $${sym} on @hookerdotfun`)}&url=${encodeURIComponent(url)}`;
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
        <p className="muted center" style={{ margin: "0 0 18px" }}><b className="tsym-in">${sym}</b> is trading on Hooker.</p>
        <div className="launched-ca"><b>CA</b><span className="ca-addr">{t.mint}</span><Copy text={t.mint} /></div>
        <div className="launched-row">
          <a className="btn green" href={post} target="_blank" rel="noreferrer">Share on X</a>
          <button type="button" className="btn ghost" onClick={onClose}>View token</button>
        </div>
      </div>
    </div>
  );
}

function Phases({ t }) {
  // which venue prices it now: our curve, pump.fun's curve, or PumpSwap
  const at = t.status === "trading" ? 0 : t.venue === "PumpSwap" ? 2 : t.venue === "pump.fun" ? 1 : 0.5;
  const cls = (i) => (at === i ? "now" : at > i ? "done" : "");
  return (
    <div className="phases">
      <div className={at === 0.5 ? "now" : cls(0)}><b>01 Hooker</b>{at === 0.5 ? "Graduating" : "Bonding curve"}</div>
      <div className={cls(1)}><b>02 Pumpfun</b>Pumpfun curve</div>
      <div className={cls(2)}><b>03 PumpSwap</b>Migrated</div>
    </div>
  );
}

/** A 0x address is a Robinhood Chain launch (Pons); anything else is a Solana mint. */
export default function Token() {
  const { mint } = useParams();
  return /^0x[0-9a-fA-F]{40}$/.test(mint) ? <TokenRhc key={mint} mint={mint} /> : <TokenSol key={mint} mint={mint} />;
}

function TokenSol({ mint }) {
  const [search] = useSearchParams();
  const location = useLocation(), navTo = useNavigate();
  const fresh = location.state?.image ?? null; // the image the creator just picked, until IPFS serves it
  const [launched, setLaunched] = useState(search.get("launched") === "1");
  const closeLaunched = useCallback(() => {
    setLaunched(false);
    const q = new URLSearchParams(search); q.delete("launched");
    navTo({ search: q.toString() ? `?${q}` : "" }, { replace: true, state: location.state });
  }, [search, navTo, location.state]);
  const [t, setT] = useState(null);
  const [err, setErr] = useState(null);
  const [skew, setSkew] = useState(0);
  const [, tick] = useState(0);

  const load = useCallback(() => {
    api.token(mint).then((d) => { setT(d); if (d.chainTime) setSkew(d.chainTime - Date.now() / 1000); setErr(null); }).catch((e) => setErr(e.message));
  }, [mint]);
  useEffect(() => {
    load();
    const poll = () => { if (!document.hidden) load(); };
    const a = setInterval(poll, 8_000), b = setInterval(() => tick((x) => x + 1), 1_000);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(a); clearInterval(b); document.removeEventListener("visibilitychange", poll); };
  }, [load]);

  if (err && !t) return <div className="empty" style={{ marginTop: 60 }}><span className="err">{err}</span><div><Link to="/" className="btn ghost small">All launches</Link></div></div>;
  if (!t) return <div className="empty" style={{ marginTop: 60 }}>Loading…</div>;
  // ⚠ the chain's clock, not this browser's (they drift; the hook reads the chain's)
  const now = Date.now() / 1000 + skew;
  const windowLeft = t.rules?.earlySecs ? t.rules.launchTs + t.rules.earlySecs - now : 0;
  const g = t.graduated;
  const sym = t.meta?.symbol ?? t.symbol;

  return (
    <div className="token">
      {launched && <Launched t={t} image={fresh} onClose={closeLaunched} />}
      <div className="token-head">
        <Logo src={t.meta?.image} className="avatar" lazy={false} fallback={fresh} blank={<div className="avatar thumb blank"><img src="/logo-full.png" alt="" /></div>} />
        <div className="info">
          <h1>{t.meta?.name ?? t.name} <span className="tsym">${sym}</span></h1>
          {t.meta?.description && <p className="desc">{t.meta.description}</p>}
          <div className="row">
            <span className="ca" style={{ marginTop: 0 }}><b>CA</b><span className="ca-addr">{short(t.mint)}</span><Copy text={t.mint} /></span>
            <span className="chip mono">by {short(t.creator)}</span>
            {t.meta?.twitter && <a className="ext" href={t.meta.twitter} target="_blank" rel="noreferrer">X ↗</a>}
            {t.meta?.telegram && <a className="ext" href={t.meta.telegram} target="_blank" rel="noreferrer">Telegram ↗</a>}
            {t.meta?.website && <a className="ext" href={t.meta.website} target="_blank" rel="noreferrer">Website ↗</a>}
            <a className="ext" href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noreferrer">Solscan ↗</a>
          </div>
        </div>
      </div>

      {search.get("list") === "unfinished" && t.list && !t.list.sealed && (
        <p className="note" style={{ marginBottom: 16 }}>Your token is live, but filling its list did not finish. Connect the creator wallet and finish it below: you have a day.</p>
      )}
      <div className="cols">
        <div>
          <section className="panel">
            <Phases t={t} />
            {g ? (
              g.status === "done" || g.pumpMint ? (
                <>
                  <div className="grad-head">
                    <h3>Graduated</h3>
                  </div>
                  <p className="muted grad-line">{t.venue === "PumpSwap" ? "The token is now trading on PumpSwap." : "The token is now trading on Pumpfun's curve."} {t.native ? "" : g.status === "done" ? "Every holder has received theirs." : "Holders are being paid right now."}</p>
                  <div className="bigstats grad-stats">
                    <div><b>{usd(t.marketCapUsd)}</b><span>market cap</span></div>
                    <div><b>{t.venue === "PumpSwap" ? "PumpSwap" : "Pumpfun"}</b><span>{t.venue === "PumpSwap" ? "migrated, open market" : "on its bonding curve"}</span></div>
                  </div>
                </>
              ) : (
                <>
                  <h3 style={{ fontSize: 22 }}>Graduating</h3>
                  <p className="muted" style={{ margin: 0 }}>The curve is full. The Pumpfun coin is being launched and every holder will receive theirs automatically.</p>
                </>
              )
            ) : (
              <>
                <div className="label" style={{ marginBottom: 8 }}><span>Bonding curve</span><b>{Math.round(t.progress * 100)}%</b></div>
                <div className="bar big"><span style={{ width: `${Math.max(2, Math.round(t.progress * 100))}%` }} /></div>
                <div className="bigstats">
                  <div><b>{usd(t.marketCapUsd)}</b><span>market cap{t.marketCapSol != null ? ` · ${sol(t.marketCapSol, 1)}` : ""}</span></div>
                  <div><b>{sol(t.raisedSol, 2).replace(" SOL", "")}</b><span>of {sol(t.targetSol, 1)} raised</span></div>
                  <div><b>{Math.round(t.progress * 100)}%</b><span>to Pumpfun</span></div>
                </div>
                {windowLeft > 0 && <p className="note" style={{ marginTop: 14 }}>Launch window: {duration(windowLeft)} left at the tighter wallet cap.</p>}
              </>
            )}
          </section>
          {!t.native && <section className="panel">
            <h3>Rules</h3>
            {t.list && (
              <p className="note" style={{ marginBottom: 12 }}>
                {t.list.kind === "allow" ? "Allowlist" : "Blocklist"}: {t.list.count} wallet{t.list.count === 1 ? "" : "s"}, {t.list.sealed ? "sealed for good." : `still open to the creator until ${new Date(t.list.openUntil * 1000).toLocaleString()}.`}
              </p>
            )}
            {t.pair?.state === "fallback" && <p className="note" style={{ marginBottom: 12 }}>It was set to pair with {t.pair.symbol ?? "a custom pair"} on Pumpfun, but at graduation {t.pair.note ?? "the pair no longer qualified"}, so it paired with SOL instead.</p>}
            <ul className="rules">{describeRules(t.rules, { gradSol: t.gradSol, antiSnipe: t.antiSnipe, antiSnipeStartPct: t.antiSnipeStartPct ?? 50, fees: t.fees, pair: t.pair && t.pair.state !== "fallback" ? { symbol: t.pair.symbol ?? `${t.pair.mint.slice(0, 4)}…`, creatorFeeBps: t.pair.creatorFeeBps, toHolders: !!t.rules?.holderRewards } : null }).map((x) => <li key={x.t}><div><b>{x.t}</b>{x.d}</div></li>)}</ul>
            <p className="hint">Enforced by the token itself on Solana. Nobody can change them.</p>
          </section>}
        </div>
        <aside className="sticky">
          {!g && <Trade t={t} refresh={load} />}
          {g?.pumpMint && (
            <section className="panel grad-trade">
              <a className="btn green" href={g.pumpUrl} target="_blank" rel="noreferrer">Trade on Pumpfun <span className="arrow">→</span></a>
              <div className="grad-links">
                <a className="btn ghost small" href={`https://dexscreener.com/solana/${g.pumpMint}`} target="_blank" rel="noreferrer">DexScreener ↗</a>
                <a className="btn ghost small" href={`https://solscan.io/token/${g.pumpMint}`} target="_blank" rel="noreferrer">Solscan ↗</a>
              </div>
            </section>
          )}
          {!t.native && <CreatorPanel t={t} refresh={load} />}
          <p className="hint center" style={{ marginTop: 14 }}><Link to="/" className="link">← All launches</Link></p>
        </aside>
      </div>
    </div>
  );
}
