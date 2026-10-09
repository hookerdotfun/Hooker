// The graduation service. Takes every Hooker launch from "curve filled" to "pump.fun coin in every
// holder's wallet", one idempotent step at a time:
//
//   trading → complete → fee_withdrawn → fees_claimed → indexed → launched → settled → burned
//           → pushed → migrated → done
//
// ⛔ Rules this file keeps:
//  * Every step checks the CHAIN before acting, and every transaction's signature is written to the
//    ledger BEFORE it is sent. After a crash a step either sees its effect on chain, or finds its
//    signature and asks what became of it — it never sends value blind twice.
//  * Amounts are recorded before the transaction that moves them (fees_claimed, pump_spend), so a
//    crash right after sending still knows what moved.
//  * A history the RPC cannot fully return stops settlement; it never settles on a guess.
//  * The push is paid out of the raise (`recipients × PUSH_COST` is held back from the pump.fun buy).
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, getTokenMetadata,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createBurnCheckedInstruction,
} from "@solana/spl-token";
import { DAMM_V2_MIGRATION_FEE_ADDRESS } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createRequire } from "node:module";
// ⚠ pump.fun's SDK through its CommonJS build: its ESM build imports a named export from a CommonJS
// package (`BN` from @coral-xyz/anchor), which Node 22 (the box) refuses and Node 26 allows.
const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getBuySolAmountFromTokenAmount, bondingCurvePda, pumpIdl } = createRequire(import.meta.url)("@pump-fun/pump-sdk");
import BN from "bn.js";
import bs58 from "bs58";
import { getPool, getConfig, poolsByConfig, dbcClient, sendRemembered, fateOf, asLegacy, PARTNER_MIGRATION_FEE_MASK, priorityFee } from "./chain.mjs";
import { pumpStaticKeys, ensureLut, buildV0, v0Size } from "./lut.mjs";
import { launchStaticKeys } from "./launch.mjs";
import { decodeRules, feeBpsFor, hookPdas } from "./rules.mjs";
import { initKings, kingFilter, kingOwedTotal, syncKings, payKings } from "./king.mjs";
import { indexHistory, cutAtGraduation, settle, eventsToJson, eventsFromJson } from "./settle.mjs";
import { PUMPFUN_LIMITS } from "./rules.mjs";
import * as L from "./db.mjs";
import { checkPairForGraduation, jupiterQuote, jupiterSwapTx, pairAccountSetup } from "./pairs.mjs";
import { initVanity, takeForGraduation, importIncoming, incomingDir } from "./vanity.mjs";
import { ensureCustomTable, customPoolCandidates, customConfig, checkCustomConfig } from "./custom-configs.mjs";
const { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda } = createRequire(import.meta.url)("@pump-fun/pump-swap-sdk");

/** Measured: 0.002075 SOL per wallet (token-account rent + a share of the fee and priority fee). */
export const PUSH_COST = 2_300_000n;
/** Measured on the test chain: pump.fun create 0.014 SOL + Meteora migration 0.023 SOL + the burn,
 *  treasury and leftover transactions. Held back from the raise with room for priority fees. */
export const RESERVE = 100_000_000n;
/** A push batch that failed this often is retried one wallet at a time; a wallet that fails this
 *  often alone is given up on and its share burned, so one bad account never stalls everyone. */
const BATCH_RETRIES = 3, WALLET_RETRIES = 6;
const PUMP_DECIMALS = 6;
/** A wallet is paid only if its share is worth at least this many times what sending it costs, so a
 *  swarm of dust wallets can never eat the raise or stall graduation. Its share is burned instead. */
export const MIN_PAYOUT_FACTOR = 3n;
/** What the hot wallet keeps for fees; anything above it is swept to the treasury when idle. */
export const HOT_FLOAT = BigInt(Math.round(Number(process.env.HOT_FLOAT_SOL ?? 1) * 1e9));
/** Statuses during which the hot wallet holds SOL that belongs to a graduation in progress. */
const HOLDING = ["complete", "fee_withdrawn", "fees_claimed", "indexed", "launched", "settled", "burned"];
/** A launch that has failed this many passes in a row is parked as `stalled`: it no longer blocks
 *  the sweep or the other launches, and it needs a person. Un-park by setting its status back. */
export const STALL_AFTER = 30;
/** Statuses from which the pump.fun coin exists and may be shown. */
export const LAUNCHED_STATUSES = new Set(["launched", "settled", "burned", "pushed", "migrated", "done"]);
const PUSH_BATCH = 9;
/** A raise past pump.fun's own graduation by less than this is not worth a PumpSwap buy (it stays in the raise). */
const EXTRA_MIN = 50_000_000n;
/** The PumpSwap buy of a custom cap's extra is quoted on the pool it lands on: 3% covers a trade in between. */
const EXTRA_SLIPPAGE_PCT = 3; // the 64-instruction trace limit: ATA create ≈ 6 inner + 1 transfer

/** The platform's share of the migration fee, with Meteora's own rounding (state/config.rs). */
export function partnerMigrationFee(cfg) {
  const t = BigInt(cfg.migrationQuoteThreshold.toString());
  const quote = (t * BigInt(100 - cfg.migrationFeePercentage) + 99n) / 100n; // rounding up
  const fee = t - quote;
  const creator = (fee * BigInt(cfg.creatorMigrationFeePercentage)) / 100n;
  return fee - creator;
}

export class Graduator {
  /**
   * `pairCheck(conn, pair, lamports)` and `pairSwap({ pair, lamports, user })` → { tx, signers } are the custom-pair
   * steps (lib/pairs.mjs): Jupiter on mainnet; a local test passes a stand-in market.
   */
  constructor({ conn, db, platform, treasury, hookProgram, configs, dataDir = null, burnWallet = null, log = (...a) => console.log(new Date().toISOString(), ...a),
    pairCheck = (conn, pair, lamports, opts = {}) => checkPairForGraduation(conn, pair, lamports, opts),
    pairSwap = async ({ pair, lamports, user, quote }) => ({ tx: await jupiterSwapTx(quote ?? await jupiterQuote(pair, lamports), user.publicKey), signers: [user] }) }) {
    Object.assign(this, { conn, db, platform, treasury, hookProgram, dataDir, burnWallet, log, pairCheck, pairSwap });
    this.setConfigs(configs);
    this.dbc = dbcClient(conn);
    this.pump = new OnlinePumpSdk(conn);
    if (!treasury) throw new Error("TREASURY is not set");
    initVanity(db);
    initKings(db);
    this.kingsOf = kingFilter({ conn, hookProgram });
  }

