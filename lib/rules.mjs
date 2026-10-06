// A window token's rules: the config the hook reads (128 bytes v1, 256 bytes v2/v3) (programs/hooker-hook/src/lib.rs).
// Encoding, decoding and validation here MUST match the program; test/rules.test.mjs pins the
// layout and lib.rs `validate` is the authority (it refuses anything this lets through).
import { PublicKey } from "@solana/web3.js";

/** pump.fun's create_v2 refuses longer names, symbols and URIs: a window token must fit from day one. */
export const PUMPFUN_LIMITS = Object.freeze({ name: 32, symbol: 10, uri: 200 });
export const CFG_VERSION = 1;
export const CFG_LEN = 128;
/** v2: the first 128 bytes as v1, then the v2 rules. Every new launch is v2. */
export const CFG_V2 = 2;
export const CFG2_LEN = 256;
export const F2_ALLOW = 1;
export const F2_BLOCK = 2;
export const F2_BUNDLE = 4;
export const F2_HOURS = 8;
export const F2_SNIPE = 16;
/** A list can only grow in the first day after launch, up to this many wallets. */
export const LIST_MAX = 5_000;
/** 24 wallets is the most a list transaction carries under Solana's 1,232-byte limit (the program allows 30). */
export const LIST_ADD_MAX = 24;
export const LIST_OPEN_SECS = 86_400;
export const FLAG_COSIGN = 1;
export const FLAG_APP = 2;
export const FLAG_VENUE_LOCK = 4;
/** After graduation the pump.fun coin's creator fees go to its holders, forever (pump.fun holder rewards). */
export const FLAG_HOLDER_REWARDS = 8;

/** Hook refusal codes → what to tell a trader. */
export const HOOK_ERRORS = {
  1: "That would put the wallet over this token's max per wallet.",
  2: "This token can only be bought through FOMO.",
  3: "This token can only be bought inside its approved app.",
  4: "Window tokens can only move between wallets and their curve.",
  5: "The token's rules are invalid.",
  6: "This wallet is not on the token's allowlist.",
  7: "This wallet is on the token's blocklist.",
  8: "That trade is bigger than this token allows in one go.",
  9: "This token can only be bought during its trading hours.",
  10: "Priority fees and tips are capped right after launch. Lower them and try again.",
  11: "Too many buys landed in this block. Try again in a moment.",
  12: "The token's list is closed.",
  13: "List wallets must be added in order.",
  14: "Only the token's creator can change its list.",
  15: "That buy is bigger than this token allows in one go.",
  16: "That sell is bigger than this token allows in one go. Sell in smaller pieces.",
  17: "This token spreads like a plague: a wallet can only buy once a holder has sent it some.",
  18: "This token only moves in trades with its curve: wallet-to-wallet sends are off.",
  19: "This token only moves wallet to wallet: only its creator buys from the curve and nobody sells to it.",
  20: "Sells are closed outside this token's trading hours.",
  21: "You hold the hot potato: you can sell or send once another wallet buys after you.",
  22: "Ping pong: it is the other side's turn. Try again after the next trade.",
  23: "The buy cap is breathing: that buy is over it right now. Try a smaller buy or wait a moment.",
  24: "That would put the wallet over this chapter's max per wallet. It doubles as more volume trades.",
};

// ── v3 rules (config bytes 168..256, programs/hooker-hook/src/v3.rs) ─────────────────────────────
export const F3_SIDE_CAPS = 1, F3_SELL_SCALE = 2, F3_PLAGUE = 4, F3_DEX_ONLY = 8, F3_P2P = 16, F3_POTATO = 32, F3_PING = 64, F3_CHAPTERS = 128;
export const F4_KING = 1, F4_HOURS_SELLS = 2, F4_HOLIDAYS = 4;
export const DST = Object.freeze({ none: 0, us: 1, eu: 2 });
export const OSC = Object.freeze({ none: 0, breath: 1, momentum: 2, resonance: 3, coupled: 4 });
/** The King's cut of the value traded during their reign, paid by the keeper from Hooker's half of the fees (0.4%). */
export const KING_BPS = 30;
export const KING_RING = 32;
export const DECAY_UNIT_SECS = [0, 60, 3_600, 86_400];

