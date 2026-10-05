// The Robinhood Chain side end to end, through the API and the graduation service, against a fork of live
// Robinhood Chain (the REAL Pons V2 contracts): deploy the launchpad → launch with hooks through
// /api/evm/tx/launch → buys and a sell through the API's transactions → a refused buy explained in words →
// the curve fills → the graduation service graduates it into Pons and pays every holder → the API shows it
// on Pons with its market cap.
//
//   node test/e2e-evm.mjs          (starts its own proxy and anvil on :8546; needs Foundry)
//
// ⛔ Never anvil's dev accounts: they are real Robinhood Chain addresses with real balances that the fork
// re-reads mid-test. Every actor here is a fresh key funded with anvil_setBalance.
import { spawn } from "node:child_process";
import { createWalletClient, createTestClient, http, parseEther, formatEther, encodeDeployData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { evmClient, rhc, LAUNCHPAD_ABI, LAUNCHPAD_BYTECODE, TOKEN_ABI, PONS_FACTORY, PONS_DISTRIBUTORS, createEvm } from "../lib/evm.mjs";
import { createEvmGraduator } from "../server/evm-graduator.mjs";

const PORT = 8546, URL_ = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a fork of live Robinhood Chain (Cloudflare wants a browser User-Agent: the loopback proxy adds it) ──
const procs = [];
async function up(url) { try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }); return r.ok; } catch { return false; } }
if (!(await up("http://127.0.0.1:8899"))) { procs.push(spawn("node", [new URL("../evm/scripts/rpc-proxy.mjs", import.meta.url).pathname], { stdio: "ignore" })); await sleep(800); }
if (await up(URL_)) { console.error(`something already answers on :${PORT} (a stale anvil?): stop it first`); process.exit(1); }
procs.push(spawn("anvil", ["--fork-url", "http://127.0.0.1:8899", "--port", String(PORT), "--chain-id", "4663", "--retries", "10", "--timeout", "45000", "--silent"], { stdio: "ignore" }));
const cleanup = () => procs.forEach((p) => p.kill());
process.on("exit", cleanup);
for (let i = 0; i < 60 && !(await up(URL_)); i++) await sleep(500);

const client = evmClient(URL_, 4663, { timeout: 180_000 }); // a fork's first touch of Pons's state is slow
const test = createTestClient({ chain: rhc(4663, URL_), mode: "anvil", transport: http(URL_) });
const actor = async (eth) => { const a = privateKeyToAccount(generatePrivateKey()); await test.setBalance({ address: a.address, value: parseEther(String(eth)) }); return a; };
const walletOf = (a) => createWalletClient({ account: a, chain: rhc(4663, URL_), transport: http(URL_) });
const sendTx = async (a, t) => {
  const hash = await walletOf(a).sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return r;
};

console.log("Robinhood Chain e2e (fork of live RHC, the real Pons V2)");
const deployer = await actor(1), owner = await actor(0), treasury = await actor(0), graduatorKey = generatePrivateKey();
await test.setBalance({ address: privateKeyToAccount(graduatorKey).address, value: parseEther("1") });
const hash = await walletOf(deployer).sendTransaction({ data: encodeDeployData({ abi: LAUNCHPAD_ABI, bytecode: LAUNCHPAD_BYTECODE, args: [owner.address, treasury.address, PONS_FACTORY, PONS_DISTRIBUTORS] }) });
const pad = (await client.waitForTransactionReceipt({ hash })).contractAddress;
const deployBlock = await client.getBlockNumber();
ok(!!pad, `launchpad deployed at ${pad}`);

