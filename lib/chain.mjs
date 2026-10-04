// Small chain helpers shared by the services.
import { PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import bs58 from "bs58";

export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const PARTNER_MIGRATION_FEE_MASK = 0b100;

/** Micro-lamports per compute unit added to every transaction, so they land on a busy day too. */
export const PRIORITY_FEE = Number(process.env.PRIORITY_FEE_MICROLAMPORTS ?? 2000);
const CB = ComputeBudgetProgram.programId;
/** Adds a compute-unit price (and a limit if none) to a legacy transaction. Solana refuses duplicate
 *  compute-budget instructions, so each kind is added only when missing. */
export function withPriority(tx, cuLimit = 300_000, price = PRIORITY_FEE) {
  const ixs = tx.instructions;
  const has = (tag) => ixs.some((i) => i.programId.equals(CB) && i.data[0] === tag);
  if (!has(2)) ixs.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  if (price > 0 && !has(3)) ixs.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  return tx;
}

/** Bounds for the live priority fee (micro-lamports per CU): never below the old fixed price, never above
 *  PRIORITY_FEE_MAX (at 250k CU a swap then pays at most 0.0125 SOL in priority). */
export const PRIORITY_FEE_MAX = Number(process.env.PRIORITY_FEE_MAX_MICROLAMPORTS ?? 50_000);
let feeCache = null;
/**
 * What it takes to land on Meteora's program right now: Helius's `getPriorityFeeEstimate` ("High")
 * for the DBC program, cached 15 s, clamped to [PRIORITY_FEE, PRIORITY_FEE_MAX]. Any other RPC (or a
 * failure) gives the fixed PRIORITY_FEE. ⛔ 4 Oct 2026: a buy at the fixed 2,000 never landed.
 */
export async function priorityFee(conn, { now = Date.now() } = {}) {
  if (feeCache && now - feeCache.at < 15_000) return feeCache.price;
  let price = PRIORITY_FEE;
  try {
    const r = await conn._rpcRequest("getPriorityFeeEstimate", [{ accountKeys: [DBC_PROGRAM.toBase58()], options: { priorityLevel: "High" } }]);
    const est = Number(r?.result?.priorityFeeEstimate);
    if (Number.isFinite(est) && est > 0) price = Math.round(est);
  } catch {}
  price = Math.min(PRIORITY_FEE_MAX, Math.max(PRIORITY_FEE, price));
  feeCache = { at: now, price };
  return price;
}

export const dbcClient = (conn) => DynamicBondingCurveClient.create(conn, "confirmed");

/** A DBC pool's state, whether it is a plain pool or a transfer-hook pool ({ poolState }). */
export async function getPool(dbc, pool) {
  const p = await dbc.state.getPool(pool);
  return p ? p.poolState ?? p : null;
}

/** A DBC config's state, unwrapping the transfer-hook variant. */
export async function getConfig(dbc, config) {
  const c = await dbc.state.getPoolConfig(config);
  return c ? c.config ?? c : null;
}

/** Every pool on one of our configs (hook pools included). */
export async function poolsByConfig(dbc, config) {
  return (await dbc.state.getPoolsByConfig(config)).map((p) => ({ publicKey: p.publicKey, account: p.account.poolState ?? p.account }));
}

export const signatureOf = (tx) => bs58.encode(tx instanceof VersionedTransaction ? tx.signatures[0] : tx.signature);

/**
 * Signs and sends a transaction, persisting its signature FIRST through `remember(sig, lastValid)`
 * so a crash between sending and confirming can never cause a blind resend. Returns the signature
 * once confirmed; throws with the program logs if it fails.
 */
export async function sendRemembered(conn, tx, signers, remember) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = blockhash;
    tx.sign(signers);
  } else {
    withPriority(tx, 300_000, await priorityFee(conn)); // the live fee: at a fixed 2,000 a busy network drops it
    tx.recentBlockhash = blockhash;
    tx.feePayer ??= signers[0].publicKey;
    tx.sign(...signers);
  }
  const sig = signatureOf(tx);
  await remember(sig, lastValidBlockHeight);
  const raw = tx.serialize();
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
  } catch (e) {
    const err = new Error(`${e.message}`);
    err.logs = e.transactionLogs ?? e.logs;
    // ⛔ Only a refused simulation proves the transaction never reached the network. A fetch failure,
    // a 5xx or an exhausted 429 may well have forwarded it: then the remembered signature stays and
    // fateOf decides later. Forgetting it here would resend and pay twice.
    err.preflight = /Transaction simulation failed|Simulation failed/.test(String(e.message)) || Array.isArray(err.logs);
    throw err;
  }
  // rebroadcast (same signature, never a double spend) until it confirms or its blockhash expires
  const again = setInterval(() => { conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}); }, 3_000);
  let res;
  try { res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"); }
  finally { clearInterval(again); }
  if (res.value.err) {
    const err = new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
    err.landedFailed = true;
    throw err;
  }
  return sig;
}

/**
 * What became of a remembered signature: "ok", "failed", "expired" (can never land: safe to
 * retry) or "unknown" (may still land: wait).
 */
export async function fateOf(conn, sig, lastValidBlockHeight) {
  const { value: [st] } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
  if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return st.err ? "failed" : "ok";
  const height = await conn.getBlockHeight("confirmed");
  return height > lastValidBlockHeight ? "expired" : "unknown";
}

export const asLegacy = (ixs, payer) => { const t = new Transaction(); t.add(...ixs); t.feePayer = payer; return t; };