/** Every v3 field, off. */
export const V3_OFF = Object.freeze({
  maxBuyBps: 0, maxSellBps: 0,                     // anti-dump caps
  sellSmallBps: 0, sellFloorBps: 0, sellBagBps: 0, // graduated sell caps
  plagueDose: 0,                                   // base units a wallet must hold to buy
  dexOnly: false, p2pOnly: false,
  potatoOn: false, potatoMinBps: 0, potatoColdSecs: 0,
  pingOn: false, pingMinBps: 0, pingFreeSecs: 0,
  chapterStartBps: 0, chapterVolume: 0,            // chapter volume in base units
  oscKind: 0, oscPeriod: 0, oscBaseBps: 0, oscFloorBps: 0, oscAmpPct: 0, oscDampPermille: 0, oscCouplingPct: 0,
  kingOn: false, kingMinLamports: 0, kingBeatPct: 0, kingDecayUnit: 0, kingDecayN: 0, kingDevCan: false,
  hoursSells: false, hoursHolidays: false, hoursDst: 0,
});
const hasState = (v) => v.potatoOn || v.pingOn || v.chapterStartBps > 0 || v.kingOn || [OSC.momentum, OSC.resonance, OSC.coupled].includes(v.oscKind);

/** What a new launch gets unless the creator changes it. */
export const DEFAULT_RULES = Object.freeze({
  fomoOnly: false,
  appOnly: false,
  // ⛔ 4 Oct 2026 (operator): EVERY hook is off until the creator picks it. Nothing is on by default.
  venueLock: false,
  holderRewards: false,     // pump.fun creator fees after graduation: to the creator (false) or to holders (true)
  maxWalletBps: 0,          // off (the form suggests 3% when picked)
  earlySecs: 0,             // launch window off (the form suggests 5 min at 0.5% when picked)
  earlyMaxWalletBps: 0,
  feeBaseBps: 0,            // dynamic fee off by default
  feePerSolBps: 0,
  feeCapBps: 0,
  burnBps: 0,               // auto burn off by default
  holderShareBps: 0,        // holder share off (the form suggests 50% when picked)
  // v2 rules, all off unless picked
  allowlist: false,
  blocklist: false,
  tradeGuardBps: 0,
  rampStartBps: 0,
  rampSecs: 0,
  hoursOn: false,
  hoursDays: 0,             // bit 0 Sunday … bit 6 Saturday
  hoursOpenMin: 0,          // local minute of the day
  hoursCloseMin: 0,
  tzOffsetMin: 0,           // local time = UTC + this
  bundleMax: 0,             // buys per slot
  snipeSecs: 0,
  snipeMaxCuPrice: 0,       // micro-lamports per compute unit
  snipeMaxTip: 0,           // lamports to a Jito tip account
  ...V3_OFF,
});

/** The v2 fields of a rules object, defaulted (a v1 config decodes with all of them off). */
const V2_OFF = Object.freeze({ allowlist: false, blocklist: false, tradeGuardBps: 0, rampStartBps: 0, rampSecs: 0, hoursOn: false,
  hoursDays: 0, hoursOpenMin: 0, hoursCloseMin: 0, tzOffsetMin: 0, bundleMax: 0, snipeSecs: 0, snipeMaxCuPrice: 0, snipeMaxTip: 0 });

const ZERO = PublicKey.default;
const pk = (v) => (v instanceof PublicKey ? v : v ? new PublicKey(v) : ZERO);

