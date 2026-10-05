import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { ago, short, usd } from "../lib/format.js";
import { rulesFor } from "../lib/catalog.js";
import TokenCard from "../components/TokenCard.jsx";
import Logo from "../components/Logo.jsx";
import Blocks from "../components/Blocks.jsx";

const STEPS = [
  ["Launch with rules", "Choose where it graduates, your graduation size and the rules your token will enforce. Launch directly from your wallet with your initial buy included. Every Solana token address ends in hook."],
  ["Bonding curve", "It trades on a curve that mirrors Pumpfun’s or Pons’s bonding curve keeping market cap and pricing exactly the same."],
  ["Migration", "When the curve fills the rules are removed and all of the SOL or ETH is used to create and launch a new Pumpfun or Pons coin in the same transaction. Holders receive their allocation automatically, with no one able to buy ahead of them."],
  ["Token distribution", "Every holder receives their share of the new coin directly in their wallet without having to claim anything. From there, it trades like any normal Pumpfun or Pons coin."],
];


/** A centred section title: a ruled eyebrow, then the heading. */
export function CHead({ eyebrow, title, sub }) {
  return (
    <div className="chead">
      <div className="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      {sub && <p className="chead-sub">{sub}</p>}
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState(null);
  const [burns, setBurns] = useState(null);
  useEffect(() => { api.burns().then(setBurns).catch(() => {}); }, []);
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [shownGrads, setShownGrads] = useState(5);

  useEffect(() => {
    let live = true;
    const load = () => api.launches().then((d) => { if (live) { setData(d.launches); setErr(null); } }).catch((e) => { if (live) setErr(e.message); });
    load();
    api.info().then((i) => { if (live) setInfo(i); }).catch(() => {});
    // ⚠ no polling while the tab is hidden; one refresh when it comes back
    const poll = () => { if (!document.hidden) load(); };
    const t = setInterval(poll, 10_000);
    document.addEventListener("visibilitychange", poll);
    return () => { live = false; clearInterval(t); document.removeEventListener("visibilitychange", poll); };
  }, []);

  const grads = useMemo(() => (data ?? []).filter((l) => l.status !== "trading"), [data]);
  const ca = data?.find((l) => l.native)?.mint ?? null;
  const [copied, setCopied] = useState(false);
  const copyCa = async () => { try { await navigator.clipboard.writeText(ca); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {} };
  const money = (capSol) => (info?.solUsd ? usd(capSol * info.solUsd) : "–");

  return (
    <>
      {/* ── hero: the mark, the line, two buttons, the program ─────────────────────────────── */}
      <section className="phero">
        <div className="phero-mark"><img src="/logo-full.png" alt="" /></div>
        <h1><span className="grad">Hooker</span></h1>
        <p className="lede">Launch a Pumpfun or Pons token with rules built into the token itself.</p>
        <div className="row">
          <Link to="/launch" className="btn">Launch a token</Link>
          <Link to="/docs" className="btn ghost">Docs</Link>
        </div>
        {/* our own coin's CA (featured.json); empty until it is launched. Clicking it copies it. */}
        <button type="button" className="ca ca-click" disabled={!ca} onClick={copyCa} title={ca ? "Copy" : undefined}>
          <b>CA:</b>
          {ca && <span className="ca-addr">{ca}</span>}
          {copied && <span className="ca-done">Copied</span>}
        </button>
        <div className="pstats">
          <div><span className="k">Tokens launched</span><b>{data ? data.length : "–"}</b></div>
          {/* every hook block on this page (15 on 4 Oct 2026) */}
          <div><span className="k">Custom Hooks</span><b>{info ? rulesFor(info).length : "–"}</b></div>
          <div><span className="k">Starting market cap</span><b>{info ? money(info.pumpfun.startCapSol) : "–"}</b></div>
        </div>
      </section>

      {/* ── hook blocks: every rule, one card each ─────────────────────────────────────────── */}
      <section className="psec" style={{ paddingTop: 8 }}>
        <div className="bhead">
          <div>
            <h2>Hooks</h2>
            <p className="muted">Choose the rules your token carries and combine as many as you like.</p>
          </div>
          <Link to="/docs" className="bmore">How each rule works <span>›</span></Link>
        </div>
        <Blocks info={info} />
      </section>

      {/* ── how it works, on its own band ──────────────────────────────────────────────────── */}
      <section className="band">
        <CHead eyebrow="Docs" title="How Hooker works" />
        <div className="steps ruled">
          {STEPS.map(([t, d], i) => (
            <div className="step" key={t}><span className="n">0{i + 1}</span><h3>{t}</h3><p>{d}</p></div>
          ))}
        </div>
      </section>

      {/* ── recent launches ────────────────────────────────────────────────────────────────── */}
      <section className="psec">
        <CHead eyebrow="Explore" title="Recent launches" />
        {err && !data && <p className="err center">{err}</p>}
        {!data && !err && <div className="empty">Reading the chain</div>}
        {data && data.length === 0 && (
          <div className="empty">No launches yet. The first one starts here.<div><Link to="/launch" className="btn green small">Launch a token</Link></div></div>
        )}
        {data && data.length > 0 && (
          <>
            <div className="tgrid">{data.slice(0, 10).map((l) => <TokenCard key={l.mint} l={l} />)}</div>
            <div className="more"><Link to="/explore" className="btn ghost small">View all launches <span className="arrow">→</span></Link></div>
          </>
        )}
      </section>

      {/* ── the burn: graduated coins' creator fees buy and burn $HOOKER (GET /api/burns) ──────── */}
      {burns?.on && (
        <section className="psec">
          <div className="lhead center">
            <div>
              <h2 className="lhead-t">Burns</h2>
              <p className="muted">Every coin that graduates sends its creator fees to the burn wallet, which buys $HOOKER and burns it.</p>
            </div>
          </div>
          <div className="pstats burnstats">
            <div><b>{burns.totals.hookerBurned.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b><span>$HOOKER burned</span></div>
            <div><b>{burns.totals.solSpent.toLocaleString(undefined, { maximumFractionDigits: 3 })} SOL</b><span>spent on burns{burns.totals.usdSpent != null ? ` · ${usd(burns.totals.usdSpent)}` : ""}</span></div>
            <div><b>{burns.coins}</b><span>graduated coins feeding it</span></div>
            <div><b>{burns.waitingSol.toLocaleString(undefined, { maximumFractionDigits: 3 })} SOL</b><span>waiting for the next burn</span></div>
          </div>
          <div className="ledger">
            {burns.rows.filter((r) => !r.dry).length === 0
              ? <div className="lrow empty-row">The first burn shows up here, with its transaction.</div>
              : burns.rows.filter((r) => !r.dry).slice(0, 10).map((r) => (
                <div className="lrow" key={r.sig}>
                  <div className="grow">
                    <div className="lmeta">{{ burn: "Bought and burned", claim: "Claimed creator fees", "claim-rhc": "Claimed Pons creator fees", bridge: "Bridged to the burn wallet" }[r.kind]} · {ago(r.at)}</div>
                    <div className="lamt">
                      {r.kind === "burn" ? `${r.hookerBurned.toLocaleString(undefined, { maximumFractionDigits: 0 })} $HOOKER` : r.kind === "claim" ? `${r.solIn.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL` : `${r.eth.toLocaleString(undefined, { maximumFractionDigits: 5 })} ETH`}
                      <span>{r.kind === "burn" ? `for ${r.solSpent.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL` : r.kind === "bridge" ? `→ ${r.sol?.toLocaleString(undefined, { maximumFractionDigits: 4 }) ?? "?"} SOL` : r.kind === "claim" ? "into the burn wallet" : "on Robinhood Chain"}</span>
                    </div>
                  </div>
                  <a className="btn tiny ghost" href={r.kind === "burn" || r.kind === "claim" ? `https://solscan.io/tx/${r.sig}` : `https://robinhoodchain.blockscout.com/tx/${r.sig}`} target="_blank" rel="noreferrer">{r.kind === "burn" || r.kind === "claim" ? "Solscan" : "Blockscout"} ↗</a>
                </div>
              ))}
          </div>
          <p className="hint center" style={{ marginTop: 10 }}>Burn wallet <a className="link mono" href={`https://solscan.io/account/${burns.wallet}`} target="_blank" rel="noreferrer">{burns.wallet}</a></p>
        </section>
      )}

      {/* ── graduations: the ledger ────────────────────────────────────────────────────────── */}
      <section className="psec">
        <div className="lhead center">
          <div>
            <h2 className="lhead-t">Graduations</h2>
            <p className="muted">Every token that graduated to Pumpfun or Pons.</p>
          </div>
        </div>
        {grads.length === 0 ? (
          <div className="ledger"><div className="lrow empty-row">When a token graduates to Pumpfun or Pons, it shows up here.</div></div>
        ) : (
          <>
            <div className="ledger">
              {grads.slice(0, shownGrads).map((l) => (
                <div className="lrow" key={l.mint}>
                  <Logo src={l.meta?.image} className="lthumb" blank={<div className="lthumb thumb blank" />} />
                  <div className="grow">
                    <div className="lmeta">{l.meta?.name ?? l.name} · {ago(l.createdAt)}</div>
                    <div className="lamt">{usd(l.marketCapUsd)}<span>market cap</span></div>
                  </div>
                  {l.graduated?.pumpUrl || l.graduated?.ponsUrl
                    ? <a className="btn tiny ghost" href={l.graduated.pumpUrl ?? l.graduated.ponsUrl} target="_blank" rel="noreferrer">{l.graduated.ponsUrl ? "Pons" : "Pumpfun"} ↗</a>
                    : <Link className="btn tiny ghost" to={`/t/${l.mint}`}>View</Link>}
                </div>
              ))}
            </div>
            {grads.length > shownGrads && <div className="more"><button className="btn ghost small" onClick={() => setShownGrads(shownGrads + 10)}>Load more <span className="plus">+</span></button></div>}
          </>
        )}
      </section>
    </>
  );
}

export { short };
