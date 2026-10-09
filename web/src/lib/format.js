export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
export const sol = (n, d = 2) => (n == null ? "–" : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: d })} SOL`);
/** Dollars, short: $950 · $12.3k · $1.2M. Null when nothing can price it. */
export const usd = (n) => {
  if (n == null || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
};
export const pct = (bps) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
/** a whole number of tokens (Robinhood Chain rules are reported in tokens, not base units) */
const whole = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
export const tokens = (units, decimals = 6) => (Number(units) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 0 });
export function duration(secs) {
  if (secs <= 0) return "0s";
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60), h = Math.floor(m / 60), mm = m % 60;
  if (h) return mm ? `${h}h ${mm}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** The rules in plain words, in the order a trader cares about. */
export function describeRules(r, { gradSol, noMigration = false, antiSnipe = false, antiSnipeStartPct = 50, fees = null, pair = null, chain = "sol", unit: unitIn = null } = {}) {
  // Pons launches (Robinhood Chain) graduate into a Pons coin, in ETH or a Pons pair asset, and take the size fee and burn on every buy
  const pons = chain === "rhc", coin = pons ? "Pons" : "Pumpfun", unit = unitIn ?? (pons ? "ETH" : "SOL");
  if (!r) return [];
  const out = [];
  // the Pumpfun coin's custom pair (lib/pairs.mjs) and its Pumpfun creator fee
  if (pair?.symbol) out.push({ t: `Pairs with ${pair.symbol} on Pumpfun`, d: `At graduation the curve's SOL is swapped into ${pair.symbol}${pair.creatorFeeBps ? `, and every Pumpfun trade pays a ${pair.creatorFeeBps / 100}% creator fee to ${pair.toHolders ? "holders" : "the creator"}` : ""}. If ${pair.symbol} no longer qualifies then, it pairs with SOL.` });
  // a creator fee step above the default (lib/curve.mjs FEE_TIERS)
  if (fees && fees.totalPct > 1) out.push({ t: "Trading fee", d: `Every trade pays ${Number(fees.totalPct.toFixed(2))}%, of which the creator gets ${Number(fees.creatorPct.toFixed(2))}%.` });
  // the starting fee is the token's own (tokens launched before 4 Oct 2026 started at 25%)
  if (antiSnipe) out.push({ t: "Anti-snipe fee", d: `For the first two minutes after launch the trading fee starts at ${Math.round(antiSnipeStartPct)}% and falls to 1%.` });
  if (r.fomoOnly) out.push({ t: "FOMO only", d: "It can only be bought in the FOMO app. Selling works anywhere." });
  if (r.appOnly) out.push({ t: "App-only buys", d: "It can only be bought inside its approved app. Selling works anywhere." });
  if (r.earlySecs > 0) out.push({ t: "Launch window", d: `For the first ${duration(r.earlySecs)} after launch, no wallet can hold more than ${pct(r.earlyMaxWalletBps)} of supply.` });
  if (r.maxWalletBps > 0) out.push({ t: "Max per wallet", d: `No wallet can hold more than ${pct(r.maxWalletBps)} of supply.` });
  if (r.allowlist) out.push({ t: "Allowlist", d: "Only wallets on the creator's list can buy it or be sent it. The list is public on chain." });
  if (r.blocklist) out.push({ t: "Blocklist", d: "Wallets on the creator's list can never buy it or be sent it. The list is public on chain." });
  if (r.rampSecs > 0) out.push({ t: "Rising max per wallet", d: `The max per wallet starts at ${pct(r.rampStartBps)} of supply and rises evenly to ${pct(r.maxWalletBps)} over ${duration(r.rampSecs)}.` });
  if (r.tradeGuardBps > 0) out.push({ t: "Trade guard", d: `No single buy or transfer can move more than ${pct(r.tradeGuardBps)} of supply. Sells are never limited.` });
  if (r.snipeSecs > 0) out.push({ t: "Sniper-fee cap", d: `For the first ${duration(r.snipeSecs)}, a buy paying more than ${Number(r.snipeMaxCuPrice).toLocaleString()} µL/CU in priority fees or tipping a Jito tip account more than ${(Number(r.snipeMaxTip) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL in the same transaction is refused.` });
  if (r.bundleMax > 0) out.push({ t: "Anti-bundle", d: `At most ${r.bundleMax} buy${r.bundleMax === 1 ? "" : "s"} can land in one block.` });
  if (r.hoursOn) {
    const zone = r.hoursDst === 1 && r.tzOffsetMin === -300 ? "New York time" : `${tzText(r.tzOffsetMin)}${r.hoursDst === 1 ? ", plus an hour during US daylight saving" : r.hoursDst === 2 ? ", plus an hour during European summer time" : ""}`;
    out.push({ t: "Trading hours", d: `It can only be ${r.hoursSells ? "bought and sold" : "bought"} ${daysText(r.hoursDays)}, ${hhmm(r.hoursOpenMin)} to ${hhmm(r.hoursCloseMin)} (${zone})${r.hoursHolidays ? ", and not on US stock market holidays" : ""}. ${r.hoursSells ? "Sending between wallets always works." : "Selling always works."}` });
  }
  if (r.maxBuyBps > 0 || r.maxSellBps > 0) out.push({ t: "Anti-dump caps", d: [r.maxBuyBps > 0 && `One buy can take at most ${pct(r.maxBuyBps)} of supply.`, r.maxSellBps > 0 && `One sell can move at most ${pct(r.maxSellBps)}, the creator's included.`].filter(Boolean).join(" ") });
  if (r.sellBagBps > 0) out.push({ t: "Graduated sell caps", d: `Small holders can sell up to ${pct(r.sellSmallBps)} of supply at once. The bigger the bag, the smaller one sell can be, down to ${pct(r.sellFloorBps)} for wallets holding ${pct(r.sellBagBps)} or more. The creator too.` });
  if (r.plagueDose > 0) out.push({ t: "Plague", d: `Nobody can simply buy it: a wallet can only buy once it holds at least ${pons ? whole(r.plagueDose) : tokens(r.plagueDose)} tokens, and the first tokens have to be sent by a holder. Selling is never restricted.` });
  if (r.dexOnly) out.push({ t: "DEX-only", d: "It only moves in trades with its curve. Wallet-to-wallet sends are refused, the creator's included." });
  if (r.p2pOnly) out.push({ t: "P2P-only", d: "Only the creator can buy from the curve, and nobody can sell to it. Everyone else gets tokens wallet to wallet." });
  if (r.potatoOn) out.push({ t: "Hot potato", d: `Whoever bought last cannot sell or send until a different wallet buys after them${r.potatoMinBps ? ` (with at least ${pct(r.potatoMinBps)} of supply)` : ""}${r.potatoColdSecs ? `, or nobody buys for ${duration(r.potatoColdSecs)}` : ""}. Nobody is exempt, the creator included.` });
  if (r.pingOn) out.push({ t: "Ping pong", d: `Buys and sells take turns, for everyone, the creator included. Trades under ${pct(r.pingMinBps)} of supply go through on their own turn without handing it over${r.pingFreeSecs ? `, and after ${duration(r.pingFreeSecs)} without a turn either side can go` : ""}. One transaction cannot take both turns.` });
  if (r.chapterStartBps > 0) out.push({ t: "Chapters", d: `No wallet can hold more than ${pct(r.chapterStartBps)} of supply at first. The cap doubles every time another ${pons ? whole(r.chapterVolume) : tokens(r.chapterVolume)} tokens trade.` });
  if (r.oscKind === 1) out.push({ t: "Breathing cap", d: `The most one buy can take swings around ${pct(r.oscBaseBps)} of supply by ${r.oscAmpPct}% on a ${duration(r.oscPeriod)} cycle, never below ${pct(r.oscFloorBps)}. Sells are never capped.` });
  if (r.oscKind >= 2) out.push({ t: ["", "", "Momentum", "Resonance", "Coupled resonator"][r.oscKind], d: `The most one buy can take rests at ${pct(r.oscBaseBps)} of supply. Every buy kicks an oscillator with a ${duration(r.oscPeriod)} period${r.oscKind === 4 ? ` coupled ${r.oscCouplingPct}% to a second one` : ""}, so the cap swings up and back${r.oscKind === 3 ? ", furthest when buys land on its beat" : ""}, and settles at ${r.oscDampPermille / 10}% per second, never below ${pct(r.oscFloorBps)}. Sells are never capped.` });
  if (r.kingOn) out.push({ t: "King of the Hill", d: `The biggest buy of at least ${pons ? `${Number(r.kingMin)} ${unit}` : sol(r.kingMinLamports / 1e9, 2)} holds the crown, and a challenger must beat it by ${r.kingBeatPct}% in one buy${r.kingDecayUnit ? `; the bar halves every ${r.kingDecayN} ${["", "minute", "hour", "day"][r.kingDecayUnit]}${r.kingDecayN === 1 ? "" : "s"}` : ""}. The King earns 0.3% of every trade's value while they reign, paid in ${pons ? unit : "SOL"} from Hooker's share of the fees. Selling or sending any tokens gives the crown up.${r.kingDevCan ? "" : " The creator cannot be King."}` });
  if (r.venueLock) out.push({ t: "Curve only", d: "It trades on its own curve. It can move between wallets, but no other pool or program can hold it." });
  if (r.feeCapBps > 0) out.push({ t: "Size fee", d: `Each buy pays ${pct(r.feeBaseBps)} plus ${pct(r.feePerSolBps ?? r.feePerEthBps)} per ${unit}, up to ${pct(r.feeCapBps)}, taken in tokens ${pons ? "on every buy" : "at graduation"}.` });
  if (r.burnBps > 0) out.push({ t: "Auto burn", d: pons ? `${pct(r.burnBps)} of every buy is burned.` : `${pct(r.burnBps)} of every buy is burned on the Pumpfun coin at graduation.` });
  if (r.holderShareBps > 0) out.push({ t: "Holder share", d: `${pct(r.holderShareBps)} of the platform's remaining trading fees buy extra coins for holders, shared by how much they held and for how long.` });
  if (r.fomoOnly || r.appOnly || r.maxWalletBps > 0 || r.earlySecs > 0 || r.allowlist || r.blocklist || r.tradeGuardBps > 0 || r.snipeSecs > 0 || r.bundleMax > 0 || r.hoursOn
    || r.maxBuyBps > 0 || r.plagueDose > 0 || r.chapterStartBps > 0 || r.oscKind > 0)
    out.push({ t: "Creator's wallet", d: `The creator's wallet${r.dev ? ` (${short(r.dev)})` : ""} is exempt from the rules about buying and holding, so it can buy at launch. Check what it holds.` });
  // a custom cap (10 Oct 2026) may be any amount: shown to two decimals at most
  const gradShown = gradSol == null ? null : Number(gradSol).toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (noMigration) out.push({ t: "No migration", d: "It never leaves its Meteora curve. There is no graduation, so every rule above stays on for good." });
  else out.push({ t: "Graduation", d: `When ${gradShown ?? "the target"} ${unit} is in the curve it becomes a ${coin} coin and every holder gets their new tokens automatically distributed to their wallet.${r.holderRewards ? ` After that, its ${coin} creator fees go to its holders.` : ""}` });
  return out;
}

/** "4m", "3h", "2d" since a unix time in seconds. */
export function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Where a launch trades now, in a word. */
export const venueLabel = (l) => (l.status === "trading" ? "Bonding" : l.status === "refunding" ? "Refunding" : l.venue === "pons" ? "Pons" : l.venue === "PumpSwap" ? "PumpSwap" : l.venue === "pump.fun" ? "Pumpfun" : "Graduating");

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const tzText = (off) => (off === 0 ? "UTC" : `UTC${off > 0 ? "+" : "-"}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${String(Math.abs(off) % 60).padStart(2, "0")}` : ""}`);
export function daysText(mask) {
  if (mask === 127) return "every day";
  if (mask === 62) return "Monday to Friday";
  if (mask === 65) return "on weekends";
  return "on " + DAYS.filter((_, i) => mask & (1 << i)).join(", ");
}
export const eth = (n, d = 3) => (n == null ? "–" : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: d })} ETH`);
/** An amount in a named asset: 0.02 ETH, 150 USDG. */
export const amt = (n, unit, d = 3) => (n == null ? "–" : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: d })} ${unit}`);
