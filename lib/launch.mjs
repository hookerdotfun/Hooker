// Transaction builders for creators and traders. The server builds, the user's wallet signs.
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, Keypair, VersionedTransaction } from "@solana/web3.js";
import { buildV0 } from "./lut.mjs";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { AccountsType, SwapMode, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { encodeInitData, hookPdas, sortWallets, LIST_ADD_MAX, needsState, needsPool } from "./rules.mjs";
import { withPriority } from "./chain.mjs";
import { MEMO_PROGRAM, pairMemo } from "./pairs.mjs";

const INIT = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
const LIST_ADD = Buffer.from("hkLstAdd");
const LIST_SEAL = Buffer.from("hkLstSel");
const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");

/** The hook's init: writes the token's rules. The MINT must sign (the program checks), and the payer is the dev. */
export function hookInitIx({ hookProgram, payer, mint, rules, pool = null }) {
  const { extraAccountMetas, cfg, slot, state } = hookPdas(hookProgram, mint);
  if (needsPool(rules) && !pool) throw new Error("King of the Hill needs the token's pool");
  return new TransactionInstruction({
    programId: hookProgram,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: extraAccountMetas, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: true, isWritable: false },
      { pubkey: cfg, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // anti-bundle: init creates the per-slot buy counter
      ...(rules.bundleMax > 0 ? [{ pubkey: slot, isSigner: false, isWritable: true }] : []),
      // v3 rules that remember something: init creates the state account; King of the Hill reads the pool
      ...(needsState(rules) ? [{ pubkey: state, isSigner: false, isWritable: true }] : []),
      ...(needsPool(rules) ? [{ pubkey: new PublicKey(pool), isSigner: false, isWritable: false }] : []),
    ],
    // ⛔ the dev IS the payer: the compact form takes the dev from the signing payer
    data: Buffer.concat([INIT, encodeInitData({ ...rules, dev: payer })]),
  });
}

/**
 * The accounts Token-2022 appends for a hooked transfer of `mint`, in its order: the resolved extra
 * accounts (cfg PDA, Instructions sysvar, then the list, the slot counter, the v3 state account and,
 * for King of the Hill, the pool, when the token's rules have them), then the hook program, then the
 * validation account. Needed when the mint does not
 * exist yet (a buy in the launch transaction); test/e2e.mjs checks it equals what the SDK resolves
 * from chain once the mint exists.
 */
export function hookTransferAccounts(hookProgram, mint, rules = {}, pool = null) {
  const { extraAccountMetas, cfg, list, slot, state } = hookPdas(hookProgram, mint);
  if (needsPool(rules) && !pool) throw new Error("King of the Hill needs the token's pool");
  return [
    { pubkey: cfg, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    ...(rules.allowlist || rules.blocklist ? [{ pubkey: list, isSigner: false, isWritable: false }] : []),
    ...(rules.bundleMax > 0 ? [{ pubkey: slot, isSigner: false, isWritable: true }] : []),
    ...(needsState(rules) ? [{ pubkey: state, isSigner: false, isWritable: true }] : []),
    ...(needsPool(rules) ? [{ pubkey: new PublicKey(pool), isSigner: false, isWritable: false }] : []),
    { pubkey: hookProgram, isSigner: false, isWritable: false },
    { pubkey: extraAccountMetas, isSigner: false, isWritable: false },
  ];
}

/**
 * One transaction: create the pool, write the hook rules, and (optionally) the creator's first buy.
 * The first swap of a config with `enableFirstSwapWithMinFee` pays the minimum fee, not the 25%
 * anti-snipe fee. Needs the creator's and the mint's signatures; the mint is returned so the
 * caller can sign with it (the browser never sees it if the server signs).
 *
 * ⛔ MEASURED 4 Oct 2026: as a legacy transaction this is 1,182 bytes for a plain launch with a short
 * name and up to 1,429 with a list, anti-bundle and the largest metadata pump.fun allows; the limit
 * is 1,232. With `lut` (the table of fixed accounts, lib/lut.mjs) it comes back as a v0 transaction.
 */
/** `memo`: the creator's custom-pair choice as a public note in the launch itself (lib/pairs.mjs pairMemo). */
export async function buildLaunchTx({ dbc, hookProgram, config, creator, name, symbol, uri, rules, devBuyLamports = 0n, mint = Keypair.generate(), lut = null, priority = undefined, memo = null }) {
  creator = new PublicKey(creator);
  const createTx = await dbc.creator.createPoolWithTransferHook({
    name, symbol, uri, payer: creator, poolCreator: creator, config, baseMint: mint.publicKey, transferHookProgram: hookProgram,
  });
  const tx = createTx;
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config);
  tx.add(hookInitIx({ hookProgram, payer: creator, mint: mint.publicKey, rules: { ...rules, dev: creator }, pool }));
  if (BigInt(devBuyLamports) > 0n) {
    const cfgState = await dbc.state.getPoolConfig(config);
    const c = cfgState.config ?? cfgState;
    const accounts = hookTransferAccounts(hookProgram, mint.publicKey, rules, pool);
    const buy = await dbc.creator.buildSwap2WithTransferHookBuyTx(
      { buyer: creator, buyAmount: new BN(devBuyLamports.toString()), minimumAmountOut: new BN(0), referralTokenAccount: null,
        transferHookAccountsInfo: { slices: [{ accountsType: AccountsType.TransferHookBase, length: accounts.length }] }, transferHookAccounts: accounts },
      mint.publicKey, config, c.poolFees.baseFee, c.activationType, NATIVE_MINT, true,
    );
    tx.add(...buy.instructions);
  }
  if (memo) tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memo, "utf8") }));
  withPriority(tx, 350_000, priority); // measured: 183k CU with a dev buy
  tx.feePayer = creator;
  if (lut) return { tx: buildV0(creator, tx.instructions, PLACEHOLDER_BLOCKHASH, [lut]), mint, pool };
  return { tx, mint, pool };
}
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

