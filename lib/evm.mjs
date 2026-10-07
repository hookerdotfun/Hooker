// The Robinhood Chain side of Hooker: launches on our own curve (evm/src/HookerLaunchpad.sol) that graduate
// into Pons V2. This module reads them, indexes their trades and builds their transactions; server/api.mjs
// mounts `evmRoutes` under /api/evm and lists these launches next to the Solana ones.
//
// ⭐ Like the Solana side, the browser holds no RPC and no chain library: the API returns {to, data, value,
// chainId} and the wallet only signs and sends it.
//
// ⛔ Robinhood Chain traps (memory): its Cloudflare refuses a request without a browser User-Agent; its
// eth_getLogs IGNORES the topics filter (only `address` is honoured), so every log is checked against the
// event's topic0 here; a getLogs range is at most 2,000 blocks; `block.number` inside the EVM is the slow L1
// clock while eth_blockNumber is the fast L2 one, so log ranges use eth_blockNumber and nothing else.
import { createPublicClient, http, encodeFunctionData, decodeEventLog, decodeErrorResult, getAddress, isAddress, toEventSelector, toFunctionSelector, defineChain, formatEther, parseEther, formatUnits, parseUnits } from "viem";
import { readFileSync } from "node:fs";
import { PONS_ASSETS, USDG } from "./pons-assets.mjs";

const ABI = JSON.parse(readFileSync(new URL("./evm-abi.json", import.meta.url)));
export const LAUNCHPAD_ABI = ABI.launchpad;
export const TOKEN_ABI = ABI.token;
export const LAUNCHPAD_BYTECODE = ABI.launchpadBytecode;
/** The token implementation every v6+ launchpad clones (deploy it first, pass its address to the launchpad). */
export const TOKEN_BYTECODE = ABI.tokenBytecode;
/** The v5 launchpad's ABI (no v3 rules): the same as v6 except `launch` takes no `ext`. Used while a v5 launchpad is live. */
export const LAUNCHPAD_ABI_V5 = LAUNCHPAD_ABI.map((f) => (f.type === "function" && f.name === "launch"
  ? { ...f, inputs: f.inputs.map((i) => ({ ...i, components: i.components.filter((c) => c.name !== "ext") })) }
  : f));
