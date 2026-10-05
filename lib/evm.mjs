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
import { createPublicClient, http, encodeFunctionData, decodeEventLog, decodeErrorResult, getAddress, isAddress, toEventSelector, defineChain, formatEther, parseEther } from "viem";
import { readFileSync } from "node:fs";

const ABI = JSON.parse(readFileSync(new URL("./evm-abi.json", import.meta.url)));
export const LAUNCHPAD_ABI = ABI.launchpad;
export const TOKEN_ABI = ABI.token;
export const LAUNCHPAD_BYTECODE = ABI.launchpadBytecode;
export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const PONS_DISTRIBUTORS = "0x70e95CC5f03DB2906081E7a8D16e4C4209291507";
export const STATES = ["none", "trading", "complete", "graduated", "paid"];
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
export function createEvm({ cached, ethUsd, env = evmEnv(), client = evmClient(env.callRpcUrl, env.chainId), logClient = evmClient(env.rpcUrl, env.chainId), log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  if (!env.launchpad) return null;
  const pad = env.launchpad;
  const call = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const P = (fn, args) => call(pad, LAUNCHPAD_ABI, fn, args);
  const T = (token, fn, args) => call(token, TOKEN_ABI, fn, args);
  const indexer = tradeIndexer({ client: logClient, launchpad: pad, fromBlock: env.deployBlock, log });
  const timer = setInterval(() => indexer.refresh(), 3_000);
  timer.unref?.();
  indexer.refresh();

  const settings = () => cached("evm:settings", 60_000, async () => {
    const [virtualEth, supply, ponsGraduationEth, ...rest] = await Promise.all([P("virtualEth"), P("supply"), P("ponsGraduationEth"),
      ...[0, 1, 2, 3].map((i) => P("sizeBps", [BigInt(i)])), ...[0, 1, 2, 3].map((i) => P("feeBps", [BigInt(i)])), ...[0, 1, 2, 3].map((i) => P("creatorBps", [BigInt(i)]))]);
    const sizeBps = rest.slice(0, 4).map(Number), feeBps = rest.slice(4, 8).map(Number), creatorBps = rest.slice(8, 12).map(Number);
    const capAt = (eth) => ((Number(formatEther(virtualEth)) + eth) ** 2 / Number(formatEther(virtualEth)));
    const ponsEth = Number(formatEther(ponsGraduationEth));
    return {
      chainId: env.chainId, launchpad: pad, virtualEth: formatEther(virtualEth), supply: supply.toString(), ponsGraduationEth: ponsEth,
      sizes: sizeBps.map((b, i) => { const eth = (ponsEth * b) / 10_000; return { index: i, eth, ponsOwn: b === 10_000, startCapEth: capAt(0), endCapEth: capAt(eth) }; }),
      feeTiers: feeBps.map((f, i) => ({ index: i, totalPct: f / 100, creatorPct: creatorBps[i] / 100, platformPct: (f - creatorBps[i]) / 100 })),
      antiSnipeStartPct: 50,
    };
  });

  /** One launch, as the site shows it (the same fields as a Solana launch where they mean the same thing). */
  async function summarize(token) {
    const [l, name, symbol, image, rules, meta] = await Promise.all([
      P("launches", [token]), T(token, "name"), T(token, "symbol"), cached(`evm:img:${token}`, 3_600_000, () => T(token, "image")),
      cached(`evm:rules:${token}`, 3_600_000, () => T(token, "rules")), cached(`evm:meta:${token}`, 3_600_000, () => P("meta", [token])),
    ]);
    const [stateN, creator, createdAt, tier, antiSnipe, vEth, vTokens, realEth, gradEth, pot, ponsToken] = l;
    const state = STATES[stateN] ?? "none";
    const onPons = state === "graduated" || state === "paid";
    const s = await settings();
    const usd = await ethUsd().catch(() => null);
    const supply = Number(BigInt(s.supply) / 10n ** 18n);
    let marketCapEth = (Number(vEth) / Number(vTokens)) * supply, venue = "hooker", pons = null;
    if (onPons) {
      pons = await cached(`evm:pons:${ponsToken}`, 10_000, async () => {
        const lt = await call(PONS_FACTORY, PONS_FACTORY_ABI, "getLaunchedToken", [ponsToken]);
        let cap = null;
        if (lt.phase === 0) { const [q, t] = await call(lt.curve, PONS_CURVE_ABI, "getReserves"); cap = (Number(q) / Number(t)) * supply; }
        return { phase: lt.phase, curve: lt.curve, capEth: cap, feeRecipient: lt.creatorFeeRecipient };
      }).catch(() => null);
      marketCapEth = pons?.capEth ?? null;
      venue = "pons";
    } else if (state === "complete") venue = "graduating";
    const fee = s.feeTiers[tier];
    return {
      chain: "rhc", mint: token, creator, name, symbol, image, createdAt: Number(createdAt), status: state === "trading" ? "trading" : state, venue,
      // the same shape as a Solana launch's metadata, so every card and page reads it the same way
      meta: { name, symbol, image: imageUrl(image), description: meta.description, twitter: meta.socials.twitter || null, telegram: meta.socials.telegram || null, website: meta.socials.website || null },
      description: meta.description, socials: meta.socials,
      antiSnipe, antiSnipeStartPct: antiSnipe ? 50 : null, feeTier: tier, fees: { totalPct: fee.totalPct, creatorPct: fee.creatorPct, platformPct: fee.platformPct },
      progress: Math.min(1, Number(realEth) / Number(gradEth)), raisedEth: Number(formatEther(realEth)), targetEth: Number(formatEther(gradEth)), potEth: Number(formatEther(pot)),
      marketCapEth, marketCapUsd: marketCapEth != null && usd ? marketCapEth * usd : null, ethUsd: usd,
      rules: { ...Object.fromEntries(Object.entries(rules).filter(([k]) => isNaN(k)).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])) },
      graduated: state === "trading" ? null : { status: state, ponsToken: onPons ? ponsToken : null, ponsUrl: onPons ? `https://www.ponsfamily.com/launchpad/${ponsToken}` : null, phase: pons?.phase ?? null, paid: state === "paid" },
      explorer: `${env.explorer}/token/${token}`,
    };
  }

  async function listAll(limit = 200) {
    return cached("evm:list", 5_000, async () => {
      const n = Number(await P("tokenCount"));
      const idx = Array.from({ length: Math.min(n, limit) }, (_, i) => BigInt(n - 1 - i));
      const tokens = await Promise.all(idx.map((i) => P("tokens", [i])));
      return (await Promise.all(tokens.map((t) => summarize(t).catch((e) => (log("evm summary", t, e.shortMessage ?? e.message), null))))).filter(Boolean);
    });
  }

  /** The newest trades across every launch, in the shape the site's live feed reads (GET /api/trades). */
  async function recentTrades(n = 12) {
    const last = indexer.trades.slice(-n).reverse();
    return Promise.all(last.map(async (x) => {
      const [symbol, block] = await Promise.all([
        cached(`evm:sym:${x.token}`, 3_600_000, () => T(x.token, "symbol")),
        cached(`evm:blk:${x.block}`, 86_400_000, () => logClient.getBlock({ blockNumber: x.block })),
      ]);
      return { sig: x.tx, ok: true, who: `${x.trader.slice(0, 6)}…${x.trader.slice(-4)}`, kind: x.isBuy ? "buy" : "sell", symbol, amount: Number(formatEther(x.eth)), unit: "ETH", time: Number(block.timestamp), chain: "rhc" };
    }));
  }

  const tx = (data, value = 0n) => ({ chainId: env.chainId, to: pad, data, value: value.toString() });
  const wei = (v, what) => { try { const x = parseEther(String(v)); if (x < 0n) throw 0; return x; } catch { const e = new Error(`bad ${what}`); e.status = 400; throw e; } };
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };

  const routes = {
    "GET /api/evm/info": async () => ({ ...(await settings()), ethUsd: await ethUsd().catch(() => null), explorer: env.explorer }),
    "GET /api/evm/launches": async () => ({ launches: await listAll() }),
    "GET /api/evm/token/:token": async ({ params }) => cached(`evm:tok:${params.token}`, 2_000, () => summarize(addr(params.token))),
    "GET /api/evm/token/:token/trades": async ({ params }) => {
      const t = addr(params.token);
      return { trades: indexer.trades.filter((x) => x.token === t).slice(-100).reverse().map((x) => ({ ...x, eth: formatEther(x.eth), tokens: formatEther(x.tokens), fee: formatEther(x.fee), block: x.block.toString() })) };
    },
    "GET /api/evm/token/:token/balance/:owner": async ({ params }) => {
      const t = addr(params.token), o = addr(params.owner);
      return cached(`evm:bal:${t}:${o}`, 3_000, async () => {
        const [amount, eth, listed] = await Promise.all([T(t, "balanceOf", [o]), client.getBalance({ address: o }), T(t, "listed", [o])]);
        return { amount: amount.toString(), decimals: 18, eth: Number(formatEther(eth)), listed };
      });
    },
    /** A wallet's launches, its creator fees waiting, and what it holds. */
    "GET /api/evm/wallet/:owner": async ({ params }) => {
      const o = addr(params.owner);
      const all = await listAll();
      const fees = await P("creatorFees", [o]);
      return { created: all.filter((l) => l.creator === o).map((l) => l.mint), creatorFeesEth: Number(formatEther(fees)) };
    },
    "GET /api/evm/quote/:token": async ({ params, query }) => {
      const t = addr(params.token);
      const l = await P("launches", [t]);
      const [stateN, , , , , vEth, vTokens, realEth, gradEth] = l;
      if (STATES[stateN] !== "trading") throw bad("not trading");
      const bps = BigInt(await P("currentFeeBps", [t]));
      if (query.get("side") === "sell") {
        const amount = BigInt(query.get("amount") ?? "0");
        let gross = vEth - (vEth * vTokens + vTokens + amount - 1n) / (vTokens + amount);
        if (gross > realEth) gross = realEth;
        const fee = (gross * bps) / 10_000n;
        return { eth: formatEther(gross - fee), feeBps: Number(bps) };
      }
      const value = wei(query.get("eth") ?? "0", "amount");
      let net = value - (value * bps) / 10_000n;
      if (realEth + net > gradEth) net = gradEth - realEth;
      const out = vTokens - (vEth * vTokens + vEth + net - 1n) / (vEth + net);
      return { tokens: out.toString(), feeBps: Number(bps) };
    },
    /** The launch call. Rules come in the same shape the Solana form sends, minus the Solana-only rules. */
    "POST /api/evm/tx/launch": async ({ body }) => {
      const s = await settings();
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
      const input = { name, symbol, image: str(body.image, 512, "image link"), description: str(body.description, 2_000, "description"), socials, size, tier, antiSnipe: !!body.antiSnipe, rules, minTokensOut: 0n };
      const data = encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "launch", args: [input] });
      const value = body.devBuyEth ? wei(body.devBuyEth, "dev buy") : 0n;
      // a dry run catches a refused rule set before the wallet opens
      if (body.from) await client.call({ account: addr(body.from), to: pad, data, value }).catch((e) => { throw bad(revertText(e)); });
      return tx(data, value);
    },
    "POST /api/evm/tx/buy": async ({ body }) => tx(encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "buy", args: [addr(body.token), BigInt(body.minTokensOut ?? 0)] }), wei(body.eth, "amount")),
    "POST /api/evm/tx/sell": async ({ body }) => tx(encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "sell", args: [addr(body.token), BigInt(body.amount), BigInt(body.minEthOut ?? 0)] })),
    "POST /api/evm/tx/claim": async () => tx(encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: "claimCreatorFees" })),
    "POST /api/evm/tx/list": async ({ body }) => {
      const wallets = (body.wallets ?? []).map(addr);
      if (!wallets.length || wallets.length > 500) throw bad("1 to 500 wallets per transaction");
      return { chainId: env.chainId, to: addr(body.token), data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "addToList", args: [wallets] }), value: "0" };
    },
    /** Whether a sent transaction landed (the site polls this instead of holding an RPC of its own). */
    "GET /api/evm/receipt/:hash": async ({ params }) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(params.hash)) throw bad("not a transaction hash");
      const r = await client.getTransactionReceipt({ hash: params.hash }).catch(() => null);
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
      try { await client.call({ account: addr(body.from), to: addr(body.to), data: body.data, value: BigInt(body.value ?? 0) }); return { ok: true }; }
      catch (e) { return { ok: false, error: revertText(e) }; }
    },
  };
  return { routes, listAll, summarize, indexer, settings, recentTrades, stop: () => clearInterval(timer) };
}

