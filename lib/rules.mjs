// A window token's rules: the 128-byte config the hook reads (programs/hooker-hook/src/lib.rs).
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
};

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
  return b;
}

/**
 * What the launch sends to init: the compact v2 form [0x82, flags, cosigner?, app?, bytes 98..168].
 * The dev wallet is not sent (the program takes the payer, who must be the dev) and neither is any
 * trailing zero, which keeps a launch with a dev buy inside one transaction. Same config on chain.
 */
export const CFG_V2_COMPACT = 0x82;
export function encodeInitData(r) {
  const full = encodeRules(r);
  return Buffer.concat([
    Buffer.from([CFG_V2_COMPACT, full[1]]),
    r.fomoOnly ? full.subarray(34, 66) : Buffer.alloc(0),
    r.appOnly ? full.subarray(66, 98) : Buffer.alloc(0),
    full.subarray(98, 168),
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
    } : V2_OFF),
  };
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