export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const PONS_DISTRIBUTORS = "0x70e95CC5f03DB2906081E7a8D16e4C4209291507";
export const STATES = ["none", "trading", "complete", "graduated", "paid", "refunding"];
export const HOOK_ERRORS_EVM = {
  1: "That would put the wallet over this token's max per wallet.",
  4: "This token can only be held by wallets, not contracts.",
  6: "This wallet is not on the token's allowlist.",
  7: "This wallet is on the token's blocklist.",
  8: "That trade is bigger than this token allows in one go.",
  9: "This token can only be bought during its trading hours.",
  11: "Too many buys landed in this block. Try again in a moment.",
  12: "The token's list is closed.",
  14: "Only the token's creator can change its list.",
  15: "This token has graduated: it now trades on Pons.",
  // v3 (the Solana hook's numbers, except the buy cap: 25 here)
  16: "That sell is bigger than this token allows in one go. Sell in smaller pieces.",
  17: "This token spreads like a plague: a wallet can only buy once a holder has sent it some.",
  18: "This token only moves in trades with its curve: wallet-to-wallet sends are off.",
  19: "This token only moves wallet to wallet: only its creator buys from the curve and nobody sells to it.",
  20: "Sells are closed outside this token's trading hours.",
  21: "You hold the hot potato: you can sell or send once another wallet buys after you.",
  22: "Ping pong: it is the other side's turn. Try again after the next trade.",
  23: "The buy cap is moving: that buy is over it right now. Try a smaller buy or wait a moment.",
  24: "That would put the wallet over this chapter's max per wallet. It doubles as more volume trades.",
  25: "That buy is bigger than this token allows in one go.",
};
/** Every v3 rule, off (the token's `Ext`; the same names as lib/rules.mjs V3_OFF, EVM units). */
export const EXT_OFF = Object.freeze({
  maxBuyBps: 0, maxSellBps: 0, sellSmallBps: 0, sellFloorBps: 0, sellBagBps: 0, plagueDose: 0n, dexOnly: false, p2pOnly: false,
  potatoOn: false, potatoMinBps: 0, potatoColdSecs: 0, pingOn: false, pingMinBps: 0, pingFreeSecs: 0, chapterStartBps: 0, chapterVolume: 0n,
  oscKind: 0, oscPeriod: 0, oscBaseBps: 0, oscFloorBps: 0, oscAmpPct: 0, oscDampPermille: 0, oscCouplingPct: 0,
  kingOn: false, kingMin: 0n, kingBeatPct: 0, kingDecayUnit: 0, kingDecayN: 0, kingDevCan: false, hoursSells: false, hoursHolidays: false, hoursDst: 0,
});
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", Accept: "application/json" };
const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
const ERC20_ERRORS = [
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "ERC20InsufficientBalance", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ type: "address" }] }, // what the launchpad raises when the asset refuses a pull
  { type: "error", name: "InsufficientAllowance", inputs: [] }, // USDG's own
];
const SELECTORS = new Map([...ERC20_ERRORS].map((e) => [toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`).toLowerCase(), e.name]));
const PONS_FEE_ABI = [
  { type: "function", name: "launchFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approvedPairTokens", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "pairTokenEconomics", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint8" }] },
];
// USD prices of the pair assets, read from Uniswap V4 on Robinhood Chain (the asset's USDG pool, deepest fee tier), the
// way ponscharity.family does it: no API, no key. An initialised pool is not a liquid one: a tier with zero liquidity is skipped.
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const EXTSLOAD_ABI = [{ type: "function", name: "extsload", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] }];
const V4_TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
const Q96 = 2n ** 96n;
/** Pair assets priced at one dollar; every other pair asset needs a feed before it is offered. */
const STABLE = new Set(["USDG", "USDC", "USDT"]);
/** Pons's full launched-token record and its meme hook (the graduated pool's hook). */
const PONS_LT_ABI = [
  { type: "function", name: "getLaunchedToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [
    { name: "token", type: "address" }, { name: "curve", type: "address" }, { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" },
    { name: "pairToken", type: "address" }, { name: "graduationThreshold", type: "uint256" }, { name: "poolFee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
    { name: "creatorTaxBps", type: "uint16" }, { name: "buybackEnabled", type: "bool" }, { name: "phase", type: "uint8" }, { name: "sweptQuote", type: "uint256" },
    { name: "sweptTokens", type: "uint256" }, { name: "sweptAt", type: "uint256" }, { name: "exists", type: "bool" }] }] },
  { type: "function", name: "memeHook", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
/** The meme hook's record of a pool (all members static): registered, and which coin it is for. */
const HOOK_LAUNCHES_ABI = [{ type: "function", name: "launches", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "registered", type: "bool" }, { name: "memecoinIsCurrency0", type: "bool" }, { name: "memecoin", type: "address" }, { name: "quoteToken", type: "address" },
  { name: "creator", type: "address" }, { name: "buybackCreatorRecipient", type: "address" }, { name: "protocolFeeRecipient", type: "address" }, { name: "creatorTaxBps", type: "uint16" }] }] }];
const PONS_CURVE_ABI = [{ type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] }];
const PONS_FACTORY_ABI = [{ type: "function", name: "getLaunchedToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [
  { name: "token", type: "address" }, { name: "curve", type: "address" }, { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" },
  { name: "pairToken", type: "address" }, { name: "graduationThreshold", type: "uint256" }, { name: "poolFee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
  { name: "creatorTaxBps", type: "uint16" }, { name: "buybackEnabled", type: "bool" }, { name: "phase", type: "uint8" }, { name: "sweptQuote", type: "uint256" },
  { name: "sweptTokens", type: "uint256" }, { name: "sweptAt", type: "uint256" }, { name: "exists", type: "bool" }] }] }];

export const rhc = (chainId = 4663, rpcUrl) => defineChain({
  id: chainId, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const evmEnv = () => ({
  rpcUrl: process.env.EVM_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  /** reads (eth_call) can go to a faster endpoint than logs: publicnode answers calls in ~65 ms but only ~93 blocks of logs */
  callRpcUrl: process.env.EVM_CALL_RPC_URL || process.env.EVM_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  chainId: Number(process.env.EVM_CHAIN_ID || 4663),
  launchpad: process.env.EVM_LAUNCHPAD ? getAddress(process.env.EVM_LAUNCHPAD) : null,
  deployBlock: BigInt(process.env.EVM_DEPLOY_BLOCK || 0),

  explorer: process.env.EVM_EXPLORER || "https://robinhoodchain.blockscout.com",
  /** Hooker's own token on Pons (the Pons side's CA, separate from $HOOKER on Solana); unset until it launches */
  platformToken: /^0x[0-9a-fA-F]{40}$/.test(process.env.PONS_PLATFORM_TOKEN ?? "") ? getAddress(process.env.PONS_PLATFORM_TOKEN) : null,
});

export function evmClient(url, chainId, { timeout = 30_000 } = {}) {
  return createPublicClient({ chain: rhc(chainId, url), transport: http(url, { fetchOptions: { headers: UA }, retryCount: 3, timeout, batch: { wait: 10 } }), batch: { multicall: { wait: 10 } }, cacheTime: 0 });
}

const ZERO = "0x0000000000000000000000000000000000000000";
const isZero = (a) => !a || a.toLowerCase() === ZERO;

export function addr(v) {
  if (!isAddress(String(v ?? ""), { strict: false })) { const e = new Error(`not an address: ${String(v).slice(0, 60)}`); e.status = 400; throw e; }
  return getAddress(String(v));
}

/** `Pool.State[] _pools` is slot 6 on the V4 singleton; a pool's state starts at keccak(poolId, 6), liquidity 3 slots on. */
async function v4UsdPerUnit(client, asset, decimals) {
  const { keccak256, encodeAbiParameters, pad: padHex, toHex } = await import("viem");
  const [c0, c1] = asset.toLowerCase() < USDG.toLowerCase() ? [asset, USDG] : [USDG, asset];
  let best = null;
  for (const [fee, ts] of V4_TIERS) {
    const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [c0, c1, fee, ts, ZERO]));
    const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
    const slot = (n) => padHex(toHex(base + n), { size: 32 });
    try {
      const [s0, liq] = await Promise.all([client.readContract({ address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: "extsload", args: [slot(0n)] }), client.readContract({ address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: "extsload", args: [slot(3n)] })]);
      const sqrt = BigInt(s0) & ((1n << 160n) - 1n), liquidity = BigInt(liq) & ((1n << 128n) - 1n);
      if (sqrt > 0n && liquidity > 0n && (!best || liquidity > best.liquidity)) best = { sqrt, liquidity };
    } catch {}
  }
  if (!best) return null;
  const sq = best.sqrt * best.sqrt, one = 10n ** BigInt(decimals);
  const scaled = asset.toLowerCase() < USDG.toLowerCase() ? (sq * one) / (Q96 * Q96) : (Q96 * Q96 * one) / sq; // USDG base units per whole asset
  return scaled > 0n ? Number(scaled) / 1e6 : null;
}

const LAUNCHED_TOPIC = toEventSelector(LAUNCHPAD_ABI.find((x) => x.type === "event" && x.name === "Launched"));
const TRADE_TOPIC = toEventSelector(LAUNCHPAD_ABI.find((x) => x.type === "event" && x.name === "Trade"));

/**
 * Trades from the launchpad's Trade events, newest last, kept in memory and topped up every few seconds.
 * Each getLogs call spans at most 2,000 blocks and is checked against topic0 (Robinhood Chain ignores topics).
 */
export function tradeIndexer({ client, launchpad, fromBlock, log = () => {}, max = 20_000 }) {
  const trades = [];
  let next = fromBlock, busy = null;
  async function step() {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    while (next <= head) {
      const to = next + 1_999n > head ? head : next + 1_999n;
      const logs = await client.getLogs({ address: launchpad, fromBlock: next, toBlock: to });
      for (const l of logs) {
        if (l.topics[0] !== TRADE_TOPIC) continue;
        const { args } = decodeEventLog({ abi: LAUNCHPAD_ABI, data: l.data, topics: l.topics });
        trades.push({ token: args.token, trader: args.trader, isBuy: args.isBuy, eth: args.eth, tokens: args.tokens, fee: args.fee, vEth: args.vEth, vTokens: args.vTokens, block: l.blockNumber, tx: l.transactionHash, at: null });
      }
      next = to + 1n;
    }
    if (trades.length > max) trades.splice(0, trades.length - max);
  }
  return {
    trades,
    refresh: () => (busy ??= step().catch((e) => log("evm trades:", e.shortMessage ?? e.message)).finally(() => { busy = null; })),
  };
}

/**
 * The /api/evm routes. `cached(key, ms, fn)` is the API's shared cache (in-flight sharing, stale-on-error).
 */
export function createEvm({ cached, ethUsd, knowCid = () => {}, featuredEvm = () => [], env = evmEnv(), client = evmClient(env.callRpcUrl, env.chainId), logClient = evmClient(env.rpcUrl, env.chainId), log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  if (!env.launchpad) return null;
  const pad = env.launchpad;
  const call = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const P = (fn, args) => call(pad, LAUNCHPAD_ABI, fn, args);
  const T = (token, fn, args) => call(token, TOKEN_ABI, fn, args);
  const F = (fn, args) => call(PONS_FACTORY, PONS_FEE_ABI, fn, args);
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
  const indexer = tradeIndexer({ client: logClient, launchpad: pad, fromBlock: env.deployBlock, log });
  const timer = setInterval(() => indexer.refresh(), 3_000);
  timer.unref?.();
  indexer.refresh();

  // ── the pair assets a launch may be priced in: ETH, then Pons's approved assets (the seed list checked on chain hourly) ──
  const ETH = { address: null, symbol: "ETH", decimals: 18 };
  const assets = () => cached("evm:assets", 3_600_000, async () => {
    const rest = PONS_ASSETS.filter((x) => x.address);
    const ok = await Promise.all(rest.map((x) => F("approvedPairTokens", [x.address]).catch(() => false)));
    const kept = rest.filter((_, i) => ok[i]);
    const eco = await Promise.all(kept.map((x) => F("pairTokenEconomics", [x.address]).catch(() => null)));
    return [ETH, ...kept.map((x, i) => ({ ...x, address: getAddress(x.address), phantom: eco[i]?.[0] ?? null, graduation: eco[i]?.[1] ?? null })).filter((x) => x.phantom && x.graduation)];
  });
  /** An asset by address (a launch's quote), even one not on the seed list (read from the token itself). */
  async function assetOf(quote) {
    if (isZero(quote)) return ETH;
    const known = (await assets()).find((x) => x.address && x.address.toLowerCase() === quote.toLowerCase());
    if (known) return known;
    return cached(`evm:asset:${quote}`, 3_600_000, async () => ({ address: getAddress(quote), symbol: await call(quote, ERC20_ABI, "symbol"), decimals: await call(quote, ERC20_ABI, "decimals") }));
  }
  const assetBy = async (v) => { const list = await assets(); const x = list.find((y) => y.symbol.toLowerCase() === String(v ?? "ETH").toLowerCase() || (y.address && y.address.toLowerCase() === String(v).toLowerCase())); if (!x) throw bad("not a Pons pair asset"); return x; };
  /** USD per whole unit of an asset: ETH from the price feed, USDG one dollar, the rest from their V4 pool against USDG. */
  const usdOf = (x) => (!x.address ? ethUsd().catch(() => null) : x.address.toLowerCase() === USDG.toLowerCase() ? 1 : cached(`evm:usd:${x.address}`, 60_000, () => v4UsdPerUnit(client, x.address, x.decimals)).catch(() => null));
  const fmt = (x, v) => Number(formatUnits(v, x.decimals));
  const parseAmt = (x, v, what) => { try { const n = parseUnits(String(v), x.decimals); if (n < 0n) throw 0; return n; } catch { throw bad(`bad ${what}`); } };
  const quoteOfToken = new Map(); // token → quote address (null = ETH), filled as launches are read

  /** The launchpad's numbers for one asset: its sizes and fee steps (ETH from the launchpad, a pair asset from Pons). */
  const settings = (x = ETH) => cached(`evm:settings:${x.address ?? "ETH"}`, 60_000, async () => {
    const [virtualEth, supply, ponsGradEth, feeUnit, ...rest] = await Promise.all([P("virtualEth"), P("supply"), P("ponsGraduationEth"), P("feeUnit"),
      ...[0, 1, 2, 3].map((i) => P("sizeBps", [BigInt(i)])), ...[0, 1, 2, 3].map((i) => P("feeBps", [BigInt(i)])), ...[0, 1, 2, 3].map((i) => P("creatorBps", [BigInt(i)]))]);
    const sizeBps = rest.slice(0, 4).map(Number), feeBps = rest.slice(4, 8).map(Number), creatorBps = rest.slice(8, 12).map(Number);
    const phantom = x.address ? x.phantom : virtualEth, grad = x.address ? x.graduation : ponsGradEth;
    const v = fmt(x, phantom), g = fmt(x, grad);
    const capAt = (q) => (v + q) ** 2 / v;
    return {
      chainId: env.chainId, launchpad: pad, quote: { symbol: x.symbol, decimals: x.decimals, address: x.address }, virtualEth: String(v), supply: supply.toString(), ponsGraduationEth: g,
      feeUnit: (x.address ? (grad * 10n) / 42n : feeUnit).toString(),
      sizes: sizeBps.map((b, i) => { const q = (g * b) / 10_000; return { index: i, eth: q, ponsOwn: b === 10_000, startCapEth: capAt(0), endCapEth: capAt(q) }; }),
      feeTiers: feeBps.map((f, i) => ({ index: i, totalPct: f / 100, creatorPct: creatorBps[i] / 100, platformPct: (f - creatorBps[i]) / 100 })),
      antiSnipeStartPct: 50,
    };
  });

  /**
   * Tokens hidden from the site (tests, mistakes): data/hidden-tokens.json, a JSON list of addresses, read live (no
   * restart). A hidden token is left out of every list and feed and its page is a 404; the chain is untouched, and the
   * graduation service (which reads the launchpad, not this) still graduates it and pays its holders.
   */
  const hiddenFile = `${process.env.DATA_DIR || new URL("../data/", import.meta.url).pathname}/hidden-tokens.json`;
  const hiddenSet = () => cached("evm:hidden", 5_000, async () => {
    try { return new Set(JSON.parse(readFileSync(hiddenFile, "utf8")).map((a) => String(a).toLowerCase())); } catch { return new Set(); }
  });
  const isHidden = async (t) => (await hiddenSet()).has(String(t).toLowerCase());
  const notHidden = async (t) => { if (await isHidden(t)) throw Object.assign(new Error("not a Hooker token"), { status: 404 }); };

  /**
   * A Pons coin's market cap in its pair asset, by phase (memory: pons-market-cap-across-graduation): 0 on Pons's curve
   * (reserves), 1 swept but the pool not seeded (nothing can price it: null, never a zero), 2 in its V4 pool (sqrtPrice
   * from PoolManager storage). The pool id carries Pons's hook and is checked against hook.launches(id).
   */
  const ponsCoinCap = (coin) => cached(`evm:poncap:${coin}`, 15_000, async () => {
    const lt = await call(PONS_FACTORY, PONS_LT_ABI, "getLaunchedToken", [coin]);
    if (!lt.exists) return null;
    const x = await assetOf(lt.pairToken);
    const supply = await call(coin, ERC20_ABI, "totalSupply");
    const out = { phase: Number(lt.phase), quote: x, cap: null, deployer: lt.deployer };
    if (out.phase === 0) {
      const [q, t] = await call(lt.curve, PONS_CURVE_ABI, "getReserves");
      if (t > 0n) out.cap = fmt(x, (q * supply) / t);
    } else if (out.phase === 2) {
      const hook = await call(PONS_FACTORY, PONS_LT_ABI, "memeHook");
      const [c0, c1] = [lt.pairToken, coin].map((a) => a.toLowerCase()).sort();
      const { keccak256, encodeAbiParameters, pad: padHex, toHex } = await import("viem");
      const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [c0, c1, lt.poolFee, lt.tickSpacing, hook]));
      const reg = await call(hook, HOOK_LAUNCHES_ABI, "launches", [id]).catch(() => null);
      if (reg?.registered && reg.memecoin.toLowerCase() === coin.toLowerCase()) {
        const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
        const slot = (n) => padHex(toHex(base + n), { size: 32 });
        const [s0, liq] = await Promise.all([call(POOL_MANAGER, EXTSLOAD_ABI, "extsload", [slot(0n)]), call(POOL_MANAGER, EXTSLOAD_ABI, "extsload", [slot(3n)])]);
        const sqrt = BigInt(s0) & ((1n << 160n) - 1n), l = BigInt(liq) & ((1n << 128n) - 1n);
        if (sqrt > 0n && l > 0n) {
          const sq = sqrt * sqrt, qq = Q96 * Q96;
          out.cap = fmt(x, coin.toLowerCase() === c0 ? (supply * sq) / qq : (supply * qq) / sq);
        }
      }
    }
    return out;
  });
  const featuredOf = (t) => featuredEvm().find((f) => f.token.toLowerCase() === String(t).toLowerCase()) ?? null;
  /** A featured Pons coin (featured.json evmCoins) in the shape of a Hooker launch that graduated into Pons, `native: true`. */
  async function summarizeFeatured(f) {
    const p = await ponsCoinCap(f.token).catch(() => null);
    const x = p?.quote ?? ETH;
    const usd = await usdOf(x);
    const marketCap = p?.cap ?? null;
    return {
      chain: "rhc", mint: getAddress(f.token), creator: getAddress(f.creator), name: f.name, symbol: f.symbol, image: f.image, createdAt: f.createdAt,
      status: "paid", native: true, review: f.review, venue: "pons", quote: { symbol: x.symbol, decimals: x.decimals, address: x.address },
      meta: { name: f.name, symbol: f.symbol, image: f.image, description: f.description, twitter: f.twitter, telegram: f.telegram, website: f.website },
      description: f.description, socials: { twitter: f.twitter ?? "", telegram: f.telegram ?? "", website: f.website ?? "" },
      antiSnipe: false, feeTier: 0, fees: null, progress: 1, raised: null, target: null, pot: null, raisedEth: null, targetEth: null, potEth: null,
      marketCap, marketCapEth: !x.address ? marketCap : null, marketCapUsd: marketCap != null && usd ? marketCap * usd : null, ethUsd: !x.address ? usd : null, quoteUsd: usd,
      rules: {}, live: null,
      graduated: { status: "paid", ponsToken: getAddress(f.token), ponsUrl: `https://www.ponsfamily.com/launchpad/${getAddress(f.token)}`, phase: p?.phase ?? null, paid: true },
      explorer: `${env.explorer}/token/${getAddress(f.token)}`,
    };
  }

  /** Whether the launchpad takes v3 rules (v6+: it has KING_BPS); a v5 launchpad does not. */
  const padV3 = () => cached("evm:v3", 3_600_000, () => P("KING_BPS").then(() => true, () => false));
  /** A token's v3 rules (none on a v5 launchpad's tokens), in the units the site shows: tokens, and the asset for the King. */
  const extOf = (token, x) => cached(`evm:ext:${token}`, 3_600_000, async () => {
    if (!(await padV3())) return null;
    const e = await T(token, "ext").catch(() => null);
    if (!e) return null;
    return { ...Object.fromEntries(Object.entries(e).filter(([k]) => isNaN(k)).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])),
      plagueDose: Number(formatEther(e.plagueDose)), chapterVolume: Number(formatEther(e.chapterVolume)), kingMin: fmt(x, e.kingMin) };
  });
  /** What the v3 rules that remember something show right now (the Solana token page's "Right now"). */
  async function liveOf(token, e, x) {
    if (!e) return null;
    const stateful = e.potatoOn || e.pingOn || e.chapterStartBps || e.oscKind || e.kingOn;
    if (!stateful) return null;
    return cached(`evm:live:${token}`, 3_000, async () => {
      const [block, potato, potatoSince, pingNext, pingLastTs, volume, osc, king, kingBid, kingSince, reign, kingBar] = await Promise.all([
        client.getBlock(), e.potatoOn ? T(token, "potatoHolder") : null, e.potatoOn ? T(token, "potatoSince") : null,
        e.pingOn ? T(token, "pingNext") : null, e.pingOn ? T(token, "pingLastTs") : null, e.chapterStartBps ? T(token, "volume") : null,
        e.oscKind ? T(token, "oscCapNow") : null, e.kingOn ? T(token, "king") : null, e.kingOn ? T(token, "kingBid") : null,
        e.kingOn ? T(token, "kingSince") : null, e.kingOn ? T(token, "reign") : null, e.kingOn ? T(token, "kingBar") : null,
      ]);
      const out = { chainTime: Number(block.timestamp) };
      const zero = (a) => !a || /^0x0{40}$/i.test(a);
      if (e.potatoOn) out.potato = { holder: zero(potato) ? null : potato, coldAt: e.potatoColdSecs && !zero(potato) ? Number(potatoSince) + e.potatoColdSecs : null };
      if (e.pingOn) out.ping = { next: ["any", "buy", "sell"][Number(pingNext)] ?? "any", freeAt: e.pingFreeSecs && Number(pingLastTs) ? Number(pingLastTs) + e.pingFreeSecs : null };
      if (e.chapterStartBps) {
        const v = Number(formatEther(volume));
        const chapter = Math.min(20, Math.floor(v / (e.chapterVolume || 1)));
        out.chapters = { chapter: chapter + 1, capBps: Math.min(10_000, e.chapterStartBps * 2 ** chapter), volume: v, nextAt: (chapter + 1) * e.chapterVolume };
      }
      if (e.oscKind) out.oscCapBps = Number(osc);
      if (e.kingOn) {
        const n = Number(reign);
        const reigns = await Promise.all(Array.from({ length: Math.min(n, 8) }, (_, i) => T(token, "reigns", [BigInt(n - i)])));
        const kingBps = 30;
        out.king = {
          king: zero(king) ? null : king, bid: fmt(x, kingBid), since: Number(kingSince), bar: fmt(x, kingBar), cutBps: kingBps, unit: x.symbol,
          hall: reigns.map((r, i) => ({ reign: n - i, king: r[0], since: Number(r[1]), ended: r[2], value: fmt(x, r[3]), earned: fmt(x, (r[3] * BigInt(kingBps)) / 10_000n) })),
        };
      }
      return out;
    });
  }

  /** One launch, as the site shows it (the same fields as a Solana launch where they mean the same thing). */
  async function summarize(token) {
    const l = await P("launches", [token]);
    if (Number(l[0]) === 0) throw Object.assign(new Error("not a Hooker token"), { status: 404 });
    const [stateN, creator, createdAt, tier, antiSnipe, vQ, vTokens, realQ, gradQ, pot, ponsToken] = l;
    const x = await assetOf(l[18]);
    quoteOfToken.set(token, x);
    const [name, symbol, image, rules, meta] = await Promise.all([
      T(token, "name"), T(token, "symbol"), cached(`evm:img:${token}`, 3_600_000, () => T(token, "image")),
      cached(`evm:rules:${token}`, 3_600_000, () => T(token, "rules")), cached(`evm:meta:${token}`, 3_600_000, () => P("meta", [token])),
    ]);
    const state = STATES[stateN] ?? "none";
    const onPons = state === "graduated" || state === "paid";
    const ext = await extOf(token, x).catch(() => null);
    const s = await settings(x);
    const usd = await usdOf(x);
    const supply = Number(BigInt(s.supply) / 10n ** 18n);
    const capOf = (q, t) => (Number(q) / 10 ** x.decimals) / (Number(t) / 1e18) * supply; // market cap in the asset
    let marketCap = capOf(vQ, vTokens), venue = "hooker", pons = null;
    if (onPons) {
      pons = await cached(`evm:pons:${ponsToken}`, 10_000, async () => {
        const lt = await call(PONS_FACTORY, PONS_FACTORY_ABI, "getLaunchedToken", [ponsToken]);
        let cap = null;
        if (lt.phase === 0) { const [q, t] = await call(lt.curve, PONS_CURVE_ABI, "getReserves"); cap = capOf(q, t); }
        return { phase: lt.phase, curve: lt.curve, cap, feeRecipient: lt.creatorFeeRecipient };
      }).catch(() => null);
      marketCap = pons?.cap ?? null;
      venue = "pons";
    } else if (state === "complete") venue = "graduating";
    else if (state === "refunding") venue = "refunding";
    const fee = s.feeTiers[tier];
    const isEth = !x.address;
    return {
      chain: "rhc", mint: token, creator, name, symbol, image, createdAt: Number(createdAt), status: state === "trading" ? "trading" : state, venue,
      quote: { symbol: x.symbol, decimals: x.decimals, address: x.address },
      // the same shape as a Solana launch's metadata, so every card and page reads it the same way
      meta: { name, symbol, image: imageUrl(image, knowCid), description: meta.description, twitter: meta.socials.twitter || null, telegram: meta.socials.telegram || null, website: meta.socials.website || null },
      description: meta.description, socials: meta.socials,
      antiSnipe, antiSnipeStartPct: antiSnipe ? 50 : null, feeTier: tier, fees: { totalPct: fee.totalPct, creatorPct: fee.creatorPct, platformPct: fee.platformPct },
      progress: Math.min(1, Number(realQ) / Number(gradQ)), raised: fmt(x, realQ), target: fmt(x, gradQ), pot: fmt(x, pot),
      // ETH launches keep the fields the site already reads
      raisedEth: isEth ? fmt(x, realQ) : null, targetEth: isEth ? fmt(x, gradQ) : null, potEth: isEth ? fmt(x, pot) : null,
      marketCap, marketCapEth: isEth ? marketCap : null, marketCapUsd: marketCap != null && usd ? marketCap * usd : null, ethUsd: isEth ? usd : null, quoteUsd: usd,
      rules: { ...Object.fromEntries(Object.entries(rules).filter(([k]) => isNaN(k)).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])), ...(ext ?? {}) },
      live: state === "trading" ? await liveOf(token, ext, x).catch(() => null) : null,
      graduated: state === "trading" || state === "refunding" ? null : { status: state, ponsToken: onPons ? ponsToken : null, ponsUrl: onPons ? `https://www.ponsfamily.com/launchpad/${ponsToken}` : null, phase: pons?.phase ?? null, paid: state === "paid" },
      explorer: `${env.explorer}/token/${token}`,
    };
  }
  const quoteOf = async (token) => quoteOfToken.get(token) ?? assetOf((await P("launches", [token]))[18]);

  async function listAll(limit = 200) {
    return cached("evm:list", 5_000, async () => {
      const n = Number(await P("tokenCount"));
      const idx = Array.from({ length: Math.min(n, limit) }, (_, i) => BigInt(n - 1 - i));
      const tokens = await Promise.all(idx.map((i) => P("tokens", [i])));
      const out = await Promise.all(tokens.map((t) => summarize(t).catch((e) => (log("evm summary", t, e.shortMessage ?? e.message), null))));
      if (out.some((v) => v === null)) throw new Error("a launch could not be read: keeping the last list");
      const hidden = await hiddenSet();
      return out.filter((l) => !hidden.has(l.mint.toLowerCase()));
    });
  }

  /** The newest trades across every launch, in the shape the site's live feed reads (GET /api/trades). */
  async function recentTrades(n = 12) {
    const hidden = await hiddenSet();
    const last = indexer.trades.filter((t) => !hidden.has(String(t.token).toLowerCase())).slice(-n).reverse();
    return Promise.all(last.map(async (t) => {
      const [symbol, block, x] = await Promise.all([
        cached(`evm:sym:${t.token}`, 3_600_000, () => T(t.token, "symbol")),
        cached(`evm:blk:${t.block}`, 86_400_000, () => logClient.getBlock({ blockNumber: t.block })),
        quoteOf(t.token),
      ]);
      return { sig: t.tx, ok: true, who: `${t.trader.slice(0, 6)}…${t.trader.slice(-4)}`, kind: t.isBuy ? "buy" : "sell", symbol, amount: fmt(x, t.eth), unit: x.symbol, time: Number(block.timestamp), chain: "rhc" };
    }));
  }

  const tx = (data, value = 0n) => ({ chainId: env.chainId, to: pad, data, value: value.toString() });
  const big = (v, what) => { try { const n = BigInt(String(v ?? 0)); if (n < 0n) throw 0; return n; } catch { throw bad(`bad ${what}`); } };
  const wei = (v, what) => { try { const n = parseEther(String(v)); if (n < 0n) throw 0; return n; } catch { throw bad(`bad ${what}`); } };
  const ponsLaunchFee = () => cached("evm:ponsfee", 60_000, () => F("launchFee"));
  const bridgeable = (x) => !x.address || x.address.toLowerCase() === USDG.toLowerCase();

  const routes = {
    "GET /api/evm/info": async () => {
      const list = await assets();
      const base = await settings(ETH);
      const pairs = await Promise.all(list.map(async (x) => { const st = await settings(x); return { symbol: x.symbol, address: x.address, decimals: x.decimals, usd: await usdOf(x), sizes: st.sizes, feeTiers: st.feeTiers, ponsGraduation: st.ponsGraduationEth, bridgeable: bridgeable(x) }; }));
      return { ...base, pairs, ponsLaunchFeeEth: formatEther(await ponsLaunchFee()), ethUsd: await ethUsd().catch(() => null), explorer: env.explorer, platformToken: env.platformToken ?? null,
        // v3 rules (the same 14 as Solana's v3) need a v6+ launchpad
        v3: await padV3() };
    },
    "GET /api/evm/launches": async () => ({ launches: await listAll() }),
    "GET /api/evm/token/:token": async ({ params }) => {
      const f = featuredOf(params.token);
      if (f) return cached(`evm:feat:${f.token}`, 5_000, () => summarizeFeatured(f));
      await notHidden(params.token);
      return cached(`evm:tok:${params.token}`, 2_000, () => summarize(addr(params.token)));
    },
    "GET /api/evm/token/:token/trades": async ({ params }) => {
      if (featuredOf(params.token)) return { unit: "ETH", trades: [] }; // it trades on Pons, not on our curve
      await notHidden(params.token);
      const t = addr(params.token), x = await quoteOf(t);
      return { unit: x.symbol, trades: indexer.trades.filter((r) => r.token === t).slice(-100).reverse().map((r) => ({ ...r, eth: formatUnits(r.eth, x.decimals), tokens: formatEther(r.tokens), fee: formatUnits(r.fee, x.decimals), block: r.block.toString() })) };
    },
    "GET /api/evm/token/:token/balance/:owner": async ({ params }) => {
      const t = addr(params.token), o = addr(params.owner), x = await quoteOf(t);
      return cached(`evm:bal:${t}:${o}`, 3_000, async () => {
        const [amount, eth, listed, quoteBal, allowance] = await Promise.all([T(t, "balanceOf", [o]), client.getBalance({ address: o }), T(t, "listed", [o]),
          x.address ? call(x.address, ERC20_ABI, "balanceOf", [o]) : null, x.address ? call(x.address, ERC20_ABI, "allowance", [o, pad]) : null]);
        return { amount: amount.toString(), decimals: 18, eth: Number(formatEther(eth)), listed, quote: { symbol: x.symbol, decimals: x.decimals, balance: x.address ? fmt(x, quoteBal) : Number(formatEther(eth)), allowance: x.address ? fmt(x, allowance) : null } };
      });
    },
    /** A wallet's launches and its creator fees waiting, per asset it launched in. */
    "GET /api/evm/wallet/:owner": async ({ params }) => {
      const o = addr(params.owner);
      const all = await listAll();
      const mine = all.filter((l) => l.creator === o);
      const seen = new Map([["ETH", ETH]]);
      for (const l of mine) seen.set(l.quote.symbol, await assetOf(l.quote.address));
      const fees = await Promise.all([...seen.values()].map(async (x) => ({ symbol: x.symbol, address: x.address, amount: fmt(x, await P("creatorFees", [o, x.address ?? ZERO])) })));
      const feat = featuredEvm().filter((f) => f.creator.toLowerCase() === o.toLowerCase()).map((f) => getAddress(f.token));
      return { created: [...feat, ...mine.map((l) => l.mint)], creatorFeesEth: fees[0].amount, creatorFees: fees.filter((f) => f.amount > 0) };
    },
    "GET /api/evm/quote/:token": async ({ params, query }) => {
      const t = addr(params.token);
      const l = await P("launches", [t]);
      const [stateN, , , , , vQ, vTokens, realQ, gradQ] = l;
      const x = await assetOf(l[18]);
      const st = STATES[stateN];
      if (st !== "trading" && !(st === "refunding" && query.get("side") === "sell")) throw bad("not trading");
      const bps = st === "refunding" ? 0n : BigInt(await P("currentFeeBps", [t]));
      if (query.get("side") === "sell") {
        const amount = big(query.get("amount") ?? "0", "amount");
        let gross = vQ - (vQ * vTokens + vTokens + amount - 1n) / (vTokens + amount);
        if (gross > realQ) gross = realQ;
        const fee = (gross * bps) / 10_000n;
        return { eth: formatUnits(gross - fee, x.decimals), unit: x.symbol, feeBps: Number(bps) };
      }
      const value = parseAmt(x, query.get("amount") ?? query.get("eth") ?? "0", "amount");
      let net = value - (value * bps) / 10_000n;
      if (realQ + net > gradQ) net = gradQ - realQ;
      const out = vTokens - (vQ * vTokens + vQ + net - 1n) / (vQ + net);
      // what the buyer receives: the contract takes the size fee and the burn out of `out` before the slippage check
      const r = await cached(`evm:rules:${t}`, 3_600_000, () => T(t, "rules"));
      const feeUnit = l[19];
      let fbps = 0n;
      if (r.feeCapBps > 0) { fbps = BigInt(r.feeBaseBps) + (BigInt(r.feePerEthBps) * net) / feeUnit; if (fbps > BigInt(r.feeCapBps)) fbps = BigInt(r.feeCapBps); }
      const received = out - (out * fbps) / 10_000n - (out * BigInt(r.burnBps)) / 10_000n;
      return { tokens: received.toString(), gross: out.toString(), feeBps: Number(bps), sizeFeeBps: Number(fbps), burnBps: Number(r.burnBps), unit: x.symbol };
    },
    /** The launch call. Rules come in the same shape the Solana form sends, minus the Solana-only rules. `quote` picks the pair asset. */
    "POST /api/evm/tx/launch": async ({ body }) => {
      const x = await assetBy(body.quote ?? "ETH");
      const s = await settings(x);
      const size = Number(body.size ?? 3), tier = Number(body.tier ?? 0);
      if (!(size >= 0 && size < s.sizes.length) || !(tier >= 0 && tier < s.feeTiers.length)) throw bad("size or fee step");
      const r = body.rules ?? {};
      const n = (k, max) => { const v = Number(r[k] ?? 0); if (!Number.isInteger(v) || v < 0 || v > max) throw bad(`rule ${k}`); return v; };
      const rules = {
        maxWalletBps: n("maxWalletBps", 10_000), earlySecs: n("earlySecs", 86_400), earlyMaxWalletBps: n("earlyMaxWalletBps", 10_000),
        rampStartBps: n("rampStartBps", 10_000), rampSecs: n("rampSecs", 7 * 86_400), tradeGuardBps: n("tradeGuardBps", 10_000),
        allowlist: !!r.allowlist, blocklist: !!r.blocklist, venueLock: !!r.venueLock, hoursOn: !!r.hoursOn, hoursDays: n("hoursDays", 127),
        hoursOpenMin: n("hoursOpenMin", 1_439), hoursCloseMin: n("hoursCloseMin", 1_439), tzOffsetMin: Math.max(-720, Math.min(840, Number(r.tzOffsetMin ?? 0) | 0)),
        bundleMax: n("bundleMax", 20), feeBaseBps: n("feeBaseBps", 2_000), feePerEthBps: n("feePerEthBps", 10_000), feeCapBps: n("feeCapBps", 2_000),
        burnBps: n("burnBps", 2_000), holderShareBps: n("holderShareBps", 10_000), holderRewards: !!r.holderRewards,
      };
      // v3 rules: the Solana names (lib/rules.mjs V3_OFF); amounts in whole tokens (plague dose, chapter volume) and,
      // for the King's minimum, in the launch's asset. The token factory and launchpad validate them again on chain.
      const v = body.ext ?? {};
      const b = (k) => !!v[k];
      const tok = (k) => { const t = Number(v[k] ?? 0); if (!(t >= 0) || t > 1e9) throw bad(`rule ${k}`); return parseEther(String(t)); };
      const xn = (k, max) => { const y = Number(v[k] ?? 0); if (!Number.isInteger(y) || y < 0 || y > max) throw bad(`rule ${k}`); return y; };
      const ext = {
        maxBuyBps: xn("maxBuyBps", 10_000), maxSellBps: xn("maxSellBps", 10_000), sellSmallBps: xn("sellSmallBps", 10_000), sellFloorBps: xn("sellFloorBps", 10_000), sellBagBps: xn("sellBagBps", 10_000),
        plagueDose: tok("plagueTokens"), dexOnly: b("dexOnly"), p2pOnly: b("p2pOnly"),
        potatoOn: b("potatoOn"), potatoMinBps: xn("potatoMinBps", 100), potatoColdSecs: xn("potatoColdSecs", 86_400),
        pingOn: b("pingOn"), pingMinBps: xn("pingMinBps", 100), pingFreeSecs: xn("pingFreeSecs", 86_400),
        chapterStartBps: xn("chapterStartBps", 10_000), chapterVolume: tok("chapterTokens"),
        oscKind: xn("oscKind", 4), oscPeriod: xn("oscPeriod", 3_600), oscBaseBps: xn("oscBaseBps", 10_000), oscFloorBps: xn("oscFloorBps", 10_000),
        oscAmpPct: xn("oscAmpPct", 100), oscDampPermille: xn("oscDampPermille", 400), oscCouplingPct: xn("oscCouplingPct", 60),
        kingOn: b("kingOn"), kingMin: b("kingOn") ? parseAmt(x, v.kingMin ?? 0, "King of the Hill minimum") : 0n, kingBeatPct: xn("kingBeatPct", 50),
        kingDecayUnit: xn("kingDecayUnit", 3), kingDecayN: xn("kingDecayN", 60), kingDevCan: b("kingDevCan"),
        hoursSells: b("hoursSells"), hoursHolidays: b("hoursHolidays"), hoursDst: xn("hoursDst", 2),
      };
      const anyV3 = Object.entries(EXT_OFF).some(([k, off]) => ext[k] !== off);
      const v3 = await padV3();
      if (anyV3 && !v3) throw bad("These hooks are not available on Pons yet.");
      const str = (v, max, what) => { const y = String(v ?? "").trim(); if (y.length > max) throw bad(`${what} is too long`); return y; };
      const name = str(body.name, 32, "name"), symbol = str(body.symbol, 10, "ticker");
      if (!name || !symbol) throw bad("name and ticker are required");
      const socials = { twitter: str(body.twitter, 200, "X link"), telegram: str(body.telegram, 200, "Telegram link"), discord: "", website: str(body.website, 200, "website"), farcaster: "" };
      const isEth = !x.address;
      // the creator's first buy: ETH with the call, or the pair asset pulled from the creator (approved first); then the ETH is Pons's launch fee
      const devBuy = body.devBuyEth ?? body.devBuy ?? 0;
      const quoteIn = isEth ? 0n : parseAmt(x, devBuy || 0, "dev buy");
      const value = isEth ? (devBuy ? wei(devBuy, "dev buy") : 0n) : await ponsLaunchFee();
      const input = { name, symbol, image: str(body.image, 512, "image link"), description: str(body.description, 2_000, "description"), socials, size, tier, antiSnipe: !!body.antiSnipe, rules, minTokensOut: 0n, quoteIn, quote: x.address ?? ZERO };
      const data = v3 ? encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "launch", args: [{ ...input, ext }] })
        : encodeFunctionData({ abi: LAUNCHPAD_ABI_V5, functionName: "launch", args: [input] });
      // a dry run catches a refused rule set before the wallet opens; a pair asset's approval and balance are checked first, in plain words
      if (body.from && !isEth && quoteIn > 0n) {
        const [allowance, balance] = await Promise.all([call(x.address, ERC20_ABI, "allowance", [addr(body.from), pad]), call(x.address, ERC20_ABI, "balanceOf", [addr(body.from)])]);
        if (balance < quoteIn) throw bad(`Not enough ${x.symbol} in the wallet for that first buy.`);
        if (allowance < quoteIn) throw bad(`Approve ${x.symbol} for the launchpad first.`);
      }
      if (body.from) await client.call({ account: addr(body.from), to: pad, data, value }).catch((e) => { throw bad(revertText(e)); });
      return { ...tx(data, value), quote: x.symbol, quoteIn: quoteIn.toString() };
    },
    /** A pair asset is pulled from the wallet by the launchpad: this approves it (ERC-20 approve on the asset). */
    "POST /api/evm/tx/approve": async ({ body }) => {
      const x = body.token ? await quoteOf(addr(body.token)) : await assetBy(body.quote);
      if (!x.address) throw bad("ETH needs no approval");
      const amount = body.amount === "max" ? (1n << 255n) : parseAmt(x, body.amount, "amount");
      return { chainId: env.chainId, to: x.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [pad, amount] }), value: "0", quote: x.symbol };
    },
    "POST /api/evm/tx/buy": async ({ body }) => {
      const t = addr(body.token), x = await quoteOf(t);
      const v = parseAmt(x, body.amount ?? body.eth, "amount");
      return tx(encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "buy", args: [t, v, big(body.minTokensOut ?? 0, "minTokensOut")] }), x.address ? 0n : v);
    },
    "POST /api/evm/tx/sell": async ({ body }) => { const t = addr(body.token); return tx(encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "sell", args: [t, big(body.amount, "amount"), big(body.minEthOut ?? 0, "minEthOut")] })); },
    "POST /api/evm/tx/claim": async ({ body }) => { const x = await assetBy(body?.quote ?? "ETH"); return tx(encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "claimCreatorFees", args: [x.address ?? ZERO] })); },
    "POST /api/evm/tx/list": async ({ body }) => {
      const wallets = (body.wallets ?? []).map(addr);
      if (!wallets.length || wallets.length > 500) throw bad("1 to 500 wallets per transaction");
      return { chainId: env.chainId, to: addr(body.token), data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "addToList", args: [wallets] }), value: "0" };
    },
    /** Whether a sent transaction landed (the site polls this instead of holding an RPC of its own). */
    "GET /api/evm/receipt/:hash": async ({ params }) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(params.hash)) throw bad("not a transaction hash");
      const r = (await client.getTransactionReceipt({ hash: params.hash }).catch(() => null)) ?? (await logClient.getTransactionReceipt({ hash: params.hash }).catch(() => null));
      if (!r) return { status: "pending" };
      if (r.status === "success") {
        indexer.refresh();
        // a launch: the new token's address, from the launchpad's own Launched event
        const ev = r.logs.find((l) => l.address.toLowerCase() === pad.toLowerCase() && l.topics[0] === LAUNCHED_TOPIC);
        return { status: "success", block: r.blockNumber.toString(), token: ev ? getAddress("0x" + ev.topics[1].slice(26)) : null };
      }
      // replay it to say why it failed
      const t = await client.getTransaction({ hash: params.hash }).catch(() => null);
      const why = t ? await client.call({ account: t.from, to: t.to, data: t.input, value: t.value, blockNumber: r.blockNumber - 1n }).then(() => null, revertText) : null;
      return { status: "reverted", error: why ?? "The transaction failed on chain." };
    },
    "POST /api/evm/tx/seal": async ({ body }) => ({ chainId: env.chainId, to: addr(body.token), data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "sealList" }), value: "0" }),
    /** Why a transaction would fail, in words (the site simulates before it opens the wallet). */
    "POST /api/evm/simulate": async ({ body }) => {
      try { await client.call({ account: addr(body.from), to: addr(body.to), data: body.data, value: big(body.value ?? 0, "value") }); return { ok: true }; }
      catch (e) { return { ok: false, error: revertText(e) }; }
    },
  };
  return { routes, listAll, summarize, summarizeFeatured, ponsCoinCap, indexer, settings, assets, recentTrades, stop: () => clearInterval(timer) };
}

