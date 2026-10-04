import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { usd } from "../lib/format.js";
import { Feed, Curve } from "../components/Feed.jsx";
import Picker from "../components/Picker.jsx";
import { rulesFor } from "../lib/catalog.js";

const SECTIONS = [
  ["Hooks", "Every Hooker token is a Solana Token-2022 token with a transfer hook. Solana runs the hook on every buy, sell and transfer, and a trade that breaks the token's rules never lands. The rules are a part of the token and are fixed at launch."],
  ["Bonding curve", "New tokens launched on a Meteora bonding curve are shaped exactly like Pumpfun’s, so market cap and pricing works the same way.\n\nTrading costs 1% per trade. If the creator enables the anti-snipe fee it starts at 50% and gradually drops to 1% over the first two minutes, making early sniping expensive."],
  ["Graduation", "When the curve fills the hook is removed and the token graduates to Pumpfun. In the same transaction, the SOL from the curve is used to create and buy a new Pumpfun coin. This happens before anyone can buy in, so existing holders receive their share automatically and no one can get ahead of them. Each holder receives their allocation directly in their wallet."],
  ["Fees", "Every token starts with a 1% fee, split between the creator and Hooker after Meteora's share. Creators can raise their fee to up to 3%. At graduation, Hooker's share tops every holder up to one Pumpfun coin per token they held."],
];

// the rules every launch can carry come from the catalog; these are the promises that hold for all of them
const ALWAYS = [
  ["The creator's wallet", "Exempt from the caps and buy rules, so it can make its buy at launch. Every token page names it."],
  ["Holders can always sell", "No rule ever blocks a sale back into the curve."],
  ["Settled at graduation", "Whichever of size fee, auto burn and holder share the creator picked are applied from the token's public trade history when it graduates, so anyone can recompute every payout."],
];

export default function How() {
  const [info, setInfo] = useState(null);
  useEffect(() => { api.info().then(setInfo).catch(() => {}); }, []);
  const money = (capSol) => (info?.solUsd ? usd(capSol * info.solUsd) : "–");
  return (
    <>
      <div className="page-head center">
        <div className="eyebrow">Docs</div>
        <h1 style={{ fontSize: "clamp(38px, 6vw, 72px)" }}>How <span className="grad">Hooker</span> works</h1>
        <p className="lede">Launch a token with rules built into it, trade on a Meteora bonding curve identical to Pumpfun's and graduate into a normal Pumpfun token.</p>
      </div>
      <div className="steps">
        {SECTIONS.map(([t, d], i) => <div className="step" key={t}><span className="n">0{i + 1}</span><h3>{t}</h3>{d.split("\n\n").map((para) => <p key={para}>{para}</p>)}</div>)}
      </div>
      <section className="section how-sim">
        <div className="how-sim-copy">
          <div className="eyebrow">Verifiable</div>
          <h2>The rules live in the <span className="grad">token</span>.</h2>
          <p className="lede">Every Hooker token is a Token-2022 token with a built-in transfer hook. Solana checks the rules on every buy, sell and transfer, so any transaction that breaks them simply fails.</p>
          <p className="lede">Selling back into the curve is always allowed.</p>
        </div>
        <div className="hero-feed"><Feed /></div>
      </section>
      <section className="section">
        <div className="section-head center"><div><div className="eyebrow">Token</div><h2>Where it trades.</h2></div></div>
        <div className="journey">
          <div className="panel jcard lit">
            <Curve kind={0} />
            <span className="phase">01 · Hooker</span>
            <h3>Hooker</h3>
            <p>Your token starts on Hooker with custom rules and a graduation target you choose.</p>
            <div className="big">{info ? money(info.pumpfun.startCapSol) : "–"}</div>
            <span className="muted" style={{ fontSize: 13 }}>starting market cap, same as Pumpfun</span>
          </div>
          <div className="panel jcard">
            <Curve kind={1} />
            <span className="phase">02 · Pumpfun</span>
            <h3>Pumpfun</h3>
            <p>At graduation the token migrates to a Pumpfun coin and tokens are distributed to holders.</p>
            <div className="big">{info ? money(info.pumpfun.graduationCapSol) : "–"}</div>
            <span className="muted" style={{ fontSize: 13 }}>highest graduation, never above Pumpfun's own</span>
          </div>
          <div className="panel jcard">
            <Curve kind={2} />
            <span className="phase">03 · PumpSwap</span>
            <h3>PumpSwap</h3>
            <p>When the Pumpfun curve fills the token migrates to PumpSwap like any other Pumpfun coin, with its market cap carrying over throughout the process.</p>
            <div className="big">…hook</div>
            <span className="muted" style={{ fontSize: 13 }}>both addresses end in hook</span>
          </div>
        </div>
      </section>
      <section className="section">
        <div className="section-head center"><div><div className="eyebrow">Hooks</div><h2>Pick your hooks.</h2><p className="lede">Rules are enforced by Solana on every transfer while the token trades. At graduation, final payouts are calculated from the token’s public trade history so anyone can verify and recompute them.</p></div></div>
        <Picker info={info} />
      </section>
      <section className="section">
        <div className="section-head"><div><div className="eyebrow">The hooks you can pick</div><h2>Hooks</h2></div></div>
        <div className="prose-grid">
          {[...rulesFor(info).map((r) => [r.t, r.s]), ...ALWAYS].map(([t, d]) => <div className="panel" key={t}><h3>{t}</h3><p>{d}</p></div>)}
        </div>
      </section>
      <section className="cta">
        <h2>Launch with <span className="grad">rules.</span></h2>
        <p className="lede">Your token graduates into a normal Pumpfun coin.</p>
        <div className="row"><Link to="/launch" className="btn green">Launch a token <span className="arrow">→</span></Link></div>
      </section>
    </>
  );
}