/** Mirrors `validate` in the program. Returns a list of human-readable problems (empty = fine). */
export function validateRules(r) {
  const errs = [];
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!r.dev || pk(r.dev).equals(ZERO)) errs.push("A dev wallet is required.");
  if (r.fomoOnly && pk(r.cosigner).equals(ZERO)) errs.push("FOMO-only needs FOMO's co-signer key.");
  if (r.appOnly && pk(r.app).equals(ZERO)) errs.push("App-only needs the app's program id.");
  if (!int(r.maxWalletBps, 0, 10_000) || (r.maxWalletBps !== 0 && r.maxWalletBps < 10)) errs.push("Max per wallet must be off or between 0.1% and 100%.");
  if (!int(r.earlySecs, 0, 86_400)) errs.push("The launch window can be at most a day.");
  if (r.earlySecs > 0 && !int(r.earlyMaxWalletBps, 10, 10_000)) errs.push("The launch-window cap must be between 0.1% and 100%.");
  if (r.earlySecs === 0 && r.earlyMaxWalletBps !== 0) errs.push("A launch-window cap needs a launch window.");
  if (!int(r.feeCapBps, 0, 2_000) || !int(r.feeBaseBps, 0, r.feeCapBps) || !int(r.feePerSolBps, 0, 10_000) || (r.feePerSolBps > 0 && r.feeCapBps === 0))
    errs.push("Dynamic fee: the cap is at most 20% and the base at most the cap.");
  if (!int(r.burnBps, 0, 2_000) || r.feeCapBps + r.burnBps > 3_000) errs.push("Burn is at most 20%, and fee + burn at most 30%.");
  if (!int(r.holderShareBps, 0, 10_000)) errs.push("Holder share must be between 0% and 100%.");
  const v = { ...V2_OFF, ...r };
  if (v.allowlist && v.blocklist) errs.push("Pick an allowlist or a blocklist, not both.");
  if (!int(v.tradeGuardBps, 0, 10_000) || (v.tradeGuardBps !== 0 && v.tradeGuardBps < 10)) errs.push("Trade guard must be off or between 0.1% and 100%.");
  if (v.rampSecs > 0) {
    if (!int(v.rampSecs, 1, 7 * 86_400) || r.maxWalletBps === 0 || !int(v.rampStartBps, 10, r.maxWalletBps - 1))
      errs.push("Rising max per wallet needs a max per wallet, starts below it, and rises over at most a week.");
  } else if (v.rampStartBps !== 0) errs.push("A ramp start needs a ramp.");
  if (v.hoursOn) {
    if (!int(v.hoursDays, 1, 127) || !int(v.hoursOpenMin, 0, 1_439) || !int(v.hoursCloseMin, 0, 1_439) || v.hoursOpenMin === v.hoursCloseMin || !int(v.tzOffsetMin, -720, 840))
      errs.push("Trading hours need at least one day and an opening time different from the closing time.");
  } else if (v.hoursDays || v.hoursOpenMin || v.hoursCloseMin || v.tzOffsetMin) errs.push("Trading hours are set without the rule.");
  if (!int(v.bundleMax, 0, 20)) errs.push("Anti-bundle allows 1 to 20 buys per block.");
  if (v.snipeSecs > 0) {
    if (!int(v.snipeSecs, 1, 86_400)) errs.push("The sniper-fee cap lasts at most a day.");
    if (!Number.isSafeInteger(v.snipeMaxCuPrice) || v.snipeMaxCuPrice < 0 || !Number.isSafeInteger(v.snipeMaxTip) || v.snipeMaxTip < 0)
      errs.push("Sniper-fee caps must be whole numbers, zero or more.");
  } else if (v.snipeMaxCuPrice !== 0 || v.snipeMaxTip !== 0) errs.push("Sniper-fee caps are set without the rule.");
  errs.push(...validateV3({ ...V3_OFF, ...r }, v));
  return errs;
}

