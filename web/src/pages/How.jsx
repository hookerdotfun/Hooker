import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { usd } from "../lib/format.js";
import { Feed, Curve } from "../components/Feed.jsx";
import Picker from "../components/Picker.jsx";
import { rulesFor } from "../lib/catalog.js";
import { useMode } from "../lib/mode.jsx";

const SECTIONS = {
  pumpfun: [
    ["Hooks", "Every Hooker token carries its rules in the token itself: a Solana Token-2022 token with a transfer hook. The rules run on every buy, sell and transfer, and a trade that breaks them never lands. The rules are a part of the token and are fixed at launch."],
    ["Bonding curve", "New tokens launch on a Meteora bonding curve shaped exactly like Pumpfun’s, so market cap and pricing work the same way.\n\nTrading costs 1% per trade. If the creator enables the anti-snipe fee it starts at 50% and gradually drops to 1% over the first two minutes, making early sniping expensive."],
    ["Graduation", "When the curve fills the hook is removed and the token graduates to Pumpfun. In the same transaction, the SOL from the curve is used to create and buy the new coin. This happens before anyone can buy in, so existing holders receive their share automatically and no one can get ahead of them. Each holder receives their allocation directly in their wallet."],
    ["Fees", "Every token starts with a 1% fee, split between the creator and Hooker, after Meteora's share. Creators can raise their fee to up to 3%. At graduation, Hooker's share tops every holder up to one Pumpfun coin per token they held.\n\nAfter graduation, the coin's Pumpfun creator fees go to Hooker's burn wallet, which buys $HOOKER with them and burns it. Every claim and burn is a public transaction. A creator can pick the Creator fees to holders hook instead, and then that coin's fees go to its holders."],
  ],
  pons: [
    ["Hooks", "Every Hooker token carries its rules in the token itself: on Robinhood Chain, the token contract runs them. The rules run on every buy, sell and transfer, and a trade that breaks them never lands. The rules are a part of the token and are fixed at launch."],
    ["Bonding curve", "New tokens launch on a bonding curve shaped exactly like Pons’s, so market cap and pricing work the same way. A creator can also pick one of Pons’s pair assets, such as USDG: the curve then takes that asset and the coin graduates paired with it.\n\nTrading costs 1% per trade. If the creator enables the anti-snipe fee it starts at 50% and gradually drops to 1% over the first two minutes, making early sniping expensive."],
    ["Graduation", "When the curve fills the rules are removed and the token graduates to Pons. In the same transaction, the ETH from the curve is used to create and buy the new Pons coin. This happens before anyone can buy in, so existing holders receive their share automatically and no one can get ahead of them. Each holder receives their allocation directly in their wallet."],
    ["Fees", "Every token starts with a 1% fee, split between the creator and Hooker. Creators can raise their fee to up to 3%, and claim their share in ETH from My tokens.\n\nAfter graduation, the coin's Pons creator fees go to Hooker's graduation wallet, which buys Hooker’s Pons token with them and burns it. Every claim and burn is a public transaction. A creator can pick the Creator fees to holders hook instead, and then Pons pays that coin's fees to its holders automatically."],
  ],
};

// the rules every launch can carry come from the catalog; these are the promises that hold for all of them
const ALWAYS = {
  pumpfun: [
    ["The creator's wallet", "Exempt from the caps and buy rules, so it can make its buy at launch. Every token page names it."],
    ["Holders can always sell", "No rule ever blocks a sale back into the curve."],
    ["Settled at graduation", "Whichever of size fee, auto burn and holder share the creator picked are applied from the token's public trade history when it graduates, so anyone can recompute every payout."],
  ],
  pons: [
    ["The creator's wallet", "Exempt from the caps and buy rules, so it can make its buy at launch. Every token page names it."],
    ["Holders can always sell", "No rule ever blocks a sale back into the curve."],
    ["Settled on chain", "Size fee and auto burn are taken on every buy and holder share is paid at graduation, all by the launchpad contract, so anyone can recompute every payout."],
  ],
};