/** Bytes a launch would take once both signatures are on it. */
export function launchSize(tx) {
  if (tx instanceof VersionedTransaction) return tx.message.serialize().length + 1 + 64 * 2;
  const had = tx.recentBlockhash; tx.recentBlockhash ??= PLACEHOLDER_BLOCKHASH;
  const n = tx.compileMessage().serialize().length + 1 + 64 * 2;
  tx.recentBlockhash = had; return n;
}

/**
 * The launch's fixed accounts (Meteora's program, pool authority and event authority, the hook, the
 * token programs, the system program, …) plus every offered config: everything two launches with
 * different mints, creators and co-signers have in common, excluding signers.
 */
export async function launchStaticKeys({ dbc, hookProgram, configs }) {
  const keysOf = async () => {
    const rules = { venueLock: true, holderRewards: true, maxWalletBps: 300, earlySecs: 300, earlyMaxWalletBps: 50, feeBaseBps: 0, feePerSolBps: 0, feeCapBps: 0, burnBps: 0, holderShareBps: 5_000,
      fomoOnly: true, cosigner: Keypair.generate().publicKey, appOnly: false, allowlist: true, bundleMax: 2 };
    // with a pair memo, so the memo program is in the table too
    const { tx } = await buildLaunchTx({ dbc, hookProgram, config: new PublicKey(configs[0]), creator: Keypair.generate().publicKey, name: "x", symbol: "x", uri: "x", rules, devBuyLamports: 10_000_000n, memo: pairMemo(Keypair.generate().publicKey.toBase58(), 300) });
    return new Set(tx.instructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.filter((k) => !k.isSigner).map((k) => k.pubkey.toBase58())]));
  };
  const [a, b] = [await keysOf(), await keysOf()];
  const out = new Set([...configs.map(String), ComputeBudgetProgram.programId.toBase58()]);
  for (const k of a) if (b.has(k)) out.add(k);
  return [...out].map((k) => new PublicKey(k));
}

/**
 * A buy or sell on a hooked curve. `amountIn` is lamports for a buy, base units for a sell.
 * Buys use partial fill so a buy bigger than what is left of the curve takes what is left instead
 * of failing (an exact-in buy past the graduation price is refused by Meteora, error 6033).
 */
export async function buildSwapTx({ dbc, pool, owner, buy, amountIn, minimumAmountOut = 0n, priority = undefined }) {
  const tx = await dbc.pool.swap2WithTransferHook({
    owner: new PublicKey(owner), pool: new PublicKey(pool), swapBaseForQuote: !buy, referralTokenAccount: null,
    swapMode: buy ? SwapMode.PartialFill : SwapMode.ExactIn, amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(minimumAmountOut.toString()),
  });
  withPriority(tx, 250_000, priority); // measured: ~100k CU per swap
  tx.feePayer = new PublicKey(owner);
  return tx;
}

function listKeys(hookProgram, dev, mint) {
  const { cfg, list } = hookPdas(hookProgram, mint);
  return [
    { pubkey: new PublicKey(dev), isSigner: true, isWritable: true },
    { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: cfg, isSigner: false, isWritable: false },
    { pubkey: list, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

/** Appends wallets to a token's list. They must be ascending and above the last one already on it. */
export function listAddIx({ hookProgram, dev, mint, wallets }) {
  if (!wallets.length || wallets.length > LIST_ADD_MAX) throw new Error(`1 to ${LIST_ADD_MAX} wallets per instruction`);
  return new TransactionInstruction({ programId: new PublicKey(hookProgram), keys: listKeys(hookProgram, dev, mint),
    data: Buffer.concat([LIST_ADD, ...wallets.map((w) => new PublicKey(w).toBuffer())]) });
}

/** Seals a token's list for good. */
export function listSealIx({ hookProgram, dev, mint }) {
  return new TransactionInstruction({ programId: new PublicKey(hookProgram), keys: listKeys(hookProgram, dev, mint), data: LIST_SEAL });
}

/**
 * The transactions that put `wallets` on a token's list (sorted, deduplicated, skipping any already
 * on it), and seal it in the last one when `seal`. The dev signs each.
 * @param already the wallets already on the list (sorted), so a retry continues where it stopped
 */
export function buildListTxs({ hookProgram, dev, mint, wallets, already = [], seal = false }) {
  const have = new Set(already.map((w) => new PublicKey(w).toBase58()));
  const last = already.length ? new PublicKey(already[already.length - 1]).toBuffer() : null;
  const todo = sortWallets(wallets).filter((w) => !have.has(w.toBase58()));
  // ⛔ the program only appends above the last listed wallet: a new wallet that sorts below it can
  // never be added, so it is reported rather than silently dropped
  const fits = todo.filter((w) => !last || Buffer.compare(w.toBuffer(), last) > 0);
  const tooLate = todo.filter((w) => !fits.includes(w));
  const txs = [];
  for (let i = 0; i < fits.length; i += LIST_ADD_MAX) {
    const tx = new Transaction().add(listAddIx({ hookProgram, dev, mint, wallets: fits.slice(i, i + LIST_ADD_MAX) }));
    txs.push(tx);
  }
  if (seal) {
    if (txs.length) txs[txs.length - 1].add(listSealIx({ hookProgram, dev, mint }));
    else txs.push(new Transaction().add(listSealIx({ hookProgram, dev, mint })));
  }
  for (const tx of txs) { withPriority(tx, 60_000 + 6_000 * 30); tx.feePayer = new PublicKey(dev); }
  return { txs, added: fits.length, tooLate };
}

export { TOKEN_2022_PROGRAM_ID };
