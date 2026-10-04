// Graduation settlement: replays the window token's ON-CHAIN history and turns it into each
// holder's pump.fun allocation, applying three rules a Solana transfer hook cannot apply inside
// the swap:
//
//   dynamic fee  — every buy owes feeBps(size) of the tokens it bought → treasury
//   auto burn    — every buy owes burnBps of the tokens it bought      → burned on the pump.fun coin
//   holder share — a pot of pump.fun tokens (bought with window trading fees) streamed by
//                  balance × slots held, up to graduation
//
// What a buy owes travels WITH the tokens: a wallet-to-wallet transfer moves a pro-rata share of
// it to the receiver (so nobody sheds a fee by moving tokens to a fresh wallet), and tokens sold
// back into the curve take their share with them.
//
// ⛔ Balances are tracked per TOKEN ACCOUNT, never per owner: Token-2022 `SetAuthority` changes an
// account's owner without naming the mint, so that change is invisible to the mint's history. Keyed
// by owner, one such account made the replay throw ("history hole") and froze the graduation.
// Accounts are paid to their CURRENT owner, read from chain at settlement (`owners`).
//
// ⛔ A buy or sell is recognised by the Meteora swap instruction in the transaction, never by what
// moved: anyone can deposit SOL into the quote vault or drain the base vault (migrate and
// withdraw_leftover are permissionless), and such a transaction must not pass for the graduating
// buy. The replay ends AT the last swap, so the balances it produces ARE the snapshot.
import { readParsedTransaction } from "./tx-read.mjs";

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
/** Anchor discriminators of Meteora DBC's swap instructions (hex of the first 8 data bytes). */
export const SWAP_DISCRIMINATORS = new Set(["f8c69e91e17587c8", "414b3f4ceb5b5b88", "b75d992818e6c297"]); // swap, swap2, swap2_with_transfer_hook

const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** First 8 bytes of a base58 instruction-data string, as hex (enough to compare discriminators). */
export function discriminatorOf(b58) {
  if (typeof b58 !== "string" || !b58) return null;
  let n = 0n;
  for (const c of b58) { const v = BS58.indexOf(c); if (v < 0) return null; n = n * 58n + BigInt(v); }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let zeros = 0;
  for (const c of b58) { if (c === "1") zeros++; else break; }
  return ("00".repeat(zeros) + hex).slice(0, 16).padEnd(16, "0");
}

