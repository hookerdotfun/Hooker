import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useWallet, cancelled } from "../lib/wallet.jsx";
import { short, usd, eth, amt } from "../lib/format.js";
import TokenCard from "../components/TokenCard.jsx";
import { useMode } from "../lib/mode.jsx";

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

/** Robinhood Chain: the creator's fee from every Pons launch, kept in ETH by the launchpad, claimed in one transaction. */
function EvmRewardRow({ data, ethUsd, onDone }) {
  const { sendEvm } = useWallet();
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const fees = (data?.creatorFees ?? []).filter((f) => f.amount > 0);
  const total = data?.creatorFeesEth ?? 0;
  async function claim() {
    setMsg(null);
    try {
      // one claim per asset the creator earned in (each asset is its own launchpad)
      const todo = fees.length ? fees : [{ symbol: "ETH", amount: total }];
      for (const f of todo) { setBusy(`Approve the ${f.symbol} claim in your wallet…`); await sendEvm(await api.evmClaimTx({ quote: f.symbol }), { onSent: () => setBusy("Claiming…") }); }
      setMsg({ ok: true, text: `Claimed ${todo.map((f) => amt(f.amount, f.symbol, 5)).join(" and ")}. It is in your wallet.` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: cancelled(e) ? "Cancelled in the wallet." : e.message });
    } finally { setBusy(null); }
  }
  return (
    <div className="reward">
      <div className="reward-l"><b>Hooker</b><span>Creator fees from your coins before they graduate into Pons.</span></div>
      <div className="reward-v"><b>{data ? (fees.length ? fees.map((f) => amt(f.amount, f.symbol, 5)).join(" + ") : eth(total, 5)) : "…"}</b><span>{data && ethUsd && !fees.some((f) => f.symbol !== "ETH") ? usd(total * ethUsd) : ""}</span></div>
      <button type="button" className="btn green small" disabled={!data || (total <= 0 && !fees.length) || !!busy} onClick={claim}>{busy ? "Claiming…" : "Claim"}</button>
      {(busy || msg) && <p className={`reward-msg ${msg?.ok ? "good" : msg ? "err" : "hint"}`}>{busy ?? msg.text}</p>}
    </div>
  );
}

export default function Me() {
  const { address, evmAddress, connect } = useWallet();
  const { pons, walletKind } = useMode();
  const [ew, setEw] = useState(null);
  const [ethUsd, setEthUsd] = useState(null);
  const loadEvm = useCallback(() => { if (evmAddress) api.evmWallet(evmAddress).then(setEw).catch(() => {}); }, [evmAddress]);
  useEffect(() => { loadEvm(); if (evmAddress) api.evmInfo().then((i) => setEthUsd(i.ethUsd)).catch(() => {}); }, [evmAddress, loadEvm]);
  const [w, setW] = useState(null);
  const [all, setAll] = useState(null);
  const [rw, setRw] = useState(null);
  const [err, setErr] = useState(null);
  const loadRewards = useCallback(() => { if (address) api.rewards(address).then(setRw).catch(() => {}); }, [address]);
  useEffect(() => {
    if (address || evmAddress) api.launches().then((d) => setAll(d.launches)).catch(() => {});
    if (!address) return;
    api.wallet(address).then(setW).catch((e) => setErr(e.message));
    loadRewards();
  }, [address, evmAddress, loadRewards]);

  // only this mode's wallet, rewards and launches
  const mine = pons ? evmAddress : address;
  if (!mine) return (
    <div className="empty" style={{ marginTop: 60 }}>
      {pons ? "Connect an EVM wallet to see your Pons launches and rewards on Robinhood Chain." : "Connect a Solana wallet to see your Pumpfun launches and rewards."}
      <div><button className="btn green small" onClick={() => { connect(walletKind).catch(() => {}); }}>Connect</button></div>
    </div>
  );
  const byMint = Object.fromEntries((all ?? []).map((l) => [l.mint, l]));
  const mineData = pons ? ew : w;
  const created = mineData?.created ?? [];
  return (
    <div>
      <div className="page-head center">
        <div className="eyebrow">My tokens</div>
        <h1 style={{ fontSize: "clamp(38px, 6vw, 72px)" }}>Your <span className="grad">launches</span></h1>
      </div>
      {err && <p className="err center">{err}</p>}

      {/* creator rewards for this mode: Hooker curve + Pumpfun on Solana, or the Robinhood Chain curve + Pons */}
      <section className="panel rewards">
        <h3>Creator rewards</h3>
        {pons ? (
          <EvmRewardRow data={ew} ethUsd={ethUsd} onDone={loadEvm} />
        ) : (
          <>
            <RewardRow venue="meteora" title="Hooker" sub="Creator fees from your coins on Hooker." data={rw?.meteora} solUsd={rw?.solUsd} onDone={loadRewards} />
            <RewardRow venue="pumpfun" title="Pumpfun" sub="Creator fees from your coins on Pumpfun and PumpSwap." data={rw?.pumpfun} solUsd={rw?.solUsd} onDone={loadRewards} />
          </>
        )}
      </section>

      <div className="section-head center" style={{ margin: "44px 0 16px" }}><div><h3 style={{ fontSize: 22, margin: 0 }}>Launched by you {mineData && <span className="count">{created.length}</span>}</h3></div></div>
      {created.length
        ? <div className="tgrid">{created.map((m) => byMint[m] ? <TokenCard key={m} l={byMint[m]} /> : <Link key={m} to={`/t/${m}`} className="tc"><span className="mono" style={{ padding: 14 }}>{short(m)}</span></Link>)}</div>
        : <div className="empty">{pons ? "No Pons launches yet." : "No Pumpfun launches yet."}<div><Link to="/launch" className="btn green small">Launch a token</Link></div></div>}
    </div>
  );
}
