// The Robinhood Chain graduation service: every few seconds, each full curve is graduated into Pons V2
// (`graduate`: the Pons launch + buy, one transaction) and each graduated one is paid out to its holders
// (`payout`, 100 holders per transaction) until every holder has their coins.
//
// Both calls are permissionless and every input is fixed on chain, so this wallet only pays gas: it holds no
// one's money, and if it stops, anyone can finish a graduation with the same two calls.
//
//   EVM_LAUNCHPAD=0x… EVM_KEY_FILE=keys/evm-graduator.key node server/evm-graduator.mjs
//
// ⛔ Robinhood Chain: a transaction's gas is not what anvil says (Nitro adds L1 gas now and then), so every
// limit is the estimate plus a margin; its fee is the base fee whatever is offered, and the rest is refunded.
import { createWalletClient, http, formatEther, formatUnits, parseEther, keccak256, encodeAbiParameters, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { evmEnv, evmClient, rhc, LAUNCHPAD_ABI, STATES, revertText } from "../lib/evm.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const PAYOUT_BATCH = BigInt(process.env.EVM_PAYOUT_BATCH || 100);
// the burn side (lib/flywheel.mjs): this wallet is the Pons creator-fee recipient of every graduated coin; it claims the
// fees from Pons's escrow and bridges them to the Solana burn wallet through Relay, which buys and burns $HOOKER
const BURN_WALLET = process.env.BURN_WALLET || null;
const BURN_DRY = process.env.FLYWHEEL_DRY === "1";
const BURN_LEDGER = process.env.EVM_BURN_LEDGER || "data/evm-burn.json";
const BURN_MIN_CLAIM = parseEther(process.env.EVM_BURN_MIN_CLAIM_ETH || "0.002");
const BURN_MIN_BRIDGE = parseEther(process.env.EVM_BURN_MIN_BRIDGE_ETH || "0.01");
const GAS_RESERVE = parseEther(process.env.EVM_GAS_RESERVE_ETH || "0.004");
const PONS_ABI = parseAbi([
  "function feeEscrow() view returns (address)", "function memeHook() view returns (address)",
  "function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function balanceOf(address) view returns (uint256)", "function claim() returns (uint256)",
  "function balanceOfToken(address,address) view returns (uint256)", "function claimToken(address) returns (uint256)",
  "function quote() view returns (address)", "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  "function sweepFees(uint256)", "function sweepPoolFees(bytes32,uint256,uint256)",
]);
const SOLANA_CHAIN = 792703809, SOL = "11111111111111111111111111111111";
const HEARTBEAT = process.env.EVM_HEARTBEAT_FILE || null;

/** The key file: the private key on a line of its own; lines starting with # are notes. */
export function readEvmKey(file) {
  const line = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const k = line && (line.startsWith("0x") ? line : `0x${line}`);
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`no private key in ${file} (a 64-character hex line)`);
  return k;
}

