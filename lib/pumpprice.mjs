// Pricing a Hooker coin AFTER graduation, when it lives on pump.fun. A coin is priced by a different
// account in each phase, and only one is right at a time:
//
//   on the pump.fun curve   BondingCurve ["bonding-curve", mint]: virtual quote / virtual token
//   on PumpSwap (after the  the canonical pool's two token accounts, PLUS the pool's own
//   pump.fun curve fills)   virtual_quote_reserves — balances alone price 11–31% LOW (measured)
//
// ⛔ A pump.fun curve that has filled reads ALL ZEROES with complete = 1, so "cap from the curve"
// would print 0 for a coin trading at many times its graduation price. And when nothing can price a
// coin the answer is null, never 0: an unreadable pool and a worthless coin must not look the same.
import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createRequire } from "node:module";
const { bondingCurvePda, canonicalPumpPoolPda, canonicalPumpPoolPdaWithQuote } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

/**
 * PumpSwap `Pool` layout, from the installed pump-swap-sdk IDL (lib/pumpprice.mjs is pinned to it by
 * test/pumpprice.test.mjs): disc 8 | pool_bump u8 | index u16 | creator | base_mint | quote_mint |
 * lp_mint | pool_base_token_account | pool_quote_token_account | lp_supply u64 | coin_creator |
 * is_mayhem_mode | is_cashback_coin | virtual_quote_reserves i128 | …
 */
export const POOL_LAYOUT = { baseAccount: 139, quoteAccount: 171, virtualQuote: 245, minLen: 261 };

export function decodePool(data) {
  if (!data || data.length < POOL_LAYOUT.minLen) return null;
  const vq = data.readBigInt64LE(POOL_LAYOUT.virtualQuote); // low 64 bits of the i128: ~17.6 SOL in practice
  return {
    baseAccount: new PublicKey(data.subarray(POOL_LAYOUT.baseAccount, POOL_LAYOUT.baseAccount + 32)),
    quoteAccount: new PublicKey(data.subarray(POOL_LAYOUT.quoteAccount, POOL_LAYOUT.quoteAccount + 32)),
    virtualQuoteReserves: vq < 0n ? 0n : vq,
  };
}

/** BondingCurve layout: disc 8 | virtual_token u64 | virtual_sol u64 | real_token | real_sol | supply | complete u8 */
export function decodeCurve(data) {
  if (!data || data.length < 49) return null;
  return { virtualToken: data.readBigUInt64LE(8), virtualQuote: data.readBigUInt64LE(16), realToken: data.readBigUInt64LE(24), complete: data[48] === 1 };
}

/**
 * The coin's market cap in SOL and where it trades, or null when nothing can price it.
 * @returns { venue: "pump.fun" | "PumpSwap", marketCapSol, priceSol } | null
 */
// pump.fun's Global initial_real_token_reserves (793.1M of 1B) — the default when the caller has no live Global
export const PUMP_INITIAL_REAL_TOKENS = 793_100_000;
/**
 * `quote`: for a coin paired with a custom pair (lib/pairs.mjs), { mint, decimals, solPerUnit } — its curve and
 * pool are in PAIR units, so prices are converted to SOL at `solPerUnit` (the pair's USD price ÷ SOL's).
 * ⛔ Without it a WBTC-paired coin's curve would be read as if WBTC units were lamports. Unpriceable → null.
 */
export async function pumpMarketCap(conn, mint, { initialRealTokens = PUMP_INITIAL_REAL_TOKENS, quote = null } = {}) {
  if (quote && !(quote.solPerUnit > 0 && Number.isInteger(quote.decimals))) return null;
  const quoteToSol = (raw) => (quote ? (raw / 10 ** quote.decimals) * quote.solPerUnit : raw / 1e9);
  mint = new PublicKey(mint);
  const [curveInfo, mint22] = await Promise.all([
    conn.getAccountInfo(bondingCurvePda(mint), "confirmed"),
    getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null),
  ]);
  // our graduations are create_v2 (Token-2022); a coin made on pump.fun's own site may be the older SPL kind
  const mintInfo = mint22 ?? (await getMint(conn, mint, "confirmed", TOKEN_PROGRAM_ID).catch(() => null));
  if (!mintInfo) return null;
  const supply = Number(mintInfo.supply) / 10 ** mintInfo.decimals;
  const curve = decodeCurve(curveInfo?.data);
  if (curve && !curve.complete && curve.virtualToken > 0n) {
    const price = quoteToSol(Number(curve.virtualQuote)) / (Number(curve.virtualToken) / 10 ** mintInfo.decimals);
    // how far along pump.fun's curve: tokens sold of the tokens it started with (pump.fun's own measure)
    const start = initialRealTokens ? initialRealTokens * 10 ** mintInfo.decimals : null;
    const progress = start ? Math.min(1, Math.max(0, 1 - Number(curve.realToken) / start)) : null;
    return { venue: "pump.fun", priceSol: price, marketCapSol: price * supply, progress };
  }
  // filled: the pool. Index 0 on every migration seen; walk a few before concluding there is none.
  for (let index = 0; index < 3; index++) {
    const poolAddr = index === 0 ? (quote ? canonicalPumpPoolPdaWithQuote(mint, new PublicKey(quote.mint)) : canonicalPumpPoolPda(mint)) : null;
    if (!poolAddr) break;
    const pool = decodePool((await conn.getAccountInfo(poolAddr, "confirmed"))?.data);
    if (!pool) continue;
    const [b, q] = await Promise.all([conn.getTokenAccountBalance(pool.baseAccount, "confirmed").catch(() => null), conn.getTokenAccountBalance(pool.quoteAccount, "confirmed").catch(() => null)]);
    if (!b || !q || Number(b.value.amount) === 0) return null;
    const quoteSol = quoteToSol(Number(q.value.amount) + Number(pool.virtualQuoteReserves));
    const base = Number(b.value.amount) / 10 ** mintInfo.decimals;
    const price = quoteSol / base;
    return { venue: "PumpSwap", priceSol: price, marketCapSol: price * supply, progress: 1 };
  }
  return null;
}