/** Mirrors `v3::validate` in the program. */
function validateV3(x, v) {
  const errs = [];
  const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  if (x.maxBuyBps || x.maxSellBps) {
    if ((x.maxBuyBps && !int(x.maxBuyBps, 10, 10_000)) || (x.maxSellBps && !int(x.maxSellBps, 10, 10_000))) errs.push("Anti-dump caps must be between 0.1% and 100%.");
    if (v.tradeGuardBps) errs.push("Anti-dump caps and trade guard both cap a trade: pick one.");
  }
  if (x.sellBagBps || x.sellSmallBps || x.sellFloorBps) {
    if (!int(x.sellSmallBps, 2, 10_000) || !int(x.sellFloorBps, 1, x.sellSmallBps - 1) || !int(x.sellBagBps, 10, 10_000))
      errs.push("Graduated sell caps: the biggest bags' cap must be below the small holders' cap.");
    if (x.maxSellBps) errs.push("Graduated sell caps and a max per sell both cap a sell: pick one.");
  }
  if (!Number.isSafeInteger(x.plagueDose) || x.plagueDose < 0) errs.push("The plague dose must be a whole number of base units.");
  if (x.plagueDose && (x.dexOnly || x.p2pOnly)) errs.push("Plague spreads by sends: it cannot be combined with DEX-only or P2P-only.");
  if (x.dexOnly && x.p2pOnly) errs.push("Pick DEX-only or P2P-only, not both.");
  if (x.p2pOnly && (v.fomoOnly || v.appOnly || v.hoursOn || v.snipeSecs || v.bundleMax || x.potatoOn || x.pingOn || x.maxBuyBps || x.maxSellBps || x.sellBagBps || x.kingOn || x.oscKind))
    errs.push("P2P-only cannot be combined with rules about buying or selling.");
  if (x.potatoOn) { if (!int(x.potatoMinBps, 0, 100) || !int(x.potatoColdSecs, 0, 86_400)) errs.push("Hot potato: minimum at most 1%, cold after at most a day."); }
  else if (x.potatoMinBps || x.potatoColdSecs) errs.push("Hot potato settings are set without the rule.");
  if (x.pingOn) { if (!int(x.pingMinBps, 0, 100) || !int(x.pingFreeSecs, 0, 86_400)) errs.push("Ping pong: minimum at most 1%, free after at most a day."); }
  else if (x.pingMinBps || x.pingFreeSecs) errs.push("Ping pong settings are set without the rule.");
  if (x.chapterStartBps || x.chapterVolume) {
    if (!int(x.chapterStartBps, 10, 10_000) || !Number.isSafeInteger(x.chapterVolume) || x.chapterVolume <= 0) errs.push("Chapters need a starting max per wallet and a volume per chapter.");
    if (v.maxWalletBps || v.rampSecs) errs.push("Chapters and max per wallet both cap a wallet: pick one.");
  }
  if (!int(x.oscKind, 0, 4)) errs.push("Unknown oscillator.");
  else if (x.oscKind === OSC.breath) {
    if (!int(x.oscPeriod, 30, 3_600) || !int(x.oscAmpPct, 10, 100) || x.oscDampPermille || x.oscCouplingPct) errs.push("Breathing cap: a cycle of 30 seconds to an hour and a swing of 10% to 100%.");
  } else if (x.oscKind) {
    if (!int(x.oscPeriod, 20, 1_200) || !int(x.oscAmpPct, 5, 100) || !int(x.oscDampPermille, 10, 400)) errs.push("Oscillator: a period of 20 seconds to 20 minutes, buy energy 5% to 100%, damping 1% to 40% per second.");
    if ((x.oscKind === OSC.coupled) !== (x.oscCouplingPct !== 0) || (x.oscKind === OSC.coupled && !int(x.oscCouplingPct, 1, 60))) errs.push("Coupling (1% to 60%) is only for the coupled resonator.");
  } else if (x.oscPeriod || x.oscBaseBps || x.oscFloorBps || x.oscAmpPct || x.oscDampPermille || x.oscCouplingPct) errs.push("Oscillator settings are set without the rule.");
  if (x.oscKind && (!int(x.oscBaseBps, 10, 10_000) || !int(x.oscFloorBps, 1, x.oscBaseBps))) errs.push("The oscillating cap needs a base cap of at least 0.1% and a floor at most the base.");
  if (x.kingOn) {
    if (!int(x.kingMinLamports, 10_000_000, 10_000_000_000) || !int(x.kingBeatPct, 0, 50) || !int(x.kingDecayUnit, 0, 3)) errs.push("King of the Hill: the crown takes 0.01 to 10 SOL and a challenger beats the King by at most 50%.");
    if ((x.kingDecayUnit === 0) !== (x.kingDecayN === 0) || !int(x.kingDecayN, 0, 60)) errs.push("King of the Hill: the bar halves every 1 to 60 minutes, hours or days, or never.");
  } else if (x.kingMinLamports || x.kingBeatPct || x.kingDecayUnit || x.kingDecayN || x.kingDevCan) errs.push("King of the Hill settings are set without the rule.");
  if (!v.hoursOn && (x.hoursSells || x.hoursHolidays || x.hoursDst)) errs.push("Trading-hours options need trading hours.");
  if (!int(x.hoursDst, 0, 2)) errs.push("Unknown daylight saving.");
  return errs;
}