/** ipfs://<cid> → the site's own image proxy (it caches whole images); https links as they are. */
export const imageUrl = (v, knowCid = () => {}) => { const m = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)$/.exec(String(v ?? "")); if (m) { knowCid(m[1]); return `/api/img/${m[1]}`; } return /^https:\/\//.test(String(v ?? "")) ? v : null; };

/** A revert as words: the hook's refusal codes, the launchpad's own reasons, or the node's message. */
export function revertText(e) {
  // the revert data: a contract call's own error, or the raw bytes a plain eth_call returned
  const named = e?.walk?.((x) => x?.data?.errorName)?.data;
  let name = named?.errorName, args = named?.args;
  if (!name) {
    const raw = e?.walk?.((x) => typeof x?.data === "string" && /^0x[0-9a-fA-F]{8}/.test(x.data))?.data
      ?? e?.walk?.((x) => typeof x?.raw === "string" && /^0x[0-9a-fA-F]{8}/.test(x.raw))?.raw
      ?? /0x[0-9a-fA-F]{8,}/.exec(String(e?.message ?? ""))?.[0];
    for (const abi of [LAUNCHPAD_ABI, TOKEN_ABI, ERC20_ERRORS]) {
      try { const r = decodeErrorResult({ abi, data: raw }); name = r.errorName; args = r.args; break; } catch {}
    }
    // a node that reports only the selector ("custom error 0x13be252b"): match it by signature
    if (!name && raw && raw.length === 10) name = SELECTORS.get(raw.toLowerCase()) ?? null;
  }
  if (name === "ERC20InsufficientAllowance" || name === "SafeERC20FailedOperation" || name === "InsufficientAllowance") return "Approve the asset for the launchpad first, and check the wallet holds enough of it.";
  if (name === "ERC20InsufficientBalance") return "Not enough of the asset in the wallet for this.";
  if (name === "HookRefused") return HOOK_ERRORS_EVM[Number(args[0])] ?? `Refused by the token's rules (code ${args[0]}).`;
  if (name === "Refused") return `Refused: ${args[0]}.`;
  if (/insufficient funds/i.test(e?.message ?? "")) return "Not enough ETH in the wallet for this.";
  return e?.shortMessage ?? e?.message ?? "The transaction would fail.";
}