export function createEvmGraduator({ env = evmEnv(), key, timeout = 60_000, client = evmClient(env.rpcUrl, env.chainId, { timeout }), wallet, log: say = log } = {}) {
  if (!env.launchpad) throw new Error("EVM_LAUNCHPAD is not set");
  const account = privateKeyToAccount(key);
  wallet ??= createWalletClient({ account, chain: rhc(env.chainId, env.rpcUrl), transport: http(env.rpcUrl, { fetchOptions: { headers: { "User-Agent": "Mozilla/5.0 Chrome/140.0.0.0", Accept: "application/json" } }, retryCount: 3, timeout }) });
  const pad = env.launchpad;
  const read = (fn, args = []) => client.readContract({ address: pad, abi: LAUNCHPAD_ABI, functionName: fn, args });
  const failing = new Map(); // token → { n, next } back-off after a refusal

  async function send(fn, args) {
    const { request } = await client.simulateContract({ account, address: pad, abi: LAUNCHPAD_ABI, functionName: fn, args });
    const gas = await client.estimateContractGas({ account, address: pad, abi: LAUNCHPAD_ABI, functionName: fn, args });
    const hash = await wallet.writeContract({ ...request, gas: (gas * 13n) / 10n + 50_000n });
    const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`${fn} reverted on chain: ${hash}`);
    return hash;
  }

  async function tick() {
    await tickPad();
    if (HEARTBEAT) {
      const out = { at: Math.floor(Date.now() / 1000), failing: [...failing].map(([token, f]) => ({ token, n: f.n, step: f.step, why: String(f.why).slice(0, 300) })) };
      writeFileSync(`${HEARTBEAT}.tmp`, JSON.stringify(out));
      renameSync(`${HEARTBEAT}.tmp`, HEARTBEAT);
    }
  }

  async function tickPad() {
    const n = Number(await read("tokenCount"));
    const tokens = await Promise.all(Array.from({ length: n }, (_, i) => read("tokens", [BigInt(i)])));
    const states = await Promise.all(tokens.map((t) => read("launches", [t]).then((l) => STATES[l[0]])));
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i], s = states[i];
      if (s !== "complete" && s !== "graduated") continue;
      const f = failing.get(t);
      if (f && Date.now() < f.next) continue;
      try {
        if (s === "complete") {
          const hash = await send("graduate", [t]);
          const l = await read("launches", [t]);
          say(`graduated ${t} → Pons ${l[10]} (${hash})`);
        }
        // pay out right away, a batch per transaction, until every holder is paid
        for (let k = 0; k < 1_000; k++) {
          const l = await read("launches", [t]);
          if (STATES[l[0]] !== "graduated") break;
          const hash = await send("payout", [t, PAYOUT_BATCH]);
          say(`paid ${t} up to holder ${(await read("launches", [t]))[14]} (${hash})`);
        }
        failing.delete(t);
      } catch (e) {
        const n = (f?.n ?? 0) + 1;
        const why = revertText(e);
        failing.set(t, { n, why, step: s === "complete" ? "graduate" : "payout", next: Date.now() + Math.min(300_000, 5_000 * 2 ** n) });
        say(`⚠ ${s === "complete" ? "graduate" : "payout"} ${t} failed (try ${n}): ${why}`);
      }
    }
  }
  // ── the burn side ──
  const ledger = () => { try { return JSON.parse(readFileSync(BURN_LEDGER, "utf8")); } catch { return { rows: [] }; } };
  const recordBurn = (row) => { const l = ledger(); l.rows.unshift({ at: Math.floor(Date.now() / 1000), dry: BURN_DRY, ...row }); l.rows = l.rows.slice(0, 500); writeFileSync(`${BURN_LEDGER}.tmp`, JSON.stringify(l)); renameSync(`${BURN_LEDGER}.tmp`, BURN_LEDGER); };
  const poolId = (coin, lt, hook) => {
    const [c0, c1] = [lt.pairToken, coin].map((a) => a.toLowerCase()).sort();
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [c0, c1, lt.poolFee, lt.tickSpacing, hook]));
  };
  const tryWrite = async (address, abi, functionName, args) => {
    const { request } = await client.simulateContract({ account, address, abi, functionName, args });
    if (BURN_DRY) return "dry";
    const hash = await wallet.writeContract(request);
    await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return hash;
  };

  /** Every 10 minutes: sweep our graduated coins' fees into Pons's escrow, claim, bridge to the burn wallet. */
  /** Every 10 minutes: sweep our graduated coins' fees into Pons's escrow, claim them per asset, bridge to the burn wallet. */
  async function burnTick() {
    if (!BURN_WALLET) return;
    const ponsAddr = await read("pons");
    const quotes = new Set(["0x0000000000000000000000000000000000000000"]);
    const [escrow, hook] = await Promise.all([client.readContract({ address: ponsAddr, abi: PONS_ABI, functionName: "feeEscrow" }), client.readContract({ address: ponsAddr, abi: PONS_ABI, functionName: "memeHook" })]);
    // 1. sweeps: the fee recipient may move a coin's fees from its curve (phase 0) or its pool (phase 2) into the escrow;
    //    Pons's own operator does this too, so a refusal here is routine, not a fault
    const n = Number(await read("tokenCount"));
    for (let i = 0; i < n; i++) {
      const t = await read("tokens", [BigInt(i)]);
      const l = await read("launches", [t]);
      const coin = l[10];
      if (STATES[l[0]] !== "paid" && STATES[l[0]] !== "graduated") continue;
      const lt = await client.readContract({ address: ponsAddr, abi: PONS_ABI, functionName: "getLaunchedToken", args: [coin] });
      if (lt.creatorFeeRecipient.toLowerCase() !== account.address.toLowerCase()) continue; // "creator fees to holders": not ours
      quotes.add(lt.pairToken.toLowerCase());
      try {
        if (lt.phase === 0) await tryWrite(lt.curve, PONS_ABI, "sweepFees", [0n]);
        else if (lt.phase === 2) await tryWrite(hook, PONS_ABI, "sweepPoolFees", [poolId(coin, lt, hook), 0n, 0n]);
      } catch {}
    }
    // 2. claim, per asset our coins are paired with: the escrow pays whoever calls, so this wallet must be the recipient.
    //    A pair asset's fees sit in the escrow's token ledger and are claimed as that asset, then bridged as that asset
    //    (ETH and USDG; an asset Relay cannot move stays here until it is converted by hand).
    for (const quote of quotes) await claimQuote(escrow, quote);
    await bridgeEth();
  }

  async function claimQuote(escrow, quote) {
    const isEth = quote === "0x0000000000000000000000000000000000000000";
    const owed = isEth
      ? await client.readContract({ address: escrow, abi: PONS_ABI, functionName: "balanceOf", args: [account.address] })
      : await client.readContract({ address: escrow, abi: PONS_ABI, functionName: "balanceOfToken", args: [account.address, quote] });
    const dec = isEth ? 18 : await client.readContract({ address: quote, abi: PONS_ABI, functionName: "decimals" });
    const sym = isEth ? "ETH" : await client.readContract({ address: quote, abi: PONS_ABI, functionName: "symbol" });
    const minClaim = isEth ? BURN_MIN_CLAIM : 10n ** BigInt(dec); // a whole unit of the asset
    if (owed >= minClaim) {
      try {
        const hash = isEth ? await tryWrite(escrow, PONS_ABI, "claim", []) : await tryWrite(escrow, PONS_ABI, "claimToken", [quote]);
        recordBurn({ kind: "claim", eth: formatUnits(owed, dec), unit: sym, hash });
        say(`burn: claimed ${formatUnits(owed, dec)} ${sym} of Pons creator fees${BURN_DRY ? " (dry)" : ""} ${hash}`);
      } catch (e) { say(`⚠ burn: claim failed: ${revertText(e)}`); }
    }
    if (!isEth && sym === "USDG") await bridgeToken(quote, sym, dec);
  }

  /** Relay: the asset on Robinhood Chain → SOL in the burn wallet, in seconds. ETH keeps a gas reserve. */
  async function bridge(currency, amount, sym, dec) {
    const q = await fetch("https://api.relay.link/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      user: account.address, recipient: BURN_WALLET, originChainId: env.chainId, destinationChainId: SOLANA_CHAIN, originCurrency: currency, destinationCurrency: SOL, amount: amount.toString(), tradeType: "EXACT_INPUT",
    }), signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
    const out = q.details?.currencyOut?.amountFormatted, impact = Number(q.details?.totalImpact?.percent ?? 0);
    const txSteps = (q.steps ?? []).filter((st) => st.kind === "transaction");
    if (!txSteps.length || !txSteps.every((st) => st.items?.every((i) => i.data?.to))) { say(`⚠ burn: no Relay route for ${sym} (${q.message ?? JSON.stringify(q).slice(0, 120)})`); return; }
    if (impact < -3) { say(`⚠ burn: Relay quote for ${sym} loses ${-impact}%: waiting`); return; }
    if (BURN_DRY) { recordBurn({ kind: "bridge", eth: formatUnits(amount, dec), unit: sym, sol: out, requestId: txSteps[0].requestId ?? null, hash: "dry" }); say(`burn: would bridge ${formatUnits(amount, dec)} ${sym} → ${out} SOL to ${BURN_WALLET} (dry)`); return; }
    let hash;
    for (const st of txSteps) for (const item of st.items) { // an ERC-20 route may be approve + deposit
      hash = await wallet.sendTransaction({ to: item.data.to, data: item.data.data, value: BigInt(item.data.value ?? 0), gas: item.data.gas ? BigInt(item.data.gas) : undefined });
      await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    }
    recordBurn({ kind: "bridge", eth: formatUnits(amount, dec), unit: sym, sol: out, requestId: txSteps[0].requestId ?? null, hash });
    say(`burn: bridged ${formatUnits(amount, dec)} ${sym} → ${out} SOL to the burn wallet ${hash}`);
  }
  async function bridgeEth() {
    const bal = await client.getBalance({ address: account.address });
    const send = bal > GAS_RESERVE ? bal - GAS_RESERVE : 0n;
    if (send >= BURN_MIN_BRIDGE) await bridge("0x0000000000000000000000000000000000000000", send, "ETH", 18);
  }
  async function bridgeToken(token, sym, dec) {
    const bal = await client.readContract({ address: token, abi: PONS_ABI, functionName: "balanceOf", args: [account.address] });
    if (bal >= 10n ** BigInt(dec)) await bridge(token, bal, sym, dec);
  }

  return { tick, burnTick, account };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.env.EVM_KEY_FILE || new URL("../keys/evm-graduator.key", import.meta.url).pathname;
  const key = readEvmKey(file);
  const g = createEvmGraduator({ key });
  log(`evm graduator up: ${g.account.address} on ${evmEnv().launchpad}${BURN_WALLET ? ` · burn side: Pons fees → ${BURN_WALLET}${BURN_DRY ? " (DRY)" : ""}` : ""}`);
  let lastBurn = 0;
  for (;;) {
    await g.tick().catch((e) => log("tick:", e.shortMessage ?? e.message));
    if (BURN_WALLET && Date.now() - lastBurn > 600_000) { lastBurn = Date.now(); await g.burnTick().catch((e) => log("burn tick:", e.shortMessage ?? e.message)); }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