/** True when any top-level or inner instruction is a Meteora DBC swap. */
export function hasDbcSwap(tx) {
  const all = [...(tx.transaction.message.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
  return all.some((ix) => String(ix.programId?.toBase58?.() ?? ix.programId) === DBC_PROGRAM_ID && SWAP_DISCRIMINATORS.has(discriminatorOf(ix.data)));
}

/**
 * Reads every transaction that touched the mint, oldest first, after `afterSig` when given (so a
 * retry only fetches what is new). A Token-2022 transfer of a hooked mint always names the mint, so
 * this sees buys, sells AND wallet-to-wallet transfers. Reads raw JSON-RPC (version-1 transactions).
 *
 * Never settles on partial history: a transaction the RPC cannot return is a stop, not a skip.
 * @returns { events: [{ slot, sig, isSwap, deltas: [{ account, owner, amount }], dVault, dQuote }], newestSig }
 */
export async function indexHistory(conn, { mint, baseVault, quoteVault, afterSig = null }) {
  const sigs = [];
  let before;
  for (;;) {
    const page = await conn.getSignaturesForAddress(mint, { before, limit: 1000, until: afterSig ?? undefined }, "confirmed");
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  sigs.reverse(); // oldest first
  const M = mint.toBase58(), BV = baseVault.toBase58(), QV = quoteVault.toBase58();
  const events = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await readParsedTransaction(conn, s.signature);
    if (!tx) throw new Error(`history hole: transaction ${s.signature} cannot be read yet`);
    if (tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const delta = new Map(); // token account → { owner, amount }
    let dVault = 0n, dQuote = 0n;
    const bump = (list, sign) => {
      for (const b of list ?? []) {
        const amt = BigInt(b.uiTokenAmount.amount) * sign;
        const acct = keys[b.accountIndex];
        if (acct === QV) dQuote += amt;
        if (b.mint !== M) continue;
        if (acct === BV) { dVault += amt; continue; }
        const d = delta.get(acct) ?? { owner: b.owner, amount: 0n };
        if (sign > 0n) d.owner = b.owner; // the post-balance names the owner after the transaction
        d.amount += amt;
        delta.set(acct, d);
      }
    };
    bump(tx.meta.postTokenBalances, 1n);
    bump(tx.meta.preTokenBalances, -1n);
    const deltas = [...delta].filter(([, d]) => d.amount !== 0n).map(([account, d]) => ({ account, owner: d.owner, amount: d.amount }));
    events.push({ slot: tx.slot, sig: s.signature, isSwap: hasDbcSwap(tx), deltas, dVault, dQuote });
  }
  return { events, newestSig: sigs.length ? sigs[sigs.length - 1].signature : afterSig };
}

/**
 * The graduating transaction is the LAST swap in which tokens left the curve (a buy). A permissionless
 * migrate or withdraw_leftover also moves tokens out of the vault, and a stranger can deposit SOL into
 * the quote vault: neither carries a swap instruction, so neither can pass for it.
 */
export function cutAtGraduation(events) {
  let g = -1;
  events.forEach((e, i) => { if (e.isSwap && e.dVault < 0n) g = i; });
  if (g < 0) throw new Error("no buy found in the history");
  return { gradSig: events[g].sig, gradSlot: events[g].slot, events: events.slice(0, g + 1).filter((e) => e.deltas.length) };
}

/** JSON round-trip for events (bigints as strings). */
export const eventsToJson = (events) => JSON.stringify(events, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
export const eventsFromJson = (s) => JSON.parse(s, (_, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

/**
 * @param events        from indexHistory (or hand-built in tests)
 * @param pumpBase      pump.fun units bought with the curve's SOL (mapped pro-rata to the snapshot)
 * @param pumpPot       pump.fun units bought with the holder-share fees (streamed by balance × slots)
 * @param feeBps        (lamportsPaid: bigint) => bigint basis points for that buy
 * @param burnBps       bigint basis points burned from every buy
 * @param minAlloc      pump.fun units below which a wallet is not paid: its share is burned
 * @param owners        account → current owner (read from chain at settlement); falls back to the history
 * @param excludeOwners owners that must never be paid (the platform itself, Meteora's authority): burned
 */
export function settle({ events, pumpBase, pumpPot, feeBps, burnBps, minAlloc = 0n, owners = new Map(), excludeOwners = new Set() }) {
  const bal = new Map(), feeOwed = new Map(), burnOwed = new Map(), since = new Map(), weight = new Map(), lastOwner = new Map();
  const get = (m, k) => m.get(k) ?? 0n;
  const sum = (xs) => xs.reduce((s, x) => s + x, 0n);
  const min = (a, b) => (a < b ? a : b);
  const accrue = (a, slot) => { weight.set(a, get(weight, a) + get(bal, a) * BigInt(slot - (since.get(a) ?? slot))); since.set(a, slot); };
  const buys = [];

  for (const e of events) {
    const out = e.deltas.filter((d) => d.amount < 0n), inn = e.deltas.filter((d) => d.amount > 0n);
    const totalOut = sum(out.map((d) => -d.amount)), totalIn = sum(inn.map((d) => d.amount));
    // only a swap moves tokens between holders and the curve; anything else is wallet-to-wallet
    const toCurve = e.isSwap && e.dQuote < 0n ? min(e.dVault > 0n ? e.dVault : 0n, totalOut) : 0n;
    const fromCurve = e.isSwap && e.dQuote > 0n ? totalIn : 0n; // the launch tx mints into the vault AND sells the dev buy out of it
    for (const d of e.deltas) lastOwner.set(d.account, d.owner);

    let carryFee = 0n, carryBurn = 0n;
    for (const { account, amount } of out) {
      accrue(account, e.slot);
      const b = get(bal, account), x = -amount;
      if (x > b) throw new Error(`history hole: account ${account} moves ${x} but holds ${b} (tx ${e.sig})`);
      const f = (get(feeOwed, account) * x) / b, bu = (get(burnOwed, account) * x) / b;
      feeOwed.set(account, get(feeOwed, account) - f);
      burnOwed.set(account, get(burnOwed, account) - bu);
      bal.set(account, b - x);
      carryFee += f; carryBurn += bu;
    }
    if (totalOut > 0n) { carryFee = (carryFee * (totalOut - toCurve)) / totalOut; carryBurn = (carryBurn * (totalOut - toCurve)) / totalOut; }

    const p2pIn = totalIn - fromCurve;
    for (const { account, amount } of inn) {
      accrue(account, e.slot);
      const bought = totalIn > 0n ? (amount * fromCurve) / totalIn : 0n;
      const received = amount - bought;
      let f = 0n, bu = 0n;
      if (bought > 0n) {
        const paid = (e.dQuote * bought) / fromCurve;
        const bps = feeBps(paid);
        f += (bought * bps) / 10_000n;
        bu += (bought * burnBps) / 10_000n;
        buys.push({ account, owner: lastOwner.get(account), sig: e.sig, tokens: bought, sol: paid, feeBps: bps });
      }
      if (received > 0n && p2pIn > 0n) { f += (carryFee * received) / p2pIn; bu += (carryBurn * received) / p2pIn; }
      feeOwed.set(account, get(feeOwed, account) + f);
      burnOwed.set(account, get(burnOwed, account) + bu);
      bal.set(account, get(bal, account) + amount);
    }
  }

  const endSlot = events.length ? events[events.length - 1].slot : 0;
  for (const a of bal.keys()) accrue(a, endSlot);
  const accounts = new Map([...bal].filter(([, b]) => b > 0n)); // the snapshot, per token account
  const snapTotal = sum([...accounts.values()]);
  if (snapTotal === 0n) throw new Error("nothing to settle: no holders at graduation");
  let totalWeight = sum([...weight.values()]);
  const w = totalWeight > 0n ? (a) => get(weight, a) : (a) => get(accounts, a);
  if (totalWeight === 0n) totalWeight = snapTotal;
  const W = (units) => (units * pumpBase) / snapTotal;

  // per account → per current owner
  const ownerOf = (a) => owners.get(a) ?? lastOwner.get(a);
  const byOwner = new Map();
  for (const a of bal.keys()) {
    const o = ownerOf(a);
    const r = byOwner.get(o) ?? { owner: o, window: 0n, gross: 0n, fee: 0n, burn: 0n, reward: 0n };
    const gross = W(get(accounts, a));
    const fee = min(W(get(feeOwed, a)), gross);
    const burn = min(W(get(burnOwed, a)), gross - fee);
    r.window += get(accounts, a); r.gross += gross; r.fee += fee; r.burn += burn; r.reward += (pumpPot * w(a)) / totalWeight;
    byOwner.set(o, r);
  }
  const rows = [];
  let toHolders = 0n, burned = 0n, fees = 0n;
  for (const r of byOwner.values()) {
    let alloc = r.gross - r.fee - r.burn + r.reward, dust = 0n;
    if (alloc > 0n && (alloc < minAlloc || excludeOwners.has(r.owner))) { dust = alloc; alloc = 0n; }
    rows.push({ ...r, burn: r.burn + dust, alloc, dust });
    toHolders += alloc; burned += r.burn + dust; fees += r.fee;
  }
  const holders = new Map(rows.filter((r) => r.window > 0n).map((r) => [r.owner, r.window]));
  const toTreasury = pumpBase + pumpPot - toHolders - burned; // rounding dust → treasury
  return { rows, holders, accounts, buys, toHolders, burned, fees, toTreasury, snapTotal, totalWeight, endSlot };
}