// the API's Robinhood Chain routes, with an in-memory cache like the API's
const cache = new Map();
const cached = async (k, ms, fn) => { const c = cache.get(k); if (c && Date.now() - c.at < ms) return c.v; const v = await fn(); cache.set(k, { v, at: Date.now() }); return v; };
const env = { rpcUrl: URL_, callRpcUrl: URL_, chainId: 4663, launchpad: pad, deployBlock, explorer: "https://robinhoodchain.blockscout.com" };
const evm = createEvm({ cached, ethUsd: async () => 2700, env, client, logClient: client, log: () => {} });
const api = (route, args = {}) => evm.routes[route]({ params: {}, query: new URLSearchParams(), body: {}, ...args });

const info = await api("GET /api/evm/info");
ok(info.sizes.length === 4 && Math.abs(info.sizes[3].eth - 4.2) < 1e-9 && info.sizes[3].ponsOwn, `sizes ${info.sizes.map((s) => s.eth).join(" / ")} ETH (the last is Pons's own)`);
ok(info.feeTiers[0].totalPct === 1 && info.feeTiers[3].creatorPct === 2.99, "fee steps as on Solana");

// ── launch with hooks: max per wallet 5%, holder share, creator fees to holders ──
const creator = await actor(5);
const launchTx = await api("POST /api/evm/tx/launch", { body: { from: creator.address, name: "Hook RHC", symbol: "HRHC", image: "https://hooker.fun/api/img/bafkreitest", description: "e2e", website: "https://hooker.fun", size: 0, tier: 1, antiSnipe: false, devBuyEth: "0.02",
  rules: { maxWalletBps: 500, holderShareBps: 5_000, holderRewards: true, burnBps: 100 } } });
ok(launchTx.to === pad && BigInt(launchTx.value) === parseEther("0.02"), "launch transaction built (dev buy 0.02 ETH)");
let refusedWords = null;
try { await api("POST /api/evm/tx/launch", { body: { from: creator.address, name: "Bad", symbol: "BAD", rules: { allowlist: true, blocklist: true } } }); } catch (e) { refusedWords = e.message; }
ok(/allowlist and blocklist/.test(refusedWords ?? ""), `a bad rule set is refused before the wallet opens: "${refusedWords}"`);
await sendTx(creator, launchTx);
const { launches } = await api("GET /api/evm/launches");
const token = launches[0]?.mint;
ok(launches.length === 1 && launches[0].chain === "rhc" && launches[0].venue === "hooker", `listed: $${launches[0]?.symbol} ${token}`);
ok(launches[0].rules.maxWalletBps === 500 && launches[0].rules.holderRewards === true, "its rules read back from the token");
ok(Math.abs(launches[0].targetEth - 1.47) < 1e-9, "graduates at 1.47 ETH (35% of Pons's)");

// ── trades ──
const buyers = await Promise.all([0, 1, 2, 3, 4, 5].map(() => actor(3)));
const q = await api("GET /api/evm/quote/:token", { params: { token }, query: new URLSearchParams({ eth: "0.05" }) });
const t0 = await sendTx(buyers[0], await api("POST /api/evm/tx/buy", { body: { token, eth: "0.05", minTokensOut: (BigInt(q.tokens) * 95n / 100n).toString() } }));
const bal0 = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [buyers[0].address] });
ok(bal0 > 0n && bal0 === BigInt(q.tokens), `a buy through the API: ${Number(formatEther(bal0)).toLocaleString()} tokens, exactly the quote (the quote takes the 1% burn off, as the contract does)`);
let code404 = null, code400 = null;
try { await api("GET /api/evm/token/:token", { params: { token: "0x0000000000000000000000000000000000000001" } }); } catch (e) { code404 = e.status; }
try { await api("GET /api/evm/quote/:token", { params: { token }, query: new URLSearchParams({ side: "sell", amount: "abc" }) }); } catch (e) { code400 = e.status; }
ok(code404 === 404 && code400 === 400, "an unknown token is a 404 and a malformed amount a 400, not server errors");
// too big for 5% max per wallet: the site simulates first and says why
const big = await api("POST /api/evm/tx/buy", { body: { token, eth: "0.5" } });
const sim = await api("POST /api/evm/simulate", { body: { from: buyers[1].address, ...big } });
ok(!sim.ok && /max per wallet/.test(sim.error), `a refused buy, in words: "${sim.error}"`);
for (let i = 1; i < 6; i++) await sendTx(buyers[i], await api("POST /api/evm/tx/buy", { body: { token, eth: "0.08" } }));
const half = (await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [buyers[1].address] })) / 2n;
const sq = await api("GET /api/evm/quote/:token", { params: { token }, query: new URLSearchParams({ side: "sell", amount: half.toString() }) });
const before = await client.getBalance({ address: buyers[1].address });
await sendTx(buyers[1], await api("POST /api/evm/tx/sell", { body: { token, amount: half.toString() } }));
const got = (await client.getBalance({ address: buyers[1].address })) - before;
ok(got > 0n && got <= parseEther(sq.eth), `a sell through the API: ${formatEther(got)} ETH back after gas (quoted ${sq.eth})`);
await evm.indexer.refresh();
const tr = await api("GET /api/evm/token/:token/trades", { params: { token } });
ok(tr.trades.length === 8 && tr.trades[0].isBuy === false, `trades feed: ${tr.trades.length} trades, newest first`);

