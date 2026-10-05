// The burn: every coin that graduates through Hooker names the burn wallet as its creator (unless its creator chose
// "creator fees to holders"), so the coin's creator fees on pump.fun and PumpSwap land in the burn wallet's creator
// vault. This keeper, run by the graduator every FLYWHEEL_MS, claims that vault and buys $HOOKER with it on PumpSwap
// and burns it, in one transaction. Every claim and burn is a row in the `burns` ledger (GET /api/burns).
//
// ⛔ The burn wallet must be a wallet of its own: pump.fun keeps ONE creator vault per wallet, so a wallet that is
// also the creator of $HOOKER itself (or of anything else) would mix those fees in. `assertSeparate` refuses that.
// ⛔ FLYWHEEL_DRY=1: every transaction is built and simulated on chain, nothing is sent, rows are marked dry.
import { PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { createBurnInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { createRequire } from "node:module";
import BN from "bn.js";
import { sendRemembered, priorityFee, withPriority } from "./chain.mjs";
const require = createRequire(import.meta.url);
const { OnlinePumpSdk } = require("@pump-fun/pump-sdk");
const { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda, buyQuoteInput } = require("@pump-fun/pump-swap-sdk");

/** Below this the keeper waits: a buy costs a transaction and PumpSwap's fee, dust is not worth it. */
export const MIN_BUY_LAMPORTS = BigInt(Math.round(Number(process.env.FLYWHEEL_MIN_SOL ?? 0.05) * 1e9));
/** What the burn wallet always keeps: rent for its token account and fees for the next transactions. */
export const KEEP_LAMPORTS = 20_000_000n;
/** The pump.fun creator vault is a system account that must keep its rent: claim only what is above it. */
const VAULT_RENT = 890_880n;
export const SLIPPAGE_PCT = 5;

/** Wallets the burn wallet must never be: $HOOKER's own creator (its fees are not ours) and the platform's hot wallet. */
export function assertSeparate(burn, { hookerCreator, platform } = {}) {
  if (hookerCreator && burn.equals(hookerCreator)) throw new Error("the burn wallet is $HOOKER's creator wallet: pump.fun would mix $HOOKER's own fees into the burn");
  if (platform && burn.equals(platform)) throw new Error("the burn wallet is the platform's hot wallet");
}

/** How much of a wallet balance a buy may spend. */
export const spendable = (lamports) => (lamports > KEEP_LAMPORTS ? lamports - KEEP_LAMPORTS : 0n);

export function createFlywheel({ conn, db, burn, burnPubkey = burn?.publicKey, hookerMint, dry = !burn, log = (...a) => console.log(new Date().toISOString(), ...a), hookerCreator = null, platform = null }) {
  if (!burnPubkey) throw new Error("no burn wallet");
  assertSeparate(burnPubkey, { hookerCreator, platform });
  const pump = new OnlinePumpSdk(conn);
  const amm = new OnlinePumpAmmSdk(conn);
  const pool = canonicalPumpPoolPda(hookerMint);
  const record = (row) => db.prepare("INSERT INTO burns (at, kind, sig, dry, lamports_in, lamports_spent, hooker_burned, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(Math.floor(Date.now() / 1000), row.kind, row.sig ?? null, dry ? 1 : 0, row.lamportsIn?.toString() ?? null, row.lamportsSpent?.toString() ?? null, row.hookerBurned?.toString() ?? null, row.note ?? null);

  async function sendOrSimulate(tx, what) {
    if (dry) {
      // a legacy transaction: web3.js simulates it unsigned (no config object allowed on this path); the blockhash was just set
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) throw new Error(`${what}: simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
      return `dry:${what}:${Date.now()}`;
    }
    return sendRemembered(conn, tx, [burn], () => {});
  }

  /** The pump.fun + PumpSwap creator fees waiting for the burn wallet, in SOL lamports (other quotes listed as is). */
  async function waiting() {
    const vault = await pump.getCreatorVaultQuoteBalances(burnPubkey).catch(() => []);
    const sol = vault.find((b) => b.mint.equals(NATIVE_MINT));
    const lamports = BigInt(sol?.total?.toString() ?? "0");
    const others = vault.filter((b) => !b.mint.equals(NATIVE_MINT) && BigInt(b.total?.toString() ?? "0") > 0n).map((b) => ({ mint: b.mint.toBase58(), amount: b.total.toString() }));
    return { lamports: lamports > VAULT_RENT ? lamports - VAULT_RENT : 0n, others };
  }

  /** Step 1: claim the creator vault into the burn wallet. */
  async function claim() {
    const { lamports } = await waiting();
    if (lamports < 5_000_000n) return null; // under 0.005 SOL: wait for more
    const ixs = await pump.collectCoinCreatorFeeAllQuotesInstructions(burnPubkey, burnPubkey);
    if (!ixs.length) return null;
    const tx = new Transaction();
    tx.add(...ixs);
    tx.feePayer = burnPubkey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    withPriority(tx, 400_000, await priorityFee(conn));
    const sig = await sendOrSimulate(tx, "claim");
    record({ kind: "claim", sig, lamportsIn: lamports });
    log(`burn: claimed ${Number(lamports) / 1e9} SOL of creator fees into the burn wallet${dry ? " (dry)" : ""} ${sig}`);
    return lamports;
  }

  /** Step 2: buy $HOOKER on PumpSwap with everything above the float and burn it, one transaction. */
  async function buyAndBurn() {
    const balance = BigInt(await conn.getBalance(burnPubkey, "confirmed"));
    const spend = spendable(balance);
    if (spend < MIN_BUY_LAMPORTS) return null;
    const state = await amm.swapSolanaState(pool, burnPubkey);
    // exact tokens out for up to `spend` in (with slippage): the SDK sizes the buy from the quote
    const budget = new BN(((spend * 100n) / BigInt(100 + SLIPPAGE_PCT)).toString()); // so maxQuote with slippage stays within spend
    const { base, maxQuote } = buyQuoteInput({
      quote: budget, slippage: SLIPPAGE_PCT, baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount, virtualQuoteReserves: state.pool.virtualQuoteReserves,
      baseMintAccount: state.baseMintAccount, baseMint: state.baseMint, coinCreator: state.pool.coinCreator, creator: state.pool.creator,
      feeConfig: state.feeConfig, globalConfig: state.globalConfig, quoteMint: state.pool.quoteMint, isMayhemMode: state.pool.isMayhemMode, creatorFeeBps: state.pool.creatorFeeBps,
    });
    if (base.isZero()) return null;
    const ixs = await PUMP_AMM_SDK.buyInstructions(state, base, maxQuote);
    const ata = getAssociatedTokenAddressSync(hookerMint, burnPubkey, true, TOKEN_2022_PROGRAM_ID);
    const tx = new Transaction();
    tx.add(...ixs, createBurnInstruction(ata, hookerMint, burnPubkey, BigInt(base.toString()), [], TOKEN_2022_PROGRAM_ID));
    tx.feePayer = burnPubkey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    withPriority(tx, 400_000, await priorityFee(conn));
    const sig = await sendOrSimulate(tx, "buy+burn");
    record({ kind: "burn", sig, lamportsSpent: BigInt(maxQuote.toString()), hookerBurned: BigInt(base.toString()) });
    log(`burn: bought and burned ${Number(base.toString()) / 1e6} $HOOKER for up to ${Number(maxQuote.toString()) / 1e9} SOL${dry ? " (dry)" : ""} ${sig}`);
    return base;
  }

  /** One pass: claim what is waiting, then buy and burn what the wallet holds. Errors are logged, never thrown. */
  async function tick() {
    try { await claim(); } catch (e) { log(`⚠ burn: claim failed: ${e.message}`); }
    try { await buyAndBurn(); } catch (e) { log(`⚠ burn: buy failed: ${e.message}`); }
  }

  /** For GET /api/burns: totals and the latest rows. Dry rows are shown apart. */
  function ledger(limit = 50) {
    const rows = db.prepare("SELECT * FROM burns ORDER BY id DESC LIMIT ?").all(limit);
    const t = db.prepare("SELECT COALESCE(SUM(CAST(lamports_spent AS INTEGER)), 0) spent, COALESCE(SUM(CAST(hooker_burned AS INTEGER)), 0) burned, COALESCE(SUM(CAST(lamports_in AS INTEGER)), 0) claimed, COUNT(*) n FROM burns WHERE dry = 0").get();
    return { wallet: burnPubkey.toBase58(), hookerMint: hookerMint.toBase58(), dry, totals: { solSpent: Number(t.spent) / 1e9, hookerBurned: Number(t.burned) / 1e6, solClaimed: Number(t.claimed) / 1e9, rows: t.n }, rows };
  }

  return { tick, claim, buyAndBurn, waiting, ledger, pool, burnPubkey, dry };
}
