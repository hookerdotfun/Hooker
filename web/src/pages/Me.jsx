import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useWallet, cancelled } from "../lib/wallet.jsx";
import { short, usd } from "../lib/format.js";
import TokenCard from "../components/TokenCard.jsx";

/** SOL with sensible precision: 0.0123, 1.25 */
const solFmt = (s) => (s >= 1 ? s.toFixed(2) : s >= 0.0001 ? s.toFixed(4) : s > 0 ? "<0.0001" : "0");

/**
 * One venue's creator rewards: what is waiting, and a Claim button that collects all of it in one approval
 * (GET /api/rewards, POST /api/tx/claim-rewards, each transaction relayed and confirmed by POST /api/send).
 */
function RewardRow({ title, sub, venue, data, solUsd, onDone }) {
  const { address, signTransactions } = useWallet();
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const total = data?.sol ?? 0;
  const parts = (data?.items ?? []).filter((x) => x.symbol !== "SOL" && venue === "pumpfun");
  async function claim() {
    setMsg(null);
    try {
      setBusy("Preparing…");
      const { txs } = await api.claimRewards({ creator: address, venue });
      setBusy(`Approve ${txs.length === 1 ? "the claim" : `${txs.length} claims`} in your wallet…`);
      const signed = await signTransactions(txs, address);
      for (let i = 0; i < signed.length; i++) { setBusy(signed.length > 1 ? `Claiming ${i + 1} of ${signed.length}…` : "Claiming…"); await api.send(signed[i]); }
      setMsg({ ok: true, text: `Claimed ${solFmt(total)} SOL${parts.length ? ` worth (incl. ${parts.map((p) => p.symbol).join(", ")})` : ""}. It is in your wallet.` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: cancelled(e) ? "Cancelled in the wallet." : e.message });
    } finally { setBusy(null); }
  }
  return (
    <div className="reward">
      <div className="reward-l">
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      <div className="reward-v">
        <b>{data ? `${solFmt(total)} SOL` : "…"}</b>
        <span>{data && solUsd ? usd(total * solUsd) : ""}{parts.length ? ` · incl. ${parts.map((p) => p.symbol).join(", ")}` : ""}</span>
      </div>
      <button type="button" className="btn green small" disabled={!data || total <= 0 || !!busy} onClick={claim}>{busy ? "Claiming…" : "Claim"}</button>
      {(busy || msg) && <p className={`reward-msg ${msg?.ok ? "good" : msg ? "err" : "hint"}`}>{busy ?? msg.text}</p>}
    </div>
  );
}

export default function Me() {
  const { address, connect } = useWallet();
  const [w, setW] = useState(null);
  const [all, setAll] = useState(null);
  const [rw, setRw] = useState(null);
  const [err, setErr] = useState(null);
  const loadRewards = useCallback(() => { if (address) api.rewards(address).then(setRw).catch(() => {}); }, [address]);
  useEffect(() => {
    if (!address) return;
    api.wallet(address).then(setW).catch((e) => setErr(e.message));
    api.launches().then((d) => setAll(d.launches)).catch(() => {});
    loadRewards();
  }, [address, loadRewards]);

  if (!address) return (
    <div className="empty" style={{ marginTop: 60 }}>
      Connect a wallet to see your launches and rewards.
      <div><button className="btn green small" onClick={() => { connect().catch(() => {}); }}>Connect</button></div>
    </div>
  );
  const byMint = Object.fromEntries((all ?? []).map((l) => [l.mint, l]));
  return (
    <div>
      <div className="page-head center">
        <div className="eyebrow">My tokens</div>
        <h1 style={{ fontSize: "clamp(38px, 6vw, 72px)" }}>Your <span className="grad">launches</span></h1>
      </div>
      {err && <p className="err center">{err}</p>}

      {/* creator rewards: Meteora (Hooker curves) and pump.fun (graduated coins), each claimed in one approval */}
      <section className="panel rewards">
        <h3>Creator rewards</h3>
        <RewardRow venue="meteora" title="Hooker" sub="Creator fees from your coins on Hooker." data={rw?.meteora} solUsd={rw?.solUsd} onDone={loadRewards} />
        <RewardRow venue="pumpfun" title="Pumpfun" sub="Creator fees from your coins on Pumpfun and PumpSwap." data={rw?.pumpfun} solUsd={rw?.solUsd} onDone={loadRewards} />
      </section>

      <div className="section-head center" style={{ margin: "44px 0 16px" }}><div><h3 style={{ fontSize: 22, margin: 0 }}>Launched by you {w && <span className="count">{w.created.length}</span>}</h3></div></div>
      {w?.created.length
        ? <div className="tgrid">{w.created.map((m) => byMint[m] ? <TokenCard key={m} l={byMint[m]} /> : <Link key={m} to={`/t/${m}`} className="tc"><span className="mono" style={{ padding: 14 }}>{short(m)}</span></Link>)}</div>
        : <div className="empty">None yet.<div><Link to="/launch" className="btn green small">Launch a token</Link></div></div>}
    </div>
  );
}