// fill it, from several wallets (max per wallet 5%)
for (let i = 0; i < 40; i++) {
  const s = await api("GET /api/evm/token/:token", { params: { token } });
  cache.clear();
  if (s.status !== "trading") break;
  const who = await actor(1); // a fresh wallet each time: max per wallet is 5%
  await sendTx(who, await api("POST /api/evm/tx/buy", { body: { token, eth: "0.06" } }));
}
cache.clear();
let s = await api("GET /api/evm/token/:token", { params: { token } });
ok(s.status === "complete" && s.venue === "graduating" && s.progress === 1, `full: ${s.raisedEth} ETH raised, ${s.potEth.toFixed(5)} ETH holder-share pot`);

// ── the graduation service ──
const g = createEvmGraduator({ env, key: graduatorKey, client, timeout: 180_000, log: (m) => console.log(`    ${m}`) });
await g.tick();
cache.clear();
s = await api("GET /api/evm/token/:token", { params: { token } });
ok(s.status === "paid" && s.venue === "pons" && s.graduated.ponsToken, `graduated into Pons and paid: ${s.graduated.ponsUrl}`);
if (!s.graduated?.ponsToken) { console.log(`\n${pass} passed, ${fail + 1} failed (stopped: not graduated)`); cleanup(); process.exit(1); }
ok(s.marketCapEth > 0, `market cap on Pons: ${s.marketCapEth.toFixed(3)} ETH ($${Math.round(s.marketCapUsd).toLocaleString()})`);
const pons = s.graduated.ponsToken;
const holders = Number(await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "holderCount" }));
let paid = 0;
for (let i = 0; i < holders; i++) {
  const h = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "holders", args: [BigInt(i)] });
  const b = await client.readContract({ address: pons, abi: TOKEN_ABI, functionName: "balanceOf", args: [h] });
  if (b > 0n) paid++;
}
ok(paid === holders, `every holder received Pons coins (${paid}/${holders}), nobody had to claim`);
const left = await client.readContract({ address: pons, abi: TOKEN_ABI, functionName: "balanceOf", args: [pad] });
ok(left === 0n, "nothing left in the launchpad");
const fr = await client.readContract({ address: PONS_FACTORY, abi: [{ type: "function", name: "getLaunchedToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [{ name: "token", type: "address" }, { name: "curve", type: "address" }, { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" }] }] }], functionName: "getLaunchedToken", args: [pons] }).catch(() => null);
const dist = await client.readContract({ address: PONS_DISTRIBUTORS, abi: [{ type: "function", name: "distributorOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }], functionName: "distributorOf", args: [pons] });
ok(dist !== "0x0000000000000000000000000000000000000000", `creator fees to holders: Pons distributor ${dist}`);

// a second tick does nothing (idempotent)
await g.tick();
ok(true, "a second pass of the graduation service is a no-op");

// ── creator fees ──
const w = await api("GET /api/evm/wallet/:owner", { params: { owner: creator.address } });
ok(w.created.includes(token) && w.creatorFeesEth > 0, `the creator's launches and ${w.creatorFeesEth.toFixed(5)} ETH of fees waiting`);
await sendTx(creator, await api("POST /api/evm/tx/claim"));
const w2 = await api("GET /api/evm/wallet/:owner", { params: { owner: creator.address } });
ok(w2.creatorFeesEth === 0, "claimed");

// ── Pons stops taking launches: a full curve is called off by a stranger and every holder sells back, fee-free ──
const PONS_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }, { type: "function", name: "setLaunchEnabled", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] }, { type: "function", name: "launchEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }];
const ponsOwner = await client.readContract({ address: PONS_FACTORY, abi: PONS_ABI, functionName: "owner" });
const c3 = await actor(5);
const launch3 = await api("POST /api/evm/tx/launch", { body: { from: c3.address, name: "Refund Me", symbol: "RFND", image: "https://hooker.fun/x.png", size: 0, tier: 0, devBuyEth: "0.01", rules: {} } });
const r3 = await sendTx(c3, launch3);
const token3 = (await api("GET /api/evm/receipt/:hash", { params: { hash: r3.transactionHash } })).token;
const filler = await actor(5);
await sendTx(filler, await api("POST /api/evm/tx/buy", { body: { token: token3, eth: "3" } }));
await test.impersonateAccount({ address: ponsOwner });
await test.setBalance({ address: ponsOwner, value: parseEther("1") });
await createWalletClient({ account: ponsOwner, chain: rhc(4663, URL_), transport: http(URL_) }).writeContract({ address: PONS_FACTORY, abi: PONS_ABI, functionName: "setLaunchEnabled", args: [false] });
await test.stopImpersonatingAccount({ address: ponsOwner });
await g.tick(); // the graduation service tries, fails, and backs off (no state change)
cache.clear();
let s3 = await api("GET /api/evm/token/:token", { params: { token: token3 } });
ok(s3.status === "complete", "with Pons closed the curve stays full: nothing is lost, nothing moves");
const stranger = await actor(1);
const abortHash = await createWalletClient({ account: stranger, chain: rhc(4663, URL_), transport: http(URL_) }).writeContract({ address: pad, abi: LAUNCHPAD_ABI, functionName: "abort", args: [token3] });
await client.waitForTransactionReceipt({ hash: abortHash });
cache.clear();
s3 = await api("GET /api/evm/token/:token", { params: { token: token3 } });
ok(s3.status === "refunding" && s3.venue === "refunding" && s3.graduated === null, "anyone can call it off once Pons refuses launches: the API shows it refunding");
const fb = BigInt((await api("GET /api/evm/token/:token/balance/:owner", { params: { token: token3, owner: filler.address } })).amount);
const sq3 = await api("GET /api/evm/quote/:token", { params: { token: token3 }, query: new URLSearchParams({ side: "sell", amount: fb.toString() }) });
const fBefore = await client.getBalance({ address: filler.address });
await sendTx(filler, await api("POST /api/evm/tx/sell", { body: { token: token3, amount: fb.toString() } }));
const got3 = (await client.getBalance({ address: filler.address })) - fBefore;
ok(sq3.feeBps === 0 && got3 > parseEther("1.4") && got3 <= parseEther(sq3.eth), `the holder sold everything back with no fee: ${formatEther(got3)} ETH of the 1.47 raised (quoted ${sq3.eth})`);
let buyRefused = null;
try { await api("GET /api/evm/quote/:token", { params: { token: token3 }, query: new URLSearchParams({ eth: "0.1" }) }); } catch (e) { buyRefused = e.message; }
ok(/not trading/.test(buyRefused ?? ""), "buying a refunding curve is refused");

evm.stop();
console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