/** The config bytes init expects (launch_ts left 0: the program writes it from the clock). */
export function encodeRules(r) {
  const errs = validateRules(r);
  if (errs.length) throw new Error(errs.join(" "));
  const v = { ...V2_OFF, ...r };
  const b = Buffer.alloc(CFG2_LEN);
  b[0] = CFG_V2;
  b[1] = (r.fomoOnly ? FLAG_COSIGN : 0) | (r.appOnly ? FLAG_APP : 0) | (r.venueLock ? FLAG_VENUE_LOCK : 0) | (r.holderRewards ? FLAG_HOLDER_REWARDS : 0);
  pk(r.dev).toBuffer().copy(b, 2);
  (r.fomoOnly ? pk(r.cosigner) : ZERO).toBuffer().copy(b, 34);
  (r.appOnly ? pk(r.app) : ZERO).toBuffer().copy(b, 66);
  b.writeUInt16LE(r.maxWalletBps, 98);
  b.writeUInt32LE(r.earlySecs, 108);
  b.writeUInt16LE(r.earlyMaxWalletBps, 112);
  b.writeUInt16LE(r.feeBaseBps, 114);
  b.writeUInt16LE(r.feePerSolBps, 116);
  b.writeUInt16LE(r.feeCapBps, 118);
  b.writeUInt16LE(r.burnBps, 120);
  b.writeUInt16LE(r.holderShareBps, 122);
  b[128] = (v.allowlist ? F2_ALLOW : 0) | (v.blocklist ? F2_BLOCK : 0) | (v.bundleMax > 0 ? F2_BUNDLE : 0) | (v.hoursOn ? F2_HOURS : 0) | (v.snipeSecs > 0 ? F2_SNIPE : 0);
  b[129] = v.hoursOn ? v.hoursDays : 0;
  b.writeUInt16LE(v.tradeGuardBps, 130);
  b.writeUInt16LE(v.rampStartBps, 132);
  b.writeUInt32LE(v.rampSecs, 134);
  b.writeUInt16LE(v.hoursOn ? v.hoursOpenMin : 0, 138);
  b.writeUInt16LE(v.hoursOn ? v.hoursCloseMin : 0, 140);
  b.writeInt16LE(v.hoursOn ? v.tzOffsetMin : 0, 142);
  b.writeUInt16LE(v.bundleMax, 144);
  b.writeUInt32LE(v.snipeSecs, 148);
  b.writeBigUInt64LE(BigInt(v.snipeSecs > 0 ? v.snipeMaxCuPrice : 0), 152);
  b.writeBigUInt64LE(BigInt(v.snipeSecs > 0 ? v.snipeMaxTip : 0), 160);
  const x = { ...V3_OFF, ...r };
  b[168] = (x.maxBuyBps || x.maxSellBps ? F3_SIDE_CAPS : 0) | (x.sellBagBps ? F3_SELL_SCALE : 0) | (x.plagueDose ? F3_PLAGUE : 0) | (x.dexOnly ? F3_DEX_ONLY : 0)
    | (x.p2pOnly ? F3_P2P : 0) | (x.potatoOn ? F3_POTATO : 0) | (x.pingOn ? F3_PING : 0) | (x.chapterStartBps ? F3_CHAPTERS : 0);
  b[169] = (x.kingOn ? F4_KING : 0) | (x.hoursSells ? F4_HOURS_SELLS : 0) | (x.hoursHolidays ? F4_HOLIDAYS : 0) | (x.hoursDst << 3);
  b[170] = x.oscKind;
  b.writeUInt16LE(x.maxBuyBps, 172); b.writeUInt16LE(x.maxSellBps, 174);
  b.writeUInt16LE(x.sellSmallBps, 176); b.writeUInt16LE(x.sellFloorBps, 178); b.writeUInt16LE(x.sellBagBps, 180);
  b.writeBigUInt64LE(BigInt(x.plagueDose), 182);
  b.writeUInt16LE(x.potatoMinBps, 190); b.writeUInt32LE(x.potatoColdSecs, 192);
  b.writeUInt16LE(x.pingMinBps, 196); b.writeUInt32LE(x.pingFreeSecs, 198);
  b.writeUInt16LE(x.chapterStartBps, 202); b.writeBigUInt64LE(BigInt(x.chapterVolume), 204);
  b.writeUInt16LE(x.oscPeriod, 212); b.writeUInt16LE(x.oscBaseBps, 214); b.writeUInt16LE(x.oscFloorBps, 216);
  b.writeUInt16LE(x.oscAmpPct, 218); b.writeUInt16LE(x.oscDampPermille, 220); b.writeUInt16LE(x.oscCouplingPct, 222);
  b.writeBigUInt64LE(BigInt(x.kingMinLamports), 224);
  b[232] = x.kingBeatPct; b[233] = x.kingDecayUnit; b.writeUInt16LE(x.kingDecayN, 234); b[236] = x.kingDevCan ? 1 : 0;
  return b;
}