  /**
   * King of the Hill (lib/king.mjs): copy every playing token's reigns into the ledger and pay the Kings
   * from the hot wallet. Runs for tokens still on their curve and those graduating (their last reign
   * closes with the buy that fills the curve).
   */
  async kingTick() {
    const mints = await this.kingsOf(this.db.prepare("SELECT mint FROM launches WHERE status NOT IN ('done', 'stalled')").all().map((r) => r.mint));
    if (!mints.length) return 0n;
    await syncKings({ conn: this.conn, db: this.db, hookProgram: this.hookProgram, mints, log: this.log });
    return payKings({ conn: this.conn, db: this.db, platform: this.platform, log: this.log });
  }

  /** Hooker's half of the token's trading fees, less what its Kings are owed (they are paid from it). */
  feesAfterKings(l) {
    const left = BigInt(l.fees_claimed) - kingOwedTotal(this.db, l.mint);
    return left > 0n ? left : 0n;
  }

  /** Registers every pool on our configs that the ledger does not know yet (a creator's browser may close mid-launch). */
  /**
   * The configs to watch: a list of { sizeSol, address } (active AND retired: sizes repeat across sets,
   * so this is never keyed by size), or the old size → address map from a test.
   */
  setConfigs(configs) {
    this.configs = Array.isArray(configs) ? configs : Object.entries(configs).map(([g, c]) => ({ sizeSol: Number(g), address: new PublicKey(c) }));
  }