export default function How() {
  const [info, setInfo] = useState(null);
  const [evmInfo, setEvmInfo] = useState(null);
  const { mode, pons, venue, ponsV3 } = useMode();
  useEffect(() => { api.info().then(setInfo).catch(() => {}); api.evmInfo().then(setEvmInfo).catch(() => {}); }, []);
  const money = (capSol) => (info?.solUsd ? usd(capSol * info.solUsd) : "–");
  const moneyEth = (capEth) => (evmInfo?.ethUsd ? usd(capEth * evmInfo.ethUsd) : "–");
  return (
    <>
      <div className="page-head center">
        <div className="eyebrow">Docs</div>
        <h1 style={{ fontSize: "clamp(38px, 6vw, 72px)" }}>How <span className="grad">Hooker</span> works</h1>
        <p className="lede">Launch a token with rules built into it, trade on a bonding curve identical to {venue}'s and graduate into a normal {venue} token.</p>
      </div>
      <div className="steps">
        {SECTIONS[mode].map(([t, d], i) => <div className="step" key={t}><span className="n">0{i + 1}</span><h3>{t}</h3><div className="step-body">{d.split("\n\n").map((para) => <p key={para}>{para}</p>)}</div></div>)}
      </div>
      <section className="section how-sim">
        <div className="how-sim-copy">
          <div className="eyebrow">Verifiable</div>
          <h2>The rules live in the <span className="grad">token</span>.</h2>
          <p className="lede">Every Hooker token carries its rules in the token itself: {pons ? "the token contract on Robinhood Chain" : "a Token-2022 transfer hook on Solana"}. The chain checks the rules on every buy, sell and transfer, so any transaction that breaks them simply fails.</p>
          <p className="lede">Selling back into the curve is always allowed.</p>
        </div>
        <div className="hero-feed"><Feed /></div>
      </section>
      <section className="section">
        <div className="section-head center"><div><div className="eyebrow">Token</div><h2>Where it trades.</h2></div></div>
        {pons ? (
        <div className="journey two-up">
          <div className="panel jcard lit">
            <Curve kind={0} />
            <span className="phase">01 · Hooker</span>
            <h3>Hooker</h3>
            <p>Your token starts on Hooker with custom rules and a graduation target you choose.</p>
            <div className="big">{evmInfo ? moneyEth(evmInfo.sizes[0].startCapEth) : "–"}</div>
            <span className="muted" style={{ fontSize: 13 }}>starting market cap, same as Pons</span>
          </div>
          <div className="panel jcard">
            <Curve kind={1} />
            <span className="phase">02 · Pons</span>
            <h3>Pons</h3>
            <p>At graduation the token migrates to a Pons coin and tokens are distributed to holders. From there it trades like any other Pons coin.</p>
            <div className="big">{evmInfo ? moneyEth(evmInfo.sizes[evmInfo.sizes.length - 1].endCapEth) : "–"}</div>
            <span className="muted" style={{ fontSize: 13 }}>highest graduation, never above Pons's own</span>
          </div>
        </div>
        ) : (
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
        )}
      </section>
      <section className="section">
        <div className="section-head center"><div><div className="eyebrow">Hooks</div><h2>Pick your hooks.</h2><p className="lede">Rules are enforced by the chain on every transfer while the token trades. {pons ? "At graduation, the launchpad contract pays every holder on chain, so anyone can verify and recompute it." : "At graduation, final payouts are calculated from the token’s public trade history so anyone can verify and recompute them."}</p></div></div>
        <Picker info={info} />
      </section>
      <section className="section">
        <div className="section-head"><div><div className="eyebrow">The hooks you can pick</div><h2>Hooks</h2></div></div>
        <div className="prose-grid">
          {[...rulesFor(info, mode, ponsV3).map((r) => [r.t, r.s]), ...ALWAYS[mode]].map(([t, d]) => <div className="panel" key={t}><h3>{t}</h3><p>{d}</p></div>)}
        </div>
      </section>
      <section className="cta">
        <h2>Launch with <span className="grad">rules.</span></h2>
        <p className="lede">Your token graduates into a normal {venue} coin.</p>
        <div className="row"><Link to="/launch" className="btn green">Launch a token <span className="arrow">→</span></Link></div>
      </section>
    </>
  );
}
