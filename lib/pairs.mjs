// Custom pairs: a Hooker token can graduate into a pump.fun coin paired with a token from pump.fun's own
// custom-pair list (the `quote-control` account: BTC, ETH, PUMP, xStocks, …) instead of SOL.
//
// WHICH tokens: pump.fun's quote-control list, read from chain (never a list of our own), filtered to
// those with at least MIN_LIQUIDITY_USD of liquidity (operator, 4 Oct 2026: "the 41 with ≥ $1M"), because
// at graduation up to ~85 SOL is swapped into the pair and a thin market would cost holders.
// WHAT they are called / look like / are worth: Jupiter's token API (display only).
// HOW the SOL becomes the pair token: a Jupiter swap made by the graduation service, bounded by a
// minimum output and a price-impact ceiling; if any check fails at graduation the coin graduates
// against SOL instead (never at a bad price).
//
// ⛔ Token-2022 pair tokens (xStocks) can carry a transfer hook, freeze new accounts by default, or be
// paused by their issuer. Any of those, now or at graduation, and the pair is not used.
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint, getTransferHook, getDefaultAccountState, AccountState, getExtensionData, ExtensionType } from "@solana/spl-token";
import { createRequire } from "node:module";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
const { OnlinePumpSdk, pumpIdl } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

export const MIN_LIQUIDITY_USD = Number(process.env.PAIR_MIN_LIQUIDITY_USD ?? 1_000_000);
/** Price impact the graduation swap may cost, in percent; above it the coin graduates against SOL. */
export const MAX_IMPACT_PCT = Number(process.env.PAIR_MAX_IMPACT_PCT ?? 2);
export const SWAP_SLIPPAGE_BPS = Number(process.env.PAIR_SLIPPAGE_BPS ?? 100);
/** pump.fun's own bound on a configurable creator fee (Global.max_configurable_creator_fee_bps = 300 on 4 Oct 2026). */
export const MAX_CREATOR_FEE_BPS = 300;
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const JUP = process.env.JUPITER_API || "https://lite-api.jup.ag";

/**
 * The launch transaction's public note: what the creator chose, readable by anyone on an explorer.
 * Compact on purpose ("hk:<pair mint>:<creator fee bps>", ≤ 51 bytes): the largest launch is near Solana's
 * 1,232-byte limit. A launch that still does not fit with it goes out without it (server/api.mjs); the
 * graduation always uses the ledger's record, written by the same request.
 */
export const pairMemo = (pair, creatorFeeBps) => `hk:${pair}:${creatorFeeBps ?? 0}`;
export function parsePairMemo(text) {
  const m = /^hk:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d{1,3})$/.exec(String(text ?? "").trim());
  return m ? { pair: m[1], creatorFeeBps: Number(m[2]) } : null;
}

/** Why a pair token's mint cannot be used right now, or null. Classic SPL tokens have none of these. */
export function mintProblem(info) {
  if (!info) return "the pair token does not exist";
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return null;
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) return "not a token";
  let m;
  try { m = unpackMint(PublicKey.default, info, TOKEN_2022_PROGRAM_ID); } catch { return "unreadable mint"; }
  const hook = getTransferHook(m);
  if (hook && !hook.programId.equals(PublicKey.default)) return "the pair token has a transfer hook";
  const das = getDefaultAccountState(m);
  if (das && das.state === AccountState.Frozen) return "the pair token freezes new accounts";
  const paused = getExtensionData(ExtensionType.PausableConfig, m.tlvData);
  if (paused && paused[paused.length - 1] === 1) return "the pair token is paused";
  return null;
}

/**
 * The pairs a creator may pick now: on pump.fun's list, ≥ MIN_LIQUIDITY_USD, mint usable.
 * @returns [{ mint, symbol, name, icon, decimals, tokenProgram, usdPrice, liquidity, initialVirtualQuote }]
 */
export async function listPairs(conn, { fetchImpl = fetch, minLiquidity = MIN_LIQUIDITY_USD } = {}) {
  const qc = await new OnlinePumpSdk(conn).fetchQuoteControl();
  if (!qc) throw new Error("pump.fun's quote-control list is unreadable");
  const listed = new Map(qc.mints.map((e) => [e.mint.toBase58(), e.initialVirtualQuoteReserves.toString()]));
  const mints = [...listed.keys()], meta = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const r = await fetchImpl(`${JUP}/tokens/v2/search?query=${mints.slice(i, i + 100).join(",")}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Jupiter tokens answered ${r.status}`);
    for (const t of await r.json()) if (listed.has(t.id)) meta.set(t.id, t);
  }
  const rich = mints.map((m) => meta.get(m)).filter((t) => t && Number(t.liquidity) >= minLiquidity && Number.isInteger(Number(t.decimals)));
  const infos = await conn.getMultipleAccountsInfo(rich.map((t) => new PublicKey(t.id)), "confirmed");
  return rich.map((t, i) => ({ t, problem: mintProblem(infos[i]), prog: infos[i]?.owner }))
    .filter((x) => !x.problem)
    .map(({ t, prog }) => ({
      mint: t.id, symbol: String(t.symbol ?? "").slice(0, 16), name: String(t.name ?? "").slice(0, 48),
      icon: typeof t.icon === "string" && /^https:\/\//i.test(t.icon) ? t.icon.slice(0, 300) : null,
      decimals: Number(t.decimals), tokenProgram: prog.toBase58(),
      usdPrice: Number(t.usdPrice) > 0 ? Number(t.usdPrice) : null, liquidity: Math.round(Number(t.liquidity)),
      initialVirtualQuote: listed.get(t.id),
    }))
    .sort((a, b) => b.liquidity - a.liquidity);
}

