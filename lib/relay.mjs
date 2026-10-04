// What /api/send will relay. Not an open relay: only the transactions the site builds.
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { DBC_PROGRAM } from "./chain.mjs";
import { hookPdas } from "./rules.mjs";
import { createHash } from "node:crypto";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const COLLECT = { [PUMP]: [disc("collect_creator_fee"), disc("collect_creator_fee_v2")], [PUMP_AMM]: [disc("collect_coin_creator_fee")] };
/**
 * (c) A creator collecting their pump.fun creator fees (built by POST /api/tx/claim-rewards): only pump.fun's and
 * PumpSwap's collect-creator-fee instructions, idempotent ATA creates, closing a token account (the wSOL unwrap) and
 * compute budget. Every account touched is the signer's own; this is what the SDK's claim builder emits, no more.
 */
export function isPumpCreatorClaim(tx) {
  let collects = 0;
  for (const ix of tx.instructions) {
    const p = ix.programId.toBase58();
    if (p === ComputeBudgetProgram.programId.toBase58()) continue;
    if (p === ATA && ix.data.length === 1 && ix.data[0] === 1) continue; // CreateIdempotent
    if ((p === SPL || p === T22) && ix.data[0] === 9) continue; // CloseAccount (unwrapping the creator's wSOL)
    if (COLLECT[p]?.some((d) => ix.data.subarray(0, 8).equals(d))) { collects++; continue; }
    return false;
  }
  return collects > 0;
}

const LIST_ADD = Buffer.from("hkLstAdd"), LIST_SEAL = Buffer.from("hkLstSel");

/**
 * True for (a) a trade or claim: an instruction of Meteora's curve program touching one of our pools
 * or configs; or (b) a creator's list transaction: nothing but compute-budget instructions and our
 * hook's LIST_ADD / LIST_SEAL on the list of a token launched here.
 * @param known   pools and configs (base58) we built
 * @param mints   mints (base58) launched here
 */
export function isRelayable(tx, { known, mints, hookProgram }) {
  const hook = new PublicKey(hookProgram);
  if (isPumpCreatorClaim(tx)) return true;
  if (tx.instructions.some((ix) => ix.programId.equals(DBC_PROGRAM) && ix.keys.some((k) => known.has(k.pubkey.toBase58())))) return true;
  let listIxs = 0;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    if (!ix.programId.equals(hook)) return false;
    const tag = ix.data.subarray(0, 8);
    if (!tag.equals(LIST_ADD) && !tag.equals(LIST_SEAL)) return false;
    const mint = ix.keys[1]?.pubkey;
    if (!mint || !mints.has(mint.toBase58()) || !ix.keys[3]?.pubkey.equals(hookPdas(hook, mint).list)) return false;
    listIxs++;
  }
  return listIxs > 0;
}
