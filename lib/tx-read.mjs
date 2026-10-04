/**
 * Reading a transaction, whatever version it is.
 *
 * 🔴🔴 Measured 23 Sep 2026, on mainnet: **version-1 transactions are 153 of 1,208 in a single
 * block — 12.7% of live traffic** — and the installed `@solana/web3.js` (1.98.4) cannot read one at
 * all. Both call shapes fail, for two different reasons:
 *
 *   getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })
 *     -> the RPC refuses:  "Transaction version (1) is not supported by the requesting client"
 *   getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 })
 *     -> the CLIENT refuses: superstruct rejects the response, `version` may only be `legacy | 0`
 *
 * ⛔⛔ Why that mattered enough to add a module for it. `readTransfers` asked for version 0, and it
 * is right to THROW rather than skip a transfer it cannot read — a skipped transfer would be
 * credited out of order later and then refused (`SlotOutOfOrder`). Put those two together and a
 * single version-1 token transfer into a sale's deposit account stopped that sale's attestation for
 * good: no credits, no returns, and after `CREDIT_GRACE` anyone could launch or fail the sale
 * without the credits, leaving money that had arrived but was never booked. One dust transfer, sent
 * by anyone, was enough to do it to a live sale.
 *
 * ⭐ The fix is to stop going through the client's response schema, without going around its
 * PACING. `conn._rpcRequest` is the same path every public method uses, so the `fetchMiddleware`
 * that holds the watcher to 5 requests/s still applies (measured: four calls, 257 ms apart), and it
 * hands back the RPC's own JSON with no schema in the way. That is a private field, deliberately:
 * the alternative was a second unpaced fetch on a key whose limit is a burst limit (PD-13).
 */
import { PublicKey } from '@solana/web3.js'

/**
 * The newest transaction version this code has been read against. Asking for a version ABOVE what
 * exists is harmless — the RPC answers with whatever the transaction really is (checked: 1, 2 and 5
 * all return a version-1 transaction unchanged) — so this is set one clear of mainnet rather than
 * level with it. A transaction newer than this is reported by `readParsedTransaction` instead of
 * being quietly skipped, because the cost of not reading one is a stalled sale.
 */
export const MAX_TX_VERSION = 3

/** Versions whose account layout this code has actually been exercised against. */
export const KNOWN_TX_VERSIONS = new Set(['legacy', 0, 1])

export class TransactionTooNew extends Error {
  constructor(signature, version) {
    super(`transaction ${signature.slice(0, 8)}… is version ${version}, newer than this code has read`)
    this.name = 'TransactionTooNew'
    this.signature = signature
    this.version = version
  }
}

const key = (v) => (v == null ? v : new PublicKey(v))

/**
 * One transaction, in the shape `getParsedTransaction` returns — `accountKeys[].pubkey` and every
 * `programId` as a `PublicKey`, everything else exactly as the RPC sent it.
 *
 * Returns `null` when the RPC does not have the transaction yet. Throws `TransactionTooNew` when it
 * is a version this code has never been read against, so the caller can alert and stop rather than
 * treat an unread transfer as absent.
 */
export async function readParsedTransaction(conn, signature, { commitment = 'confirmed' } = {}) {
  if (typeof conn._rpcRequest !== 'function') {
    // A web3.js upgrade that renames this is a loud failure on purpose: falling back to a plain
    // fetch would leave the call unpaced, and falling back to getParsedTransaction would bring the
    // version-1 stall back.
    throw new Error('conn._rpcRequest is missing — see tx-read.mjs, this read must stay paced')
  }
  const res = await conn._rpcRequest('getTransaction', [signature, {
    encoding: 'jsonParsed', maxSupportedTransactionVersion: MAX_TX_VERSION, commitment,
  }])
  if (res.error) throw new Error(`getTransaction ${signature.slice(0, 8)}…: ${res.error.message}`)
  const tx = res.result
  if (!tx) return null
  if (!KNOWN_TX_VERSIONS.has(tx.version)) throw new TransactionTooNew(signature, tx.version)

  const message = tx.transaction.message
  const fix = (ix) => (ix.programId ? { ...ix, programId: key(ix.programId) } : ix)
  return {
    ...tx,
    transaction: {
      ...tx.transaction,
      message: {
        ...message,
        accountKeys: (message.accountKeys ?? []).map((k) => ({ ...k, pubkey: key(k.pubkey) })),
        instructions: (message.instructions ?? []).map(fix),
      },
    },
    meta: tx.meta && {
      ...tx.meta,
      innerInstructions: (tx.meta.innerInstructions ?? []).map((g) => ({ ...g, instructions: g.instructions.map(fix) })),
    },
  }
}