/** Whether a rules object uses any v3 rule (then the launch sends the 0x83 init form). */
/** (A field comparison, never encodeRules: it must not throw on rules that are still to be validated.) */
export const usesV3 = (r) => Object.keys(V3_OFF).some((k) => r[k] != null && r[k] !== V3_OFF[k]);
/** Whether the token's transfers carry the ["state", mint] account, and the pool (King of the Hill). */
export const needsState = (r) => hasState({ ...V3_OFF, ...r });
export const needsPool = (r) => !!r.kingOn;

/**
 * What the launch sends to init: the compact v2 form [0x82, flags, cosigner?, app?, bytes 98..168].
 * The dev wallet is not sent (the program takes the payer, who must be the dev) and neither is any
 * trailing zero, which keeps a launch with a dev buy inside one transaction. Same config on chain.
 */
export const CFG_V2_COMPACT = 0x82;
/** v3: the same, then the v3 bytes 168.. as a length byte and the bytes up to the last non-zero one. */
export const CFG_V3_COMPACT = 0x83;
export function encodeInitData(r) {
  const full = encodeRules(r);
  let n = 88;
  while (n > 0 && full[168 + n - 1] === 0) n--;
  return Buffer.concat([
    Buffer.from([n ? CFG_V3_COMPACT : CFG_V2_COMPACT, full[1]]),
    r.fomoOnly ? full.subarray(34, 66) : Buffer.alloc(0),
    r.appOnly ? full.subarray(66, 98) : Buffer.alloc(0),
    full.subarray(98, 168),
    n ? Buffer.concat([Buffer.from([n]), full.subarray(168, 168 + n)]) : Buffer.alloc(0),
  ]);
}

export function decodeRules(data) {
  const b = Buffer.from(data);
  const v2 = b[0] === CFG_V2 && b.length >= CFG2_LEN;
  if (!v2 && (b.length < CFG_LEN || b[0] !== CFG_VERSION)) throw new Error("not a Hooker config");
  const f2 = v2 ? b[128] : 0;
  return {
    version: v2 ? 2 : 1,
    fomoOnly: !!(b[1] & FLAG_COSIGN),
    appOnly: !!(b[1] & FLAG_APP),
    venueLock: !!(b[1] & FLAG_VENUE_LOCK),
    holderRewards: !!(b[1] & FLAG_HOLDER_REWARDS),
    dev: new PublicKey(b.subarray(2, 34)),
    cosigner: new PublicKey(b.subarray(34, 66)),
    app: new PublicKey(b.subarray(66, 98)),
    maxWalletBps: b.readUInt16LE(98),
    launchTs: Number(b.readBigInt64LE(100)),
    earlySecs: b.readUInt32LE(108),
    earlyMaxWalletBps: b.readUInt16LE(112),
    feeBaseBps: b.readUInt16LE(114),
    feePerSolBps: b.readUInt16LE(116),
    feeCapBps: b.readUInt16LE(118),
    burnBps: b.readUInt16LE(120),
    holderShareBps: b.readUInt16LE(122),
    ...(v2 ? {
      allowlist: !!(f2 & F2_ALLOW),
      blocklist: !!(f2 & F2_BLOCK),
      tradeGuardBps: b.readUInt16LE(130),
      rampStartBps: b.readUInt16LE(132),
      rampSecs: b.readUInt32LE(134),
      hoursOn: !!(f2 & F2_HOURS),
      hoursDays: b[129],
      hoursOpenMin: b.readUInt16LE(138),
      hoursCloseMin: b.readUInt16LE(140),
      tzOffsetMin: b.readInt16LE(142),
      bundleMax: b.readUInt16LE(144),
      snipeSecs: b.readUInt32LE(148),
      snipeMaxCuPrice: Number(b.readBigUInt64LE(152)),
      snipeMaxTip: Number(b.readBigUInt64LE(160)),
      ...decodeV3(b),
    } : { ...V2_OFF, ...V3_OFF }),
  };
}

