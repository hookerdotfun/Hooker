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

const ABI = JSON.parse(readFileSync(new URL("./evm-abi.json", import.meta.url)));
export const LAUNCHPAD_ABI = ABI.launchpad;
export const TOKEN_ABI = ABI.token;
export const LAUNCHPAD_BYTECODE = ABI.launchpadBytecode;
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
};
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", Accept: "application/json" };
const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
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
const PONS_FEE_ABI = [{ type: "function", name: "launchFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
/** Pair assets priced at one dollar; every other pair asset needs a feed before it is offered. */
const STABLE = new Set(["USDG", "USDC", "USDT"]);
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
  /** launchpads priced in a Pons pair asset (one per asset): "0xaddress@deployBlock,…" */
  pairLaunchpads: (process.env.EVM_PAIR_LAUNCHPADS || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [a, b] = x.split("@"); return { address: getAddress(a), deployBlock: BigInt(b || 0) }; }),
  explorer: process.env.EVM_EXPLORER || "https://robinhoodchain.blockscout.com",
});

export function evmClient(url, chainId, { timeout = 30_000 } = {}) {
  return createPublicClient({ chain: rhc(chainId, url), transport: http(url, { fetchOptions: { headers: UA }, retryCount: 3, timeout, batch: { wait: 10 } }), batch: { multicall: { wait: 10 } }, cacheTime: 0 });
}

