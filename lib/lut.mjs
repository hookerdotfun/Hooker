// The address lookup table that keeps the pump.fun create+buy inside one transaction.
//
// ⛔ MEASURED ON MAINNET (4 Oct 2026): a legacy create_v2+buy is 1,252 bytes with an 80-char IPFS URI
// and 1,399 with the 200-char maximum, over Solana's 1,232. pump.fun's fixed accounts (program, global,
// fee recipient, event authority, fee program and config, mayhem accounts, token programs, …) go in
// one lookup table owned by the hot wallet, made once; every graduation then references them by index.
import { AddressLookupTableProgram, ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import BN from "bn.js";
import { sendRemembered } from "./chain.mjs";
const { PUMP_SDK, getBuyTokenAmountFromSolAmount } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

/**
 * pump.fun's fixed accounts in a create+buy: every key that is the same across different mints,
 * creators and buyers, for both holder-reward settings. Signers are never needed here (they must be
 * in the message itself) but are harmless.
 */
export async function pumpStaticKeys({ global, feeConfig }) {
  const build = async (holderReward) => {
    const mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey, user = Keypair.generate().publicKey;
    const solAmount = new BN(1_000_000_000);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT });
    const ixs = await PUMP_SDK.createV2AndBuyInstructions({ global, mint, name: "x", symbol: "x", uri: "x", creator, user, amount, solAmount, mayhemMode: false, holderReward });
    return new Set(ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]));
  };
  // + what every custom-pair create+buy shares (lib/pairs.mjs): pump.fun's quote-control list and both token programs
  const out = new Set([ComputeBudgetProgram.programId.toBase58(), "6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
  for (const hr of [false, true]) {
    const [a, b] = [await build(hr), await build(hr)];
    for (const k of a) if (b.has(k)) out.add(k);
  }
  return [...out].map((k) => new PublicKey(k));
}

/**
 * The lookup table at `file` (created and recorded if missing), holding every key in `keys`
 * (extended if some are missing). Resolves once the chain will accept it in a transaction.
 */
export async function ensureLut({ conn, payer, keys, file = null, log = () => {} }) {
  let address = file && existsSync(file) ? new PublicKey(JSON.parse(readFileSync(file, "utf8")).address) : null;
  let table = address ? (await conn.getAddressLookupTable(address, { commitment: "confirmed" })).value : null;
  // a table another key made (a rotated hot wallet, a test sharing the folder) cannot be extended: make our own
  if (table && !table.state.authority?.equals(payer.publicKey)) { log(`lookup table ${address.toBase58()} belongs to ${table.state.authority?.toBase58()}, not ${payer.publicKey.toBase58()}: making a new one`); table = null; }
  // one transaction per 20 addresses (each is 32 bytes): the create rides with the first batch
  const txs = [];
  if (!table) {
    // ⛔ the slot must already be in the SlotHashes sysvar: the newest confirmed slot is not, a finalized one is
    const slot = await conn.getSlot("finalized");
    const [createIx, addr] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
    address = addr; txs.push([createIx]);
  }
  const have = new Set((table?.state.addresses ?? []).map((k) => k.toBase58()));
  const missing = keys.filter((k) => !have.has(k.toBase58()));
  for (let i = 0; i < missing.length; i += 20) {
    const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: payer.publicKey, payer: payer.publicKey, addresses: missing.slice(i, i + 20) });
    if (i === 0 && txs.length) txs[0].push(ix); else txs.push([ix]);
  }
  if (txs.length) {
    let sig;
    for (const ixs of txs) { const tx = new Transaction().add(...ixs); tx.feePayer = payer.publicKey; sig = await sendRemembered(conn, tx, [payer], () => {}); }
    log(`lookup table ${address.toBase58()}: ${table ? "extended with" : "created with"} ${missing.length} fixed accounts in ${txs.length} transaction${txs.length === 1 ? "" : "s"} (${sig})`);
    if (file) writeFileSync(file, JSON.stringify({ address: address.toBase58(), madeAt: new Date().toISOString() }, null, 2));
    // ⛔ addresses added in slot S cannot be used before slot S+1: wait for the chain to move on
    for (;;) {
      table = (await conn.getAddressLookupTable(address, { commitment: "confirmed" })).value;
      if (table && table.state.lastExtendedSlot < (await conn.getSlot("confirmed"))) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return table;
}

/** The table recorded at `file`, or null when the graduator has not made one yet. */
export async function loadLut(conn, file) {
  if (!file || !existsSync(file)) return null;
  const { address } = JSON.parse(readFileSync(file, "utf8"));
  return (await conn.getAddressLookupTable(new PublicKey(address), { commitment: "confirmed" })).value;
}

/** A v0 transaction over `luts`, ready for sendRemembered (which sets the blockhash and signs). */
export function buildV0(payer, instructions, blockhash, luts) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(luts));
}

/** Bytes a signed transaction with `nSigners` signatures would take (for checks and tests). */
export const v0Size = (tx, nSigners) => tx.message.serialize().length + 1 + 64 * nSigners;