function decodeV3(b) {
  const f3 = b[168], f4 = b[169];
  return {
    maxBuyBps: b.readUInt16LE(172), maxSellBps: b.readUInt16LE(174),
    sellSmallBps: b.readUInt16LE(176), sellFloorBps: b.readUInt16LE(178), sellBagBps: b.readUInt16LE(180),
    plagueDose: Number(b.readBigUInt64LE(182)),
    dexOnly: !!(f3 & F3_DEX_ONLY), p2pOnly: !!(f3 & F3_P2P),
    potatoOn: !!(f3 & F3_POTATO), potatoMinBps: b.readUInt16LE(190), potatoColdSecs: b.readUInt32LE(192),
    pingOn: !!(f3 & F3_PING), pingMinBps: b.readUInt16LE(196), pingFreeSecs: b.readUInt32LE(198),
    chapterStartBps: b.readUInt16LE(202), chapterVolume: Number(b.readBigUInt64LE(204)),
    oscKind: b[170], oscPeriod: b.readUInt16LE(212), oscBaseBps: b.readUInt16LE(214), oscFloorBps: b.readUInt16LE(216),
    oscAmpPct: b.readUInt16LE(218), oscDampPermille: b.readUInt16LE(220), oscCouplingPct: b.readUInt16LE(222),
    kingOn: !!(f4 & F4_KING), kingMinLamports: Number(b.readBigUInt64LE(224)), kingBeatPct: b[232], kingDecayUnit: b[233],
    kingDecayN: b.readUInt16LE(234), kingDevCan: b[236] === 1,
    hoursSells: !!(f4 & F4_HOURS_SELLS), hoursHolidays: !!(f4 & F4_HOLIDAYS), hoursDst: (f4 >> 3) & 3,
  };
}

/**
 * A token's ["state", mint] account: the hot potato, whose turn it is, volume traded, and the King
 * with the value traded in each of the last 32 reigns (what the keeper pays from). Null when absent.
 */
export function decodeState(data) {
  if (!data || data.length < 256) return null;
  const b = Buffer.from(data);
  const key = (at) => { const k = new PublicKey(b.subarray(at, at + 32)); return k.equals(ZERO) ? null : k.toBase58(); };
  const reigns = [];
  for (let i = 0; 256 + (i + 1) * 48 <= b.length && i < KING_RING; i++) {
    const at = 256 + i * 48, reign = b.readUInt32LE(at + 32);
    if (reign) reigns.push({ king: key(at), reign, ended: b.readUInt32LE(at + 36) === 1, valueLamports: b.readBigUInt64LE(at + 40) });
  }
  reigns.sort((a, c) => c.reign - a.reign);
  return {
    potato: { holder: key(0), since: Number(b.readBigInt64LE(32)) },
    ping: { next: ["any", "buy", "sell"][b[40]] ?? "any", lastTs: Number(b.readBigInt64LE(48)) },
    volume: b.readBigUInt64LE(64) + (b.readBigUInt64LE(72) << 64n),
    osc: { lastTs: Number(b.readBigInt64LE(80)), x: [88, 104].map((at) => Number(b.readBigInt64LE(at)) / 2 ** 32), v: [96, 112].map((at) => Number(b.readBigInt64LE(at)) / 2 ** 32) },
    king: { king: key(200), bidLamports: b.readBigUInt64LE(232), since: Number(b.readBigInt64LE(240)), reign: b.readUInt32LE(248) },
    reigns,
  };
}

/** What a buy needs right now to take the crown, in lamports (mirrors `v3::king_bar`). */
export function kingBar(rules, state, now) {
  const min = BigInt(rules.kingMinLamports);
  if (!state?.king?.king) return min;
  let bar = Number(state.king.bidLamports) * (100 + rules.kingBeatPct) / 100;
  const hl = DECAY_UNIT_SECS[rules.kingDecayUnit] * rules.kingDecayN;
  if (hl > 0) bar *= 2 ** (-Math.max(0, now - state.king.since) / hl);
  const b = BigInt(Math.floor(bar));
  return b > min ? b : min;
}