  async discover() {
    const seen = new Set();
    for (const { sizeSol: gradSol, address: config } of this.configs) {
      if (seen.has(config.toBase58())) continue; seen.add(config.toBase58());
      for (const { publicKey, account } of await poolsByConfig(this.dbc, config)) {
        const mint = account.baseMint.toBase58();
        if (L.getLaunch(this.db, mint)) continue;
        const meta = await getTokenMetadata(this.conn, account.baseMint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
        L.registerLaunch(this.db, { mint, pool: publicKey.toBase58(), config: config.toBase58(), creator: account.creator.toBase58(),
          name: meta?.name, symbol: meta?.symbol, uri: meta?.uri, gradSol: Number(gradSol), createdAt: Number(account.activationPoint ?? 0) || L.now() });
        // Meteora's configs are public: a pool made with someone's own transaction skipped every API
        // check. One that pump.fun's create_v2 would refuse, or that has no rules, is parked at once.
        const why = await this.unfit(mint, meta);
        if (why) { L.update(this.db, mint, { status: "stalled", stalled_from: "trading", error: why }); this.log(`⚠ ${mint} parked: ${why}`); continue; }
        this.log(`discovered ${mint} on the ${gradSol} SOL config`);
      }
    }
    await this.discoverCustom();
  }

  /**
   * Pools on custom-cap configs (lib/custom-configs.mjs). Each is made for one mint, so its pool address is known:
   * one batched read covers them all, no program scan. A config that is not exactly the one issued is parked.
   */
  async discoverCustom() {
    ensureCustomTable(this.db);
    const cands = customPoolCandidates(this.db, { since: L.now() - 30 * 86_400 });
    for (let i = 0; i < cands.length; i += 100) {
      const chunk = cands.slice(i, i + 100);
      const infos = await this.conn.getMultipleAccountsInfo(chunk.map((c) => c.pool), "confirmed");
      for (const [j, info] of infos.entries()) {
        if (!info) continue;
        const c = chunk[j], mint = c.mint;
        if (L.getLaunch(this.db, mint)) continue;
        const pool = this.dbc.state.program.coder.accounts.decode("transferHookPool", info.data).poolState;
        const meta = await getTokenMetadata(this.conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
        L.registerLaunch(this.db, { mint, pool: c.pool.toBase58(), config: c.address, creator: pool.creator.toBase58(), name: meta?.name, symbol: meta?.symbol, uri: meta?.uri,
          gradSol: c.grad_sol, noMigration: c.noMigration, capSol: c.cap_sol, createdAt: Number(pool.activationPoint ?? 0) || L.now() });
        const why = checkCustomConfig(await getConfig(this.dbc, new PublicKey(c.address)), c, this.platform.publicKey) ?? await this.unfit(mint, meta);
        if (why) { L.update(this.db, mint, { status: "stalled", stalled_from: "trading", error: why }); this.log(`⚠ ${mint} parked: ${why}`); continue; }
        this.log(`discovered ${mint} on its own ${c.noMigration ? "no-migration" : `${c.cap_sol?.toFixed(1)} SOL cap`} config`);
      }
    }
  }

  /** Why a pool could never graduate cleanly, or null. */
  async unfit(mint, meta) {
    if (!meta?.name || !meta?.symbol || !meta?.uri) return "no token metadata";
    if (meta.name.length > PUMPFUN_LIMITS.name || meta.symbol.length > PUMPFUN_LIMITS.symbol || meta.uri.length > PUMPFUN_LIMITS.uri) return "metadata longer than pump.fun allows";
    let rules;
    try { rules = await this.rules({ mint }); } catch { return "no Hooker rules on the token"; }
    if (!PublicKey.isOnCurve(rules.dev.toBytes())) return "dev wallet is not a wallet";
    return null;
  }

  /**
   * The launches still trading whose curve has filled. All curves are read in ONE batched call per
   * pass (100 per request), and config thresholds are cached: they never change. A pass costs the
   * shared RPC key the same with 1 live token or 100.
   */
  async filledCurves(launches) {
    const filled = new Set();
    for (let i = 0; i < launches.length; i += 100) {
      const chunk = launches.slice(i, i + 100);
      const infos = await this.conn.getMultipleAccountsInfo(chunk.map((l) => new PublicKey(l.pool)), "confirmed");
      for (const [j, info] of infos.entries()) {
        if (!info) continue;
        const p = this.dbc.state.program.coder.accounts.decode("transferHookPool", info.data).poolState;
        const c = await this.cachedConfig(chunk[j].config);
        if (BigInt(p.quoteReserve.toString()) >= BigInt(c.migrationQuoteThreshold.toString())) filled.add(chunk[j].mint);
      }
    }
    return filled;
  }
  configCache = new Map();
  async cachedConfig(addr) {
    if (!this.configCache.has(addr)) this.configCache.set(addr, await getConfig(this.dbc, new PublicKey(addr)));
    return this.configCache.get(addr);
  }

  /** One pass over every unfinished launch. A failing launch backs off; the others carry on.
   *  Returns how many launches finished (reached `done`) in this pass, so the caller knows a sweep is due. */
  async tick() {
    const active = L.activeLaunches(this.db);
    // a no-migration curve can never fill (lib/curve.mjs noMigrationCurve): it is not read every tick
    const filled = await this.filledCurves(active.filter((l) => l.status === "trading" && !l.no_migration));
    let finished = 0;
    for (const l of active.filter((x) => x.status !== "trading" || filled.has(x.mint))) {
      try {
        await this.advance(l.mint);
        L.update(this.db, l.mint, { error: null, attempts: 0, next_try: 0 });
        if (L.getLaunch(this.db, l.mint).status === "done") finished++;
      } catch (e) {
        const cur = L.getLaunch(this.db, l.mint);
        const attempts = (cur.attempts ?? 0) + 1;
        const wait = Math.min(600, 5 * 2 ** Math.min(attempts, 7));
        if (attempts >= STALL_AFTER) {
          L.update(this.db, l.mint, { status: "stalled", stalled_from: cur.status, error: String(e.message).slice(0, 2000), attempts });
          this.log(`🛑 ${l.mint} STALLED at ${cur.status} after ${attempts} failures: ${e.message} — needs a person; the sweep and the other launches carry on`);
          continue;
        }
        L.update(this.db, l.mint, { error: String(e.message).slice(0, 2000), attempts, next_try: L.now() + wait });
        this.log(`⚠ ${l.mint} at ${cur.status}: ${e.message}${e.logs ? "\n" + e.logs.slice(-8).join("\n") : ""}`);
      }
    }
    return finished;
  }

  /**
   * The hot wallet's key lives on the server, so profit must not pile up in it. When no graduation is
   * holding SOL, everything above HOT_FLOAT goes to the cold treasury.
   */
  async sweep() {
    const busy = this.db.prepare(`SELECT COUNT(*) n FROM launches WHERE status IN (${HOLDING.map(() => "?").join(",")})`).get(...HOLDING).n;
    if (busy) return null;
    const balance = BigInt(await this.conn.getBalance(this.platform.publicKey, "confirmed"));
    const excess = balance - HOT_FLOAT;
    if (excess < 100_000_000n) return null; // under 0.1 SOL: not worth a transaction
    const { SystemProgram } = await import("@solana/web3.js");
    const tx = asLegacy([SystemProgram.transfer({ fromPubkey: this.platform.publicKey, toPubkey: this.treasury, lamports: excess })], this.platform.publicKey);
    const sig = await sendRemembered(this.conn, tx, [this.platform], () => {});
    this.log(`swept ${Number(excess) / 1e9} SOL to the treasury (${sig})`);
    return excess;
  }

  /** Runs steps until one cannot finish yet (curve still trading, a transaction still in flight). */
  async advance(mint) {
    for (;;) {
      const l = L.getLaunch(this.db, mint);
      if (l.status === "done") return;
      const before = l.status;
      await this[`step_${l.status}`](l);
      const after = L.getLaunch(this.db, mint).status;
      if (after === before) return;
      this.log(`${mint.slice(0, 8)}… ${before} → ${after}`);
    }
  }

  /**
   * One transaction that must happen exactly once. `isDone()` reads the chain; `build()` returns
   * { tx, signers }. Returns true when the effect is on chain, false when it must wait.
   */
  async once(l, step, isDone, build) {
    const pend = L.getPending(this.db, l.mint, step);
    if (pend) {
      const fate = await fateOf(this.conn, pend.sig, pend.valid_height);
      if (fate === "unknown") return false;
      L.clearPending(this.db, l.mint, step);
      if (fate === "ok") return true;
    }
    if (await isDone()) return true;
    const { tx, signers } = await build();
    try {
      await sendRemembered(this.conn, tx, signers, (sig, h) => L.setPending(this.db, l.mint, step, sig, h));
    } catch (e) {
      if (e.preflight || e.landedFailed) L.clearPending(this.db, l.mint, step);
      throw e;
    }
    L.clearPending(this.db, l.mint, step);
    return true;
  }

  pool = (l) => getPool(this.dbc, new PublicKey(l.pool));
  config = (l) => getConfig(this.dbc, new PublicKey(l.config));
  async rules(l) {
    const a = await this.conn.getAccountInfo(hookPdas(this.hookProgram, l.mint).cfg, "confirmed");
    if (!a || !a.owner.equals(this.hookProgram)) throw new Error("the token has no Hooker rules");
    return decodeRules(a.data);
  }
  tokenBalance = async (ata) => {
    const a = await this.conn.getTokenAccountBalance(ata, "confirmed").catch(() => null);
    return a ? BigInt(a.value.amount) : 0n;
  };

  async step_trading(l) {
    const [p, c] = await Promise.all([this.pool(l), this.cachedConfig(l.config)]);
    if (BigInt(p.quoteReserve.toString()) < BigInt(c.migrationQuoteThreshold.toString())) return;
    L.update(this.db, l.mint, { status: "complete", migration_fee: partnerMigrationFee(c).toString() });
  }

  async step_complete(l) {
    const ok = await this.once(l, "withdraw_fee",
      async () => ((await this.pool(l)).migrationFeeWithdrawStatus & PARTNER_MIGRATION_FEE_MASK) !== 0,
      async () => ({ tx: await this.dbc.partner.partnerWithdrawMigrationFee({ pool: new PublicKey(l.pool), sender: this.platform.publicKey }), signers: [this.platform] }));
    if (ok) L.update(this.db, l.mint, { status: "fee_withdrawn" });
  }

  async step_fee_withdrawn(l) {
    if (l.fees_claimed == null) { // recorded BEFORE the claim moves it
      L.update(this.db, l.mint, { fees_claimed: (await this.pool(l)).partnerQuoteFee.toString() });
      l = L.getLaunch(this.db, l.mint);
    }
    const max = new BN("18446744073709551615");
    const ok = await this.once(l, "claim_fees",
      async () => BigInt((await this.pool(l)).partnerQuoteFee.toString()) === 0n,
      async () => ({ tx: await this.dbc.partner.claimPartnerTradingFee2({ feeClaimer: this.platform.publicKey, payer: this.platform.publicKey, receiver: this.platform.publicKey, pool: new PublicKey(l.pool), maxBaseAmount: max, maxQuoteAmount: max }), signers: [this.platform] }));
    if (ok) L.update(this.db, l.mint, { status: "fees_claimed" });
  }

  async step_fees_claimed(l) {
    const p = await this.pool(l);
    // incremental: what was read on an earlier (failed) pass is kept, only newer transactions are fetched
    const cachedEvents = l.index_cache_json ? eventsFromJson(l.index_cache_json) : [];
    const fresh = await indexHistory(this.conn, { mint: new PublicKey(l.mint), baseVault: p.baseVault, quoteVault: p.quoteVault, afterSig: l.index_cache_sig ?? null });
    const all = [...cachedEvents, ...fresh.events];
    if (fresh.events.length) L.update(this.db, l.mint, { index_cache_json: eventsToJson(all), index_cache_sig: fresh.newestSig });
    const { gradSig, gradSlot, events } = cutAtGraduation(all);
    // who gets paid, valued in lamports before the pump.fun amounts exist: wallets whose share is worth
    // less than MIN_PAYOUT_FACTOR × the cost of sending it are not paid (their share is burned)
    const rules = await this.rules(l);
    // the curve is full, so its last reign is closed: read the final values before taking them out of the fees
    if (rules.kingOn) await syncKings({ conn: this.conn, db: this.db, hookProgram: this.hookProgram, mints: [l.mint], log: this.log });
    const potSol = (this.feesAfterKings(l) * BigInt(rules.holderShareBps)) / 10_000n;
    const probe = settle({ events, pumpBase: BigInt(l.migration_fee), pumpPot: potSol, feeBps: feeBpsFor(rules), burnBps: BigInt(rules.burnBps), minAlloc: MIN_PAYOUT_FACTOR * PUSH_COST });
    const recipients = probe.rows.filter((r) => r.alloc > 0n).length;
    L.update(this.db, l.mint, { status: "indexed", grad_sig: gradSig, grad_slot: gradSlot, events_json: eventsToJson(events), recipients });
  }

  async step_indexed(l) {
    const rules = await this.rules(l);
    const migFee = BigInt(l.migration_fee), fees = this.feesAfterKings(l);
    if (!l.pump_mint) {
      // ⭐ ONE COIN PER TOKEN. The raise alone buys holders a little less than they held (Meteora keeps
      // 1%, pump.fun charges its fee, sending and the reserve cost SOL). The platform's own trading
      // fees close that gap first, as far as they reach; the holder share comes out of what is left.
      const base0 = migFee - BigInt(l.recipients) * PUSH_COST - RESERVE;
      if (base0 <= 0n) throw new Error(`nothing left to buy with: raise ${migFee}, push and reserve ${BigInt(l.recipients) * PUSH_COST + RESERVE}`);
      const held = settle({ events: eventsFromJson(l.events_json), pumpBase: 1n, pumpPot: 0n, feeBps: () => 0n, burnBps: 0n }).snapTotal;
      const { global, feeConfig } = await this.pumpQuoteState();
      let need = 0n;
      // a custom cap past pump.fun's own graduation: more tokens than pump.fun's curve sells, no 1:1 top-up quote
      if (held <= BigInt(global.initialRealTokenReserves.toString())) try { need = BigInt(getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: new BN(held.toString()), quoteMint: NATIVE_MINT }).toString()); }
      catch (e) { this.log(`⚠ ${l.mint}: no quote for the 1:1 top-up (${e.message}); graduating without it`); }
      const topUp = need > base0 ? (need - base0 < fees ? need - base0 : fees) : 0n;
      const potSol = ((fees - topUp) * BigInt(rules.holderShareBps)) / 10_000n;
      const spend = base0 + topUp + potSol;
      // the pump.fun coin's …hook key: from the pool, never shown anywhere before this launch lands
      if (this.dataDir) importIncoming(this.db, incomingDir(this.dataDir));
      const kp = takeForGraduation(this.db, l.mint);
      if (!kp) throw new Error("no hook address ready for the pump.fun coin yet (the grinder is making one)");
      // ⭐ CUSTOM CAP past pump.fun's own graduation (10 Oct 2026): the create+buy fills pump.fun's WHOLE curve, and the rest
      // of the spend buys on PumpSwap once the coin is there (`pump_extra`, step below). A paired coin never gets here (API).
      let extra = 0n;
      if (!l.pair_mint) {
        const full = BigInt(getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: global.initialRealTokenReserves, quoteMint: NATIVE_MINT }).toString());
        if (spend > full + EXTRA_MIN) extra = spend - full;
      }
      L.update(this.db, l.mint, { pump_mint: kp.publicKey.toBase58(), pump_mint_secret: bs58.encode(kp.secretKey), pump_spend: spend.toString(), pump_pot: potSol.toString(), pump_topup: topUp.toString(), held_total: held.toString(), pump_extra: extra.toString() });
      l = L.getLaunch(this.db, l.mint);
    }
    // ⭐ CUSTOM PAIR: SOL → the pair token, before the pump.fun coin exists (holders cannot be front-run: the coin's
    // address is still secret, and the create+buy below stays one transaction).
    // ⛔ 4 Oct 2026 review: what the swap delivered is read from THE SWAP TRANSACTION ITSELF (its own pre/post token
    // balances), never from a before/after balance of the wallet: two graduations into one pair, a failed balance
    // read, or a stranger's deposit cannot bend it. Its signature is in the ledger before it is sent (ledger-first).
    if (l.pair_mint && l.pair_state === "chosen") {
      if (l.pair_sig) {
        const fate = await fateOf(this.conn, l.pair_sig, l.pair_valid);
        if (fate === "unknown") return; // may still land: wait
        if (fate === "ok") {
          const tx = await this.conn.getTransaction(l.pair_sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (!tx?.meta) return; // landed but not readable yet: next pass
          const mine = (bals) => (bals ?? []).filter((b) => b.mint === l.pair_mint && b.owner === this.platform.publicKey.toBase58()).reduce((t, b) => t + BigInt(b.uiTokenAmount.amount), 0n);
          const got = mine(tx.meta.postTokenBalances) - mine(tx.meta.preTokenBalances);
          if (got <= 0n) throw new Error(`the pair swap ${l.pair_sig} landed but delivered nothing`);
          L.update(this.db, l.mint, { pair_state: "swapped", pair_amount: got.toString() });
          this.log(`${l.mint.slice(0, 8)}… swapped ${Number(l.pump_spend) / 1e9} SOL → ${got} units of ${l.pair_mint.slice(0, 8)}… (${l.pair_sig.slice(0, 12)}…)`);
          l = L.getLaunch(this.db, l.mint);
        } else { // "failed" or "expired": nothing was swapped; a fresh attempt below, checked again
          L.update(this.db, l.mint, { pair_sig: null, pair_valid: null });
          l = L.getLaunch(this.db, l.mint);
        }
      }
      if (l.pair_state === "chosen" && !l.pair_sig) {
        // checked before EVERY attempt (still listed, liquid, clean mint, price impact, pump.fun's creator-fee rule);
        // a definite "no" before anything was swapped → the coin graduates against SOL; a network blip → try again
        const c = await this.pairCheck(this.conn, l.pair_mint, BigInt(l.pump_spend), { creatorFeeBps: l.pair_cfee ?? 0 });
        if (!c.ok && c.transient) throw new Error(c.why);
        if (!c.ok) {
          L.update(this.db, l.mint, { pair_state: "fallback", pair_note: c.why });
          this.log(`⚠ ${l.mint.slice(0, 8)}… pair ${l.pair_mint.slice(0, 8)}… not used (${c.why}): graduating against SOL`);
          l = L.getLaunch(this.db, l.mint);
        } else {
          const upd = { pair_program: c.tokenProgram.toBase58() };
          if (c.creatorFeeBps != null && c.creatorFeeBps !== (l.pair_cfee ?? 0)) { upd.pair_cfee = c.creatorFeeBps; this.log(`⚠ ${l.mint.slice(0, 8)}… pump.fun allows a ${c.creatorFeeBps} bps creator fee now, not ${l.pair_cfee}: using ${c.creatorFeeBps}`); }
          L.update(this.db, l.mint, upd);
          const { tx, signers } = await this.pairSwap({ pair: l.pair_mint, lamports: BigInt(l.pump_spend), user: this.platform, quote: c.quote });
          try {
            await sendRemembered(this.conn, tx, signers, (sig, h) => L.update(this.db, l.mint, { pair_sig: sig, pair_valid: h }));
          } catch (e) {
            // only a refused simulation or a landed failure proves nothing was swapped; anything else: fateOf decides
            if (e.preflight || e.landedFailed) L.update(this.db, l.mint, { pair_sig: null, pair_valid: null });
            throw e;
          }
          return; // the next pass reads what it delivered from the transaction itself
        }
      }
    }
    const paired = l.pair_state === "swapped";
    const pumpMint = new PublicKey(l.pump_mint);
    const ata = getAssociatedTokenAddressSync(pumpMint, this.platform.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const ok = await this.once(l, "pump_launch",
      async () => !!(await this.conn.getAccountInfo(bondingCurvePda(pumpMint), "confirmed")),
      async () => {
        const meta = await getTokenMetadata(this.conn, new PublicKey(l.mint), "confirmed", TOKEN_2022_PROGRAM_ID);
        if (!meta?.name || !meta?.symbol || !meta?.uri) throw new Error("the window token has no readable metadata");
        const global = await this.pump.fetchGlobal();
        const feeConfig = await this.pump.fetchFeeConfig();
        // who collects the coin's creator fees on pump.fun: the burn wallet (its fees buy and burn $HOOKER, lib/flywheel.mjs),
        // unless the creator chose "creator fees to holders". Fixed at this launch, public on chain.
        const coinCreator = rules.holderRewards || !this.burnWallet ? new PublicKey(l.creator) : this.burnWallet;
        L.update(this.db, l.mint, { fee_to: rules.holderRewards ? "holders" : this.burnWallet ? "burn" : "creator" });
        let ixs;
        if (paired) {
          // paired with the custom pair: create_v2 + buy_v2 in the pair token, with the creator's pump.fun creator
          // fee (to the holders' rewards account when "creator fees to holders" is on, as create_v2 does it)
          const quoteMint = new PublicKey(l.pair_mint), quoteTokenProgram = new PublicKey(l.pair_program);
          const quoteControl = await this.pump.fetchQuoteControl();
          const quoteAmount = new BN(l.pair_amount);
          const creatorFeeBps = l.pair_cfee ? new BN(l.pair_cfee) : undefined;
          const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: quoteAmount, quoteMint, quoteControl, ...(creatorFeeBps ? { creatorFeeBps } : {}) });
          ixs = await PUMP_SDK.createV2AndBuyV2Instructions({
            global, mint: pumpMint, name: meta.name, symbol: meta.symbol, uri: meta.uri,
            creator: coinCreator, user: this.platform.publicKey, amount, quoteAmount, mayhemMode: false,
            quoteMint, quoteTokenProgram, ...(creatorFeeBps ? { creatorFeeBps } : {}), ...(rules.holderRewards ? { holderReward: true } : {}),
          });
          // ⛔ the buy pays into pair-token accounts that must exist first (fee and buyback wallets', creator vault's,
          // volume tracker's). Read from THIS buy by name (lib/pairs.mjs pairAccountSetup) and made idempotently now;
          // the curve's own account is left to create_v2, which makes it non-idempotently and would fail otherwise.
          const buy = ixs[ixs.length - 1];
          const curveQuote = buy.keys[pumpIdl.instructions.find((i) => i.name === "buy_v2").accounts.findIndex((a) => a.name === "associated_quote_bonding_curve")]?.pubkey;
          const setup = new Transaction().add(...pairAccountSetup(buy, "buy_v2", quoteMint, quoteTokenProgram, this.platform.publicKey)
            .filter((ix) => !curveQuote || !ix.keys[1].pubkey.equals(curveQuote)));
          await sendRemembered(this.conn, setup, [this.platform], () => {});
        } else {
          const solAmount = new BN((BigInt(l.pump_spend) - BigInt(l.pump_extra ?? 0)).toString());
          const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT });
          ixs = await PUMP_SDK.createV2AndBuyInstructions({
            global, mint: pumpMint, name: meta.name, symbol: meta.symbol, uri: meta.uri,
            creator: coinCreator, user: this.platform.publicKey, amount, solAmount, mayhemMode: false,
            ...(rules.holderRewards ? { holderReward: true } : {}), // fixed at launch, in the token's on-chain rules
          });
        }
        const { ComputeBudgetProgram } = await import("@solana/web3.js");
        const lut = await this.ensureLut();
        const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
        const tx = buildV0(this.platform.publicKey, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFee(this.conn) }), ComputeBudgetProgram.setComputeUnitLimit({ units: paired ? 800_000 : 600_000 }), ...ixs], blockhash, [lut]);
        const size = v0Size(tx, 2);
        if (size > 1232) throw new Error(`pump.fun create+buy is ${size} bytes even with the lookup table`);
        return { tx, signers: [this.platform, Keypair.fromSecretKey(bs58.decode(l.pump_mint_secret))] };
      });
    if (!ok) return;
    if (BigInt(l.pump_extra ?? 0) > 0n && !(await this.spendExtra(l, pumpMint, ata))) return;
    // nothing has moved the platform's coins yet (burn and push come after this status)
    const bought = await this.tokenBalance(ata);
    if (bought === 0n) throw new Error("pump.fun coin exists but the platform holds none of it");
    // the base buy comes first on the curve, so it gets the cheaper coins: holders' 1:1 share is what
    // the base SOL alone buys, and the holder-share pot is whatever the rest of the spend bought
    const baseSol = BigInt(l.pump_spend) - BigInt(l.pump_pot);
    const { global: g2, feeConfig: f2 } = await this.pumpQuoteState();
    let baseCoins;
    if (paired) {
      // the same split in pair units: the base share of what the swap delivered
      const basePair = (BigInt(l.pair_amount) * baseSol) / BigInt(l.pump_spend);
      const quoteControl = await this.pump.fetchQuoteControl();
      baseCoins = BigInt(getBuyTokenAmountFromSolAmount({ global: g2, feeConfig: f2, mintSupply: null, bondingCurve: null, amount: new BN(basePair.toString()), quoteMint: new PublicKey(l.pair_mint), quoteControl, ...(l.pair_cfee ? { creatorFeeBps: new BN(l.pair_cfee) } : {}) }).toString());
    } else if (BigInt(l.pump_extra ?? 0) > 0n) baseCoins = (bought * baseSol) / BigInt(l.pump_spend); // curve + PumpSwap: split by SOL spent
    else baseCoins = BigInt(getBuyTokenAmountFromSolAmount({ global: g2, feeConfig: f2, mintSupply: null, bondingCurve: null, amount: new BN(baseSol.toString()), quoteMint: NATIVE_MINT }).toString());
    const pot = BigInt(l.pump_pot) === 0n || baseCoins >= bought ? 0n : bought - baseCoins;
    L.update(this.db, l.mint, { status: "launched", pump_bought: bought.toString(), pump_pot: pot.toString() });
  }

  /**
   * The raise past pump.fun's own graduation (`pump_extra`): the create+buy filled pump.fun's curve, so the coin
   * migrates to PumpSwap (permissionless; pump.fun usually does it within seconds, the graduator does it if not)
   * and the rest of the spend buys there. Both are once-only and read from chain: the pool exists; the platform
   * holds more coins than the create+buy delivered. Returns true when the coins are all bought.
   */
  async spendExtra(l, pumpMint, ata) {
    if (l.pump_curve_bought == null) {
      const got = await this.tokenBalance(ata);
      if (got === 0n) throw new Error("pump.fun coin exists but the platform holds none of it");
      L.update(this.db, l.mint, { pump_curve_bought: got.toString() });
      l = L.getLaunch(this.db, l.mint);
    }
    const poolKey = canonicalPumpPoolPda(pumpMint);
    const { ComputeBudgetProgram } = await import("@solana/web3.js");
    const migrated = await this.once(l, "pump_migrate",
      async () => !!(await this.conn.getAccountInfo(poolKey, "confirmed")),
      async () => {
        const global = await this.pump.fetchGlobal();
        const ix = await PUMP_SDK.migrateInstruction({ withdrawAuthority: global.withdrawAuthority, mint: pumpMint, user: this.platform.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID });
        return { tx: asLegacy([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFee(this.conn) }), ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ix], this.platform.publicKey), signers: [this.platform] };
      });
    if (!migrated) return false;
    const bought = await this.once(l, "pump_extra_buy",
      async () => (await this.tokenBalance(ata)) > BigInt(l.pump_curve_bought),
      async () => {
        const amm = new OnlinePumpAmmSdk(this.conn);
        const state = await amm.swapSolanaState(poolKey, this.platform.publicKey);
        const ixs = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(l.pump_extra), EXTRA_SLIPPAGE_PCT);
        return { tx: asLegacy([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFee(this.conn) }), ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs], this.platform.publicKey), signers: [this.platform] };
      });
    if (bought) this.log(`${l.mint.slice(0, 8)}… bought ${Number(l.pump_extra) / 1e9} SOL more of the coin on PumpSwap (the cap is past pump.fun's own graduation)`);
    return bought;
  }

  /**
   * The lookup table of pump.fun's fixed accounts (lib/lut.mjs), made by the hot wallet once and kept
   * in <dataDir>/lut.json. ⛔ Without it a create+buy with a long metadata URI is over 1,232 bytes.
   */
  async ensureLut() {
    if (this.lut) return this.lut;
    const { global, feeConfig } = await this.pumpQuoteState();
    const live = this.configs.filter((c) => !c.retired).map((c) => c.address);
    const keys = [...await pumpStaticKeys({ global, feeConfig }), ...(live.length ? await launchStaticKeys({ dbc: this.dbc, hookProgram: this.hookProgram, configs: live }) : [])];
    this.lut = await ensureLut({ conn: this.conn, payer: this.platform, keys, file: this.dataDir ? `${this.dataDir}/lut.json` : null, log: this.log });
    return this.lut;
  }

  /** pump.fun's Global and fee config, for quotes (both change rarely; read fresh per graduation step). */
  async pumpQuoteState() {
    return { global: await this.pump.fetchGlobal(), feeConfig: await this.pump.fetchFeeConfig() };
  }

  async step_launched(l) {
    const rules = await this.rules(l);
    const bought = BigInt(l.pump_bought), pot = BigInt(l.pump_pot);
    // the same dust line as the probe, in pump.fun units: alloc × spend / bought ≥ factor × push cost
    const minAlloc = (MIN_PAYOUT_FACTOR * PUSH_COST * bought) / BigInt(l.pump_spend);
    // each token account is paid to its CURRENT owner (SetAuthority is invisible to the mint's history)
    const events = eventsFromJson(l.events_json);
    const accounts = [...new Set(events.flatMap((e) => e.deltas.map((d) => d.account)))];
    const owners = new Map();
    for (let i = 0; i < accounts.length; i += 100) {
      const chunk = accounts.slice(i, i + 100);
      const infos = await this.conn.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)), "confirmed");
      infos.forEach((info, j) => { if (info && info.data.length >= 64) owners.set(chunk[j], new PublicKey(info.data.subarray(32, 64)).toBase58()); });
    }
    const excludeOwners = new Set([this.platform.publicKey.toBase58(), "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"]);
    const s = settle({ events, pumpBase: bought - pot, pumpPot: pot, feeBps: feeBpsFor(rules), burnBps: BigInt(rules.burnBps), minAlloc, owners, excludeOwners });
    if (s.toHolders + s.burned + s.toTreasury !== bought) throw new Error("settlement does not add up");
    const summary = { holders: s.holders.size, buys: s.buys.length, fees: s.fees.toString(), burned: s.burned.toString(), toHolders: s.toHolders.toString(), pot: pot.toString(),
      held: (l.held_total ?? s.snapTotal).toString(), base: (bought - pot).toString(), topUp: (l.pump_topup ?? "0").toString() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ins = this.db.prepare("INSERT OR IGNORE INTO pushes (mint, owner, amount) VALUES (?, ?, ?)");
      for (const r of s.rows) if (r.alloc > 0n) ins.run(l.mint, r.owner, r.alloc.toString());
      L.update(this.db, l.mint, { status: "settled", burn: s.burned.toString(), treasury_amt: s.toTreasury.toString(), settle_json: JSON.stringify(summary) });
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  async step_settled(l) {
    const pumpMint = new PublicKey(l.pump_mint);
    const ata = getAssociatedTokenAddressSync(pumpMint, this.platform.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const burn = BigInt(l.burn), toTreasury = BigInt(l.treasury_amt);
    const expectAfter = BigInt(l.pump_bought) - burn - toTreasury;
    const ok = await this.once(l, "burn_treasury",
      async () => (await this.tokenBalance(ata)) === expectAfter,
      async () => {
        const ixs = [];
        if (burn > 0n) ixs.push(createBurnCheckedInstruction(ata, pumpMint, this.platform.publicKey, burn, PUMP_DECIMALS, [], TOKEN_2022_PROGRAM_ID));
        if (toTreasury > 0n) {
          const tAta = getAssociatedTokenAddressSync(pumpMint, this.treasury, true, TOKEN_2022_PROGRAM_ID);
          ixs.push(createAssociatedTokenAccountIdempotentInstruction(this.platform.publicKey, tAta, this.treasury, pumpMint, TOKEN_2022_PROGRAM_ID),
                   createTransferCheckedInstruction(ata, pumpMint, tAta, this.platform.publicKey, toTreasury, PUMP_DECIMALS, [], TOKEN_2022_PROGRAM_ID));
        }
        return { tx: asLegacy(ixs, this.platform.publicKey), signers: [this.platform] };
      });
    if (ok) L.update(this.db, l.mint, { status: "burned" });
  }

  async step_burned(l) {
    const rows = () => this.db.prepare("SELECT * FROM pushes WHERE mint = ?").all(l.mint);
    // 1. settle in-flight batches first
    const inflight = new Map();
    for (const r of rows().filter((r) => r.status === "sending")) inflight.set(r.sig, r.valid_height);
    for (const [sig, h] of inflight) {
      const fate = await fateOf(this.conn, sig, h);
      if (fate === "unknown") return; // wait: it may still land
      this.db.prepare(`UPDATE pushes SET status = ?, sig = ${fate === "ok" ? "sig" : "NULL"} WHERE mint = ? AND sig = ?`).run(fate === "ok" ? "done" : "pending", l.mint, sig);
    }
    // 2. send what is left, nine wallets per transaction; wallets that keep failing go alone
    const pumpMint = new PublicKey(l.pump_mint);
    const ata = getAssociatedTokenAddressSync(pumpMint, this.platform.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const pending = rows().filter((r) => r.status === "pending");
    const batches = [];
    const fresh = pending.filter((r) => r.attempts < BATCH_RETRIES), stale = pending.filter((r) => r.attempts >= BATCH_RETRIES);
    for (let i = 0; i < fresh.length; i += PUSH_BATCH) batches.push(fresh.slice(i, i + PUSH_BATCH));
    for (const r of stale) batches.push([r]);
    for (const batch of batches) {
      if (batch.length === 1 && batch[0].attempts >= WALLET_RETRIES) {
        this.db.prepare("UPDATE pushes SET status = 'failed' WHERE mint = ? AND owner = ?").run(l.mint, batch[0].owner);
        this.log(`⚠ ${l.mint.slice(0, 8)}… giving up on ${batch[0].owner} after ${batch[0].attempts} tries: its ${batch[0].amount} units will be burned`);
        continue;
      }
      const ixs = batch.flatMap((r) => {
        const owner = new PublicKey(r.owner);
        const dest = getAssociatedTokenAddressSync(pumpMint, owner, true, TOKEN_2022_PROGRAM_ID);
        return [createAssociatedTokenAccountIdempotentInstruction(this.platform.publicKey, dest, owner, pumpMint, TOKEN_2022_PROGRAM_ID),
                createTransferCheckedInstruction(ata, pumpMint, dest, this.platform.publicKey, BigInt(r.amount), PUMP_DECIMALS, [], TOKEN_2022_PROGRAM_ID)];
      });
      const { ComputeBudgetProgram } = await import("@solana/web3.js");
      const tx = asLegacy([ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 * batch.length + 20_000 }), ...ixs], this.platform.publicKey);
      const mark = this.db.prepare("UPDATE pushes SET status = 'sending', sig = ?, valid_height = ?, attempts = attempts + 1 WHERE mint = ? AND owner = ?");
      try {
        if (this.sabotage?.(batch)) throw Object.assign(new Error("simulated push failure"), { preflight: true });
        await sendRemembered(this.conn, tx, [this.platform], (sig, h) => {
          this.db.exec("BEGIN IMMEDIATE");
          for (const r of batch) mark.run(sig, h, l.mint, r.owner);
          this.db.exec("COMMIT");
        });
      } catch (e) {
        if (e.preflight || e.landedFailed) for (const r of batch) this.db.prepare("UPDATE pushes SET status = 'pending', sig = NULL, attempts = attempts + 1 WHERE mint = ? AND owner = ?").run(l.mint, r.owner);
        throw e;
      }
      // test hook: die after the batch landed but before the ledger says so (the dangerous moment)
      if (this.crashAfterSend?.(l.mint)) throw new Error("simulated crash after a push landed");
      for (const r of batch) this.db.prepare("UPDATE pushes SET status = 'done' WHERE mint = ? AND owner = ?").run(l.mint, r.owner);
      if (this.onBatch) await this.onBatch(l.mint, batch.length); // test hook: simulate a crash mid-push
    }
    const left = rows().filter((r) => r.status === "pending" || r.status === "sending").length;
    if (left === 0) {
      // shares nobody could be paid are burned: every other holder owns a bigger part of the coin
      const failed = rows().filter((r) => r.status === "failed").reduce((s, r) => s + BigInt(r.amount), 0n);
      const rest = await this.tokenBalance(ata);
      if (rest < failed) throw new Error(`push finished but the platform holds ${rest} units, fewer than the ${failed} unpayable shares`);
      // anything above the unpayable shares was sent to the platform by someone (an airdrop): burned too
      if (rest > failed) { L.update(this.db, l.mint, { surplus_burned: (rest - failed).toString() }); this.log(`${l.mint.slice(0, 8)}… burning ${rest - failed} units someone sent to the platform's account`); }
      if (rest > 0n) {
        const ok = await this.once(l, "burn_failed", async () => (await this.tokenBalance(ata)) === 0n,
          async () => { const amount = await this.tokenBalance(ata); return { tx: asLegacy([createBurnCheckedInstruction(ata, pumpMint, this.platform.publicKey, amount, PUMP_DECIMALS, [], TOKEN_2022_PROGRAM_ID)], this.platform.publicKey), signers: [this.platform] }; });
        if (!ok) return;
      }
      L.update(this.db, l.mint, { status: "pushed" });
    }
  }

  async step_pushed(l) {
    const c = await this.config(l);
    const ok = await this.once(l, "migrate",
      async () => !!(await this.pool(l)).isMigrated,
      async () => {
        const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await this.dbc.migration.migrateToDammV2({
          payer: this.platform.publicKey, pool: new PublicKey(l.pool), dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[c.migrationFeeOption] });
        return { tx: transaction, signers: [this.platform, firstPositionNftKeypair, secondPositionNftKeypair] };
      });
    if (ok) L.update(this.db, l.mint, { status: "migrated" });
  }

  /** The tokens that never went on the curve come to the platform as leftover_receiver: burn them. */
  async step_migrated(l) {
    const mint = new PublicKey(l.mint);
    const ata = getAssociatedTokenAddressSync(mint, this.platform.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const got = await this.once(l, "leftover",
      async () => !!(await this.pool(l)).isWithdrawLeftover,
      async () => ({ tx: await this.dbc.migration.withdrawLeftover({ payer: this.platform.publicKey, pool: new PublicKey(l.pool) }), signers: [this.platform] }));
    if (!got) return;
    const burned = await this.once(l, "leftover_burn",
      async () => (await this.tokenBalance(ata)) === 0n,
      async () => {
        const amount = await this.tokenBalance(ata);
        return { tx: asLegacy([createBurnCheckedInstruction(ata, mint, this.platform.publicKey, amount, 6, [], TOKEN_2022_PROGRAM_ID)], this.platform.publicKey), signers: [this.platform] };
      });
    if (burned) L.update(this.db, l.mint, { status: "done" });
  }
}
