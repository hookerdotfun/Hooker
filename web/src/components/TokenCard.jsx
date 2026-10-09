import { Link } from "react-router-dom";
import { ago, usd, venueLabel } from "../lib/format.js";
import Logo from "./Logo.jsx";

/**
 * One launch as a card: square art, ticker, name, market cap. The art does most of the choosing,
 * so it gets the space. Badges sit on the art so every card in a grid is the same height.
 */
export default function TokenCard({ l }) {
  const done = l.status !== "trading";
  const pct = Math.round((l.progress ?? 0) * 100);
  const sym = l.meta?.symbol ?? l.symbol;
  return (
    <Link to={`/t/${l.mint}`} className="tc">
      <div className="tc-art">
        <Logo src={l.meta?.image} blank={<div className="tc-blank"><img src={l.chain === "rhc" ? "/logo-pons-full.png" : "/logo-full.png"} alt="" /></div>} />
        <span className={`tc-badge ${done ? "on" : ""}`}>{venueLabel(l)}</span>
        {l.createdAt ? <span className="tc-age">{ago(l.createdAt)}</span> : null}
      </div>
      <div className="tc-body">
        <div className="tc-sym">${sym}</div>
        <div className="tc-name">{l.meta?.name ?? l.name ?? "Unnamed"}</div>
        <div className="tc-cap">{usd(l.marketCapUsd)}<span>Market cap</span></div>
        {/* a curve's progress; a graduated token's card ends at its market cap */}
        {!done && l.noMigration && <div className="tc-foot"><span>Stays on Meteora</span><b>No migration</b></div>}
        {!done && !l.noMigration && (
          <>
            <div className="tc-foot">
              <span>To {l.chain === "rhc" ? "Pons" : "Pumpfun"}</span><b>{pct}%</b>
            </div>
            <div className="bar"><span style={{ width: `${Math.max(2, pct)}%` }} /></div>
          </>
        )}
      </div>
    </Link>
  );
}