export function addr(v) {
  if (!isAddress(String(v ?? ""), { strict: false })) { const e = new Error(`not an address: ${String(v).slice(0, 60)}`); e.status = 400; throw e; }
  return getAddress(String(v));
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
export function createEvm({ cached, ethUsd, knowCid = () => {}, env = evmEnv(), client = evmClient(env.callRpcUrl, env.chainId), logClient = evmClient(env.rpcUrl, env.chainId), log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  if (!env.launchpad) return null;
  const call = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const T = (token, fn, args) => call(token, TOKEN_ABI, fn, args);
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };

  // ── the launchpads: the ETH one, then one per pair asset (USDG, …); each has its own trade indexer ──
  const pads = [{ address: env.launchpad, deployBlock: env.deployBlock, quote: null, symbol: "ETH", decimals: 18 },
    ...(env.pairLaunchpads ?? []).map((p) => ({ ...p, quote: undefined }))];
  for (const p of pads) { p.indexer = tradeIndexer({ client: logClient, launchpad: p.address, fromBlock: p.deployBlock, log }); p.P = (fn, args) => call(p.address, LAUNCHPAD_ABI, fn, args); }
  const timer = setInterval(() => pads.forEach((p) => p.indexer.refresh()), 3_000);
  timer.unref?.();
  pads.forEach((p) => p.indexer.refresh());
  /** A pair launchpad's asset is read from the contract once (symbol and decimals from the token). */
  let padsReady = null;
  const ready = () => (padsReady ??= Promise.all(pads.filter((p) => p.quote === undefined).map(async (p) => {
    p.quote = await p.P("quote");
    [p.symbol, p.decimals] = await Promise.all([call(p.quote, ERC20_ABI, "symbol"), call(p.quote, ERC20_ABI, "decimals")]);
  })).then(() => pads).catch((e) => { padsReady = null; throw e; }));
  const fmt = (p, x) => Number(formatUnits(x, p.decimals));
  const parseAmt = (p, v, what) => { try { const x = parseUnits(String(v), p.decimals); if (x < 0n) throw 0; return x; } catch { throw bad(`bad ${what}`); } };
  const usdOf = async (p) => (p.quote === null ? ethUsd().catch(() => null) : STABLE.has(p.symbol) ? 1 : null);
  const padBySymbol = async (sym) => { await ready(); const p = pads.find((x) => x.symbol.toLowerCase() === String(sym ?? "ETH").toLowerCase() || (x.quote && x.quote.toLowerCase() === String(sym).toLowerCase())); if (!p) throw bad("no launchpad for that pair"); return p; };
  /** Which launchpad a token lives on (each token is created by exactly one). */
  const padByToken = new Map();
  async function padOf(token) {
    const hit = padByToken.get(token);
    if (hit) return hit;
    await ready();
    for (const p of pads) { const l = await p.P("launches", [token]); if (Number(l[0]) !== 0) { padByToken.set(token, p); return p; } }
    throw Object.assign(new Error("not a Hooker token"), { status: 404 });
  }

  const settings = (p = pads[0]) => cached(`evm:settings:${p.address}`, 60_000, async () => {
    await ready();
    const [virtualQ, supply, ponsGrad, feeUnit, ...rest] = await Promise.all([p.P("virtualEth"), p.P("supply"), p.P("ponsGraduationEth"), p.P("feeUnit"),
      ...[0, 1, 2, 3].map((i) => p.P("sizeBps", [BigInt(i)])), ...[0, 1, 2, 3].map((i) => p.P("feeBps", [BigInt(i)])), ...[0, 1, 2, 3].map((i) => p.P("creatorBps", [BigInt(i)]))]);
    const sizeBps = rest.slice(0, 4).map(Number), feeBps = rest.slice(4, 8).map(Number), creatorBps = rest.slice(8, 12).map(Number);
    const v = fmt(p, virtualQ), ponsQ = fmt(p, ponsGrad);
    const capAt = (q) => (v + q) ** 2 / v;
    return {
      chainId: env.chainId, launchpad: p.address, quote: { symbol: p.symbol, decimals: p.decimals, address: p.quote }, virtualEth: String(v), supply: supply.toString(), ponsGraduationEth: ponsQ, feeUnit: feeUnit.toString(),
      sizes: sizeBps.map((b, i) => { const q = (ponsQ * b) / 10_000; return { index: i, eth: q, ponsOwn: b === 10_000, startCapEth: capAt(0), endCapEth: capAt(q) }; }),
      feeTiers: feeBps.map((f, i) => ({ index: i, totalPct: f / 100, creatorPct: creatorBps[i] / 100, platformPct: (f - creatorBps[i]) / 100 })),
      antiSnipeStartPct: 50,
    };
  });

  /** One launch, as the site shows it (the same fields as a Solana launch where they mean the same thing). */
  async function summarize(token, p = null) {
    p ??= await padOf(token);
    const l = await p.P("launches", [token]);
    if (Number(l[0]) === 0) throw Object.assign(new Error("not a Hooker token"), { status: 404 });
    const [name, symbol, image, rules, meta] = await Promise.all([
      T(token, "name"), T(token, "symbol"), cached(`evm:img:${token}`, 3_600_000, () => T(token, "image")),
      cached(`evm:rules:${token}`, 3_600_000, () => T(token, "rules")), cached(`evm:meta:${token}`, 3_600_000, () => p.P("meta", [token])),
    ]);
    const [stateN, creator, createdAt, tier, antiSnipe, vQ, vTokens, realQ, gradQ, pot, ponsToken] = l;
    const state = STATES[stateN] ?? "none";
    const onPons = state === "graduated" || state === "paid";
    const s = await settings(p);
    const usd = await usdOf(p);
    const supply = Number(BigInt(s.supply) / 10n ** 18n);
    // market cap in the quote asset: tokens have 18 decimals, the asset p.decimals
    const capOf = (q, t) => (Number(q) / 10 ** p.decimals) / (Number(t) / 1e18) * supply;
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
    const isEth = p.quote === null;
    return {
      chain: "rhc", mint: token, creator, name, symbol, image, createdAt: Number(createdAt), status: state === "trading" ? "trading" : state, venue,
      quote: { symbol: p.symbol, decimals: p.decimals, address: p.quote },
      // the same shape as a Solana launch's metadata, so every card and page reads it the same way
      meta: { name, symbol, image: imageUrl(image, knowCid), description: meta.description, twitter: meta.socials.twitter || null, telegram: meta.socials.telegram || null, website: meta.socials.website || null },
      description: meta.description, socials: meta.socials,
      antiSnipe, antiSnipeStartPct: antiSnipe ? 50 : null, feeTier: tier, fees: { totalPct: fee.totalPct, creatorPct: fee.creatorPct, platformPct: fee.platformPct },
      progress: Math.min(1, Number(realQ) / Number(gradQ)), raised: fmt(p, realQ), target: fmt(p, gradQ), pot: fmt(p, pot),
      // ETH launches keep the fields the site already reads
      raisedEth: isEth ? fmt(p, realQ) : null, targetEth: isEth ? fmt(p, gradQ) : null, potEth: isEth ? fmt(p, pot) : null,
      marketCap, marketCapEth: isEth ? marketCap : null, marketCapUsd: marketCap != null && usd ? marketCap * usd : null, ethUsd: isEth ? usd : null, quoteUsd: usd,
      rules: { ...Object.fromEntries(Object.entries(rules).filter(([k]) => isNaN(k)).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])) },
      graduated: state === "trading" || state === "refunding" ? null : { status: state, ponsToken: onPons ? ponsToken : null, ponsUrl: onPons ? `https://www.ponsfamily.com/launchpad/${ponsToken}` : null, phase: pons?.phase ?? null, paid: state === "paid" },
      explorer: `${env.explorer}/token/${token}`,
    };
  }

  async function listAll(limit = 200) {
    return cached("evm:list", 5_000, async () => {
      await ready();
      const out = [];
      for (const p of pads) {
        const n = Number(await p.P("tokenCount"));
        const idx = Array.from({ length: Math.min(n, limit) }, (_, i) => BigInt(n - 1 - i));
        const tokens = await Promise.all(idx.map((i) => p.P("tokens", [i])));
        tokens.forEach((t) => padByToken.set(t, p));
        const got = await Promise.all(tokens.map((t) => summarize(t, p).catch((e) => (log("evm summary", t, e.shortMessage ?? e.message), null))));
        if (got.some((x) => x === null)) throw new Error("a launch could not be read: keeping the last list");
        out.push(...got);
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    });
  }

  /** The newest trades across every launchpad, in the shape the site's live feed reads (GET /api/trades). */
  async function recentTrades(n = 12) {
    await ready();
    const last = pads.flatMap((p) => p.indexer.trades.slice(-n).map((x) => ({ x, p }))).sort((a, b) => (a.x.block < b.x.block ? 1 : -1)).slice(0, n);
    return Promise.all(last.map(async ({ x, p }) => {
      const [symbol, block] = await Promise.all([
        cached(`evm:sym:${x.token}`, 3_600_000, () => T(x.token, "symbol")),
        cached(`evm:blk:${x.block}`, 86_400_000, () => logClient.getBlock({ blockNumber: x.block })),
      ]);
      return { sig: x.tx, ok: true, who: `${x.trader.slice(0, 6)}…${x.trader.slice(-4)}`, kind: x.isBuy ? "buy" : "sell", symbol, amount: fmt(p, x.eth), unit: p.symbol, time: Number(block.timestamp), chain: "rhc" };
    }));
  }

  const tx = (p, data, value = 0n) => ({ chainId: env.chainId, to: p.address, data, value: value.toString() });
  const big = (v, what) => { try { const x = BigInt(String(v ?? 0)); if (x < 0n) throw 0; return x; } catch { throw bad(`bad ${what}`); } };
  const wei = (v, what) => { try { const x = parseEther(String(v)); if (x < 0n) throw 0; return x; } catch { throw bad(`bad ${what}`); } };
  const ponsLaunchFee = () => cached("evm:ponsfee", 60_000, () => call(PONS_FACTORY, PONS_FEE_ABI, "launchFee"));

  const routes = {
    "GET /api/evm/info": async () => {
      await ready();
      const base = await settings(pads[0]);
      const pairs = await Promise.all(pads.map(settings));
      return { ...base, pairs: pairs.map((x) => ({ ...x.quote, launchpad: x.launchpad, sizes: x.sizes, feeTiers: x.feeTiers, ponsGraduation: x.ponsGraduationEth, bridgeable: x.quote.symbol === "ETH" || STABLE.has(x.quote.symbol) })), ponsLaunchFeeEth: formatEther(await ponsLaunchFee()), ethUsd: await ethUsd().catch(() => null), explorer: env.explorer };
    },
    "GET /api/evm/launches": async () => ({ launches: await listAll() }),
    "GET /api/evm/token/:token": async ({ params }) => cached(`evm:tok:${params.token}`, 2_000, () => summarize(addr(params.token))),
    "GET /api/evm/token/:token/trades": async ({ params }) => {
      const t = addr(params.token), p = await padOf(t);
      return { unit: p.symbol, trades: p.indexer.trades.filter((x) => x.token === t).slice(-100).reverse().map((x) => ({ ...x, eth: formatUnits(x.eth, p.decimals), tokens: formatEther(x.tokens), fee: formatUnits(x.fee, p.decimals), block: x.block.toString() })) };
    },
    "GET /api/evm/token/:token/balance/:owner": async ({ params }) => {
      const t = addr(params.token), o = addr(params.owner), p = await padOf(t);
      return cached(`evm:bal:${t}:${o}`, 3_000, async () => {
        const [amount, eth, listed, quoteBal, allowance] = await Promise.all([T(t, "balanceOf", [o]), client.getBalance({ address: o }), T(t, "listed", [o]),
          p.quote ? call(p.quote, ERC20_ABI, "balanceOf", [o]) : null, p.quote ? call(p.quote, ERC20_ABI, "allowance", [o, p.address]) : null]);
        return { amount: amount.toString(), decimals: 18, eth: Number(formatEther(eth)), listed, quote: { symbol: p.symbol, decimals: p.decimals, balance: p.quote ? fmt(p, quoteBal) : Number(formatEther(eth)), allowance: p.quote ? fmt(p, allowance) : null } };
      });
    },
    /** A wallet's launches and its creator fees waiting, per launchpad. */
    "GET /api/evm/wallet/:owner": async ({ params }) => {
      const o = addr(params.owner);
      const all = await listAll();
      const fees = await Promise.all(pads.map(async (p) => ({ symbol: p.symbol, launchpad: p.address, amount: fmt(p, await p.P("creatorFees", [o])) })));
      return { created: all.filter((l) => l.creator === o).map((l) => l.mint), creatorFeesEth: fees[0].amount, creatorFees: fees.filter((f) => f.amount > 0) };
    },
    "GET /api/evm/quote/:token": async ({ params, query }) => {
      const t = addr(params.token), p = await padOf(t);
      const l = await p.P("launches", [t]);
      const [stateN, , , , , vQ, vTokens, realQ, gradQ] = l;
      const st = STATES[stateN];
      if (st !== "trading" && !(st === "refunding" && query.get("side") === "sell")) throw bad("not trading");
      const bps = st === "refunding" ? 0n : BigInt(await p.P("currentFeeBps", [t]));
      if (query.get("side") === "sell") {
        const amount = big(query.get("amount") ?? "0", "amount");
        let gross = vQ - (vQ * vTokens + vTokens + amount - 1n) / (vTokens + amount);
        if (gross > realQ) gross = realQ;
        const fee = (gross * bps) / 10_000n;
        return { eth: formatUnits(gross - fee, p.decimals), unit: p.symbol, feeBps: Number(bps) };
      }
      const value = parseAmt(p, query.get("amount") ?? query.get("eth") ?? "0", "amount");
      let net = value - (value * bps) / 10_000n;
      if (realQ + net > gradQ) net = gradQ - realQ;
      const out = vTokens - (vQ * vTokens + vQ + net - 1n) / (vQ + net);
      // what the buyer receives: the contract takes the size fee and the burn out of `out` before the slippage check
      const r = await cached(`evm:rules:${t}`, 3_600_000, () => T(t, "rules"));
      const feeUnit = BigInt((await settings(p)).feeUnit);
      let fbps = 0n;
      if (r.feeCapBps > 0) { fbps = BigInt(r.feeBaseBps) + (BigInt(r.feePerEthBps) * net) / feeUnit; if (fbps > BigInt(r.feeCapBps)) fbps = BigInt(r.feeCapBps); }
      const received = out - (out * fbps) / 10_000n - (out * BigInt(r.burnBps)) / 10_000n;
      return { tokens: received.toString(), gross: out.toString(), feeBps: Number(bps), sizeFeeBps: Number(fbps), burnBps: Number(r.burnBps), unit: p.symbol };
    },
    /** The launch call. Rules come in the same shape the Solana form sends, minus the Solana-only rules. `quote` picks the asset. */
    "POST /api/evm/tx/launch": async ({ body }) => {
      const p = await padBySymbol(body.quote ?? "ETH");
      const s = await settings(p);
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
      const str = (v, max, what) => { const x = String(v ?? "").trim(); if (x.length > max) throw bad(`${what} is too long`); return x; };
      const name = str(body.name, 32, "name"), symbol = str(body.symbol, 10, "ticker");
      if (!name || !symbol) throw bad("name and ticker are required");
      const socials = { twitter: str(body.twitter, 200, "X link"), telegram: str(body.telegram, 200, "Telegram link"), discord: "", website: str(body.website, 200, "website"), farcaster: "" };
      const isEth = p.quote === null;
      // the creator's first buy: ETH with the call, or the pair asset pulled from the creator (approved first); then the ETH is Pons's launch fee
      const devBuy = body.devBuyEth ?? body.devBuy ?? 0;
      const quoteIn = isEth ? 0n : parseAmt(p, devBuy || 0, "dev buy");
      const value = isEth ? (devBuy ? wei(devBuy, "dev buy") : 0n) : await ponsLaunchFee();
      const input = { name, symbol, image: str(body.image, 512, "image link"), description: str(body.description, 2_000, "description"), socials, size, tier, antiSnipe: !!body.antiSnipe, rules, minTokensOut: 0n, quoteIn };
      const data = encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "launch", args: [input] });
      // a dry run catches a refused rule set before the wallet opens; a pair asset's approval and balance are checked first,
      // in plain words (every asset reverts in its own way)
      if (body.from && !isEth && quoteIn > 0n) {
        const [allowance, balance] = await Promise.all([call(p.quote, ERC20_ABI, "allowance", [addr(body.from), p.address]), call(p.quote, ERC20_ABI, "balanceOf", [addr(body.from)])]);
        if (balance < quoteIn) throw bad(`Not enough ${p.symbol} in the wallet for that first buy.`);
        if (allowance < quoteIn) throw bad(`Approve ${p.symbol} for the launchpad first.`);
      }
      if (body.from) await client.call({ account: addr(body.from), to: p.address, data, value }).catch((e) => { throw bad(revertText(e)); });
      return { ...tx(p, data, value), quote: p.symbol, quoteIn: quoteIn.toString() };
    },
    /** A pair-asset launchpad pulls the asset from the wallet: this approves it (ERC-20 approve on the asset). */
    "POST /api/evm/tx/approve": async ({ body }) => {
      const p = body.token ? await padOf(addr(body.token)) : await padBySymbol(body.quote);
      if (!p.quote) throw bad("an ETH launchpad needs no approval");
      const amount = body.amount === "max" ? (1n << 255n) : parseAmt(p, body.amount, "amount");
      return { chainId: env.chainId, to: p.quote, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [p.address, amount] }), value: "0", quote: p.symbol };
    },
    "POST /api/evm/tx/buy": async ({ body }) => {
      const t = addr(body.token), p = await padOf(t);
      const v = parseAmt(p, body.amount ?? body.eth, "amount");
      return tx(p, encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "buy", args: [t, v, big(body.minTokensOut ?? 0, "minTokensOut")] }), p.quote ? 0n : v);
    },
    "POST /api/evm/tx/sell": async ({ body }) => { const t = addr(body.token), p = await padOf(t); return tx(p, encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "sell", args: [t, big(body.amount, "amount"), big(body.minEthOut ?? 0, "minEthOut")] })); },
    "POST /api/evm/tx/claim": async ({ body }) => tx(await padBySymbol(body?.quote ?? "ETH"), encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "claimCreatorFees" })),
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
        pads.forEach((p) => p.indexer.refresh());
        // a launch: the new token's address, from a launchpad's own Launched event
        const ev = r.logs.find((l) => pads.some((p) => l.address.toLowerCase() === p.address.toLowerCase()) && l.topics[0] === LAUNCHED_TOPIC);
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
  return { routes, listAll, summarize, pads, indexer: pads[0].indexer, settings, recentTrades, stop: () => clearInterval(timer) };
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