/**
 * Whether `pair` can be used for a graduation NOW: still on pump.fun's list, still liquid, mint still
 * clean, and a route for `lamports` SOL that costs at most MAX_IMPACT_PCT. Returns the quote to swap with.
 * @returns { ok: true, quote, tokenProgram, decimals } | { ok: false, why }
 */
export async function checkPairForGraduation(conn, pair, lamports, { fetchImpl = fetch, minLiquidity = MIN_LIQUIDITY_USD, maxImpactPct = MAX_IMPACT_PCT, creatorFeeBps = 0 } = {}) {
  try {
    const sdk = new OnlinePumpSdk(conn);
    const qc = await sdk.fetchQuoteControl();
    if (!qc?.mints.some((e) => e.mint.toBase58() === pair)) return { ok: false, why: "no longer on pump.fun's custom-pair list" };
    const info = await conn.getAccountInfo(new PublicKey(pair), "confirmed");
    const problem = mintProblem(info);
    if (problem) return { ok: false, why: problem };
    const meta = await (await fetchImpl(`${JUP}/tokens/v2/search?query=${pair}`, { signal: AbortSignal.timeout(10_000) })).json();
    const t = meta.find?.((x) => x.id === pair);
    if (!t || Number(t.liquidity) < minLiquidity) return { ok: false, why: `liquidity under $${minLiquidity.toLocaleString()}` };
    const quote = await jupiterQuote(pair, lamports, { fetchImpl });
    const impact = Number(quote.priceImpactPct) * 100;
    if (!(impact <= maxImpactPct)) return { ok: false, why: `the swap would cost ${impact.toFixed(2)}% in price impact` };
    // the creator fee pump.fun allows on such a coin right now (it can switch it off or lower the cap)
    let feeBps = creatorFeeBps;
    if (feeBps > 0) {
      const g = await sdk.fetchGlobal();
      const max = g.creatorFeeConfigurable ? Number(g.maxConfigurableCreatorFeeBps ?? 0) : 0;
      if (feeBps > max) feeBps = max;
    }
    return { ok: true, quote, tokenProgram: info.owner, decimals: Number(t.decimals), creatorFeeBps: feeBps };
  } catch (e) {
    // ⛔ a network blip (Jupiter, the RPC) says nothing about the pair: try again later, never fall back for it
    return { ok: false, transient: true, why: `check failed: ${String(e.message).slice(0, 100)}` };
  }
}

const WSOL = "So11111111111111111111111111111111111111112";
export async function jupiterQuote(pair, lamports, { fetchImpl = fetch, slippageBps = SWAP_SLIPPAGE_BPS } = {}) {
  const r = await fetchImpl(`${JUP}/swap/v1/quote?inputMint=${WSOL}&outputMint=${pair}&amount=${lamports}&slippageBps=${slippageBps}&swapMode=ExactIn&restrictIntermediateTokens=true`, { signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.outAmount) throw new Error(`Jupiter quote: ${j.error ?? r.status}`);
  return j;
}

/** The swap transaction for a quote, paid and signed by `user` (the hot wallet). Its own min-out is the quote's. */
export async function jupiterSwapTx(quote, user, { fetchImpl = fetch, priorityLamports = 200_000 } = {}) {
  const r = await fetchImpl(`${JUP}/swap/v1/swap`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: user.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: priorityLamports, priorityLevel: "high" } } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.swapTransaction) throw new Error(`Jupiter swap: ${j.error ?? r.status}`);
  return VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, "base64"));
}

/**
 * The pair-token accounts a pump.fun buy_v2 / sell_v2 pays into that must already exist (fee and buyback wallets,
 * creator vault, volume tracker, the user's): idempotent creations for each, ready to send FIRST.
 * ⛔ Found BY NAME in pump.fun's IDL ("associated_X" owned by "X") and kept only if the address derives to exactly
 * that account for the pair token: positions differ between buy_v2 and sell_v2, and may change in a pump.fun upgrade.
 * The fee wallet is picked at random per build, so call this with the very instruction you will send.
 */
export function pairAccountSetup(ix, ixName, quoteMint, quoteProgram, payer) {
  const def = pumpIdl.instructions.find((i) => i.name === ixName);
  if (!def) throw new Error(`pump.fun IDL has no ${ixName}`);
  const at = Object.fromEntries(def.accounts.map((a, i) => [a.name, ix.keys[i]?.pubkey]));
  const out = [];
  for (const a of def.accounts) {
    const m = /^associated_(?:quote_)?(.+)$/.exec(a.name);
    const owner = m && at[m[1]], key = at[a.name];
    if (!owner || !key) continue;
    if (!getAssociatedTokenAddressSync(quoteMint, owner, true, quoteProgram).equals(key)) continue; // a base-mint account, or not an ATA
    out.push(createAssociatedTokenAccountIdempotentInstruction(payer, key, owner, quoteMint, quoteProgram));
  }
  return out;
}