/** ipfs://<cid> → the site's own image proxy (it caches whole images); https links as they are. */
export const imageUrl = (v) => { const m = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)$/.exec(String(v ?? "")); return m ? `/api/img/${m[1]}` : /^https:\/\//.test(String(v ?? "")) ? v : null; };

/** A revert as words: the hook's refusal codes, the launchpad's own reasons, or the node's message. */
export function revertText(e) {
  // the revert data: a contract call's own error, or the raw bytes a plain eth_call returned
  const named = e?.walk?.((x) => x?.data?.errorName)?.data;
  let name = named?.errorName, args = named?.args;
  if (!name) {
    const raw = e?.walk?.((x) => typeof x?.data === "string" && /^0x[0-9a-fA-F]{8}/.test(x.data))?.data ?? /0x[0-9a-fA-F]{8,}/.exec(String(e?.message ?? ""))?.[0];
    for (const abi of [LAUNCHPAD_ABI, TOKEN_ABI]) {
      try { const r = decodeErrorResult({ abi, data: raw }); name = r.errorName; args = r.args; break; } catch {}
    }
  }
  if (name === "HookRefused") return HOOK_ERRORS_EVM[Number(args[0])] ?? `Refused by the token's rules (code ${args[0]}).`;
  if (name === "Refused") return `Refused: ${args[0]}.`;
  if (/insufficient funds/i.test(e?.message ?? "")) return "Not enough ETH in the wallet for this.";
  return e?.shortMessage ?? e?.message ?? "The transaction would fail.";
}