/** The per-buy cap of an oscillating token right now, bps of supply (display; mirrors `v3::post`). */
export function oscCapBps(rules, state, now) {
  const { oscKind, oscPeriod: T, oscBaseBps: base, oscFloorBps: floor, oscAmpPct: amp, oscDampPermille: d, oscCouplingPct: k } = rules;
  if (!oscKind) return null;
  let x = 0;
  if (oscKind === OSC.breath) x = Math.sin(2 * Math.PI * (((now - rules.launchTs) % T + T) % T) / T) * amp / 100;
  else if (state?.osc?.lastTs) {
    const w2 = (2 * Math.PI / T) ** 2, twoG = 2 * d / 1000, dt = Math.max(0, now - state.osc.lastTs);
    const modes = oscKind === OSC.coupled ? [w2, w2 * (100 + 2 * k) / 100] : [w2];
    modes.forEach((m2, i) => {
      const [m00, m01] = stepPow(m2, twoG, dt);
      x += m00 * state.osc.x[i] + m01 * state.osc.v[i];
    });
  }
  return Math.min(10_000, Math.max(floor, Math.round(base * (1 + x))));
}
/** First row of exp(A·dt) for x'' = -w2·x - 2γ·x' (Taylor for one second, then squaring). */
function stepPow(w2, twoG, dt) {
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
  const A = [0, 1, -w2, -twoG];
  let term = [1, 0, 0, 1], m = [1, 0, 0, 1];
  for (let n = 1; n <= 24; n++) { term = mul(term, A).map((t) => t / n); m = m.map((v, i) => v + term[i]); }
  let r = [1, 0, 0, 1];
  for (let e = Math.min(Math.floor(dt), 1 << 22); e > 0; e >>= 1) { if (e & 1) r = mul(r, m); m = mul(m, m); }
  return r;
}

/** The dynamic fee for one buy, in bps: base + perSol × SOL paid, capped. */
export const feeBpsFor = (rules) => (lamportsPaid) => {
  const bps = BigInt(rules.feeBaseBps) + (BigInt(rules.feePerSolBps) * BigInt(lamportsPaid)) / 1_000_000_000n;
  const cap = BigInt(rules.feeCapBps);
  return bps > cap ? cap : bps;
};

export const hookPdas = (hookProgram, mint) => ({
  extraAccountMetas: PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), pk(mint).toBuffer()], pk(hookProgram))[0],
  cfg: PublicKey.findProgramAddressSync([Buffer.from("cfg"), pk(mint).toBuffer()], pk(hookProgram))[0],
  list: PublicKey.findProgramAddressSync([Buffer.from("list"), pk(mint).toBuffer()], pk(hookProgram))[0],
  slot: PublicKey.findProgramAddressSync([Buffer.from("slot"), pk(mint).toBuffer()], pk(hookProgram))[0],
  state: PublicKey.findProgramAddressSync([Buffer.from("state"), pk(mint).toBuffer()], pk(hookProgram))[0],
});

/** A token's list account: { count, sealed, wallets } (sorted). Null when it was never created. */
export function decodeList(data) {
  if (!data || data.length < 8) return null;
  const b = Buffer.from(data);
  const count = b.readUInt32LE(0);
  const wallets = [];
  for (let i = 0; i < count; i++) wallets.push(new PublicKey(b.subarray(8 + i * 32, 8 + (i + 1) * 32)));
  return { count, sealed: b[4] === 1, wallets };
}

/** Wallets sorted the way the program stores them (raw bytes, ascending), duplicates removed. */
export function sortWallets(list) {
  const seen = new Map();
  for (const w of list) { const k = pk(w); seen.set(k.toBase58(), k); }
  return [...seen.values()].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
}

/** The hook's custom error code in a failed transaction's logs, or null. */
export function hookErrorFromLogs(logs, hookProgram) {
  const id = pk(hookProgram).toBase58();
  for (const l of logs ?? []) {
    const m = new RegExp(`Program ${id} failed: custom program error: 0x([0-9a-f]+)`).exec(l);
    if (m) return parseInt(m[1], 16);
  }
  return null;
}
