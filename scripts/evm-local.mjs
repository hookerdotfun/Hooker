// A local Robinhood Chain for trying the Pons side by hand: a fork of live RHC (the real Pons V2) on :8546,
// with our launchpad deployed and a graduation wallet funded. Prints the env to run the API and the
// graduation service against it, and keeps running until Ctrl-C.
//
//   node scripts/evm-local.mjs
//   then, in other terminals, the lines it prints (API, graduator, site).
//
// To use it from a browser wallet: add a network with RPC http://127.0.0.1:8546 and chain id 4663, then fund
// your test address:  cast rpc anvil_setBalance <address> 0x8AC7230489E80000 --rpc-url http://127.0.0.1:8546
// ⛔ Never anvil's dev accounts: they are real Robinhood Chain addresses (see test/e2e-evm.mjs).
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createWalletClient, createTestClient, http, parseEther, encodeDeployData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { evmClient, rhc, LAUNCHPAD_ABI, LAUNCHPAD_BYTECODE, PONS_FACTORY, PONS_DISTRIBUTORS } from "../lib/evm.mjs";

const PORT = 8546, URL_ = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) { try { return (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok; } catch { return false; } }
const procs = [];
if (!(await up("http://127.0.0.1:8899"))) { procs.push(spawn("node", [new URL("../evm/scripts/rpc-proxy.mjs", import.meta.url).pathname], { stdio: "ignore" })); await sleep(800); }
if (await up(URL_)) { console.error(`something already answers on :${PORT}: stop it first`); process.exit(1); }
procs.push(spawn("anvil", ["--fork-url", "http://127.0.0.1:8899", "--port", String(PORT), "--chain-id", "4663", "--retries", "10", "--timeout", "45000", "--silent"], { stdio: "ignore" }));
process.on("SIGINT", () => { procs.forEach((p) => p.kill()); process.exit(0); });
for (let i = 0; i < 60 && !(await up(URL_)); i++) await sleep(500);

const client = evmClient(URL_, 4663, { timeout: 180_000 });
const test = createTestClient({ chain: rhc(4663, URL_), mode: "anvil", transport: http(URL_) });
const fresh = async (eth) => { const k = generatePrivateKey(), a = privateKeyToAccount(k); await test.setBalance({ address: a.address, value: parseEther(String(eth)) }); return { k, a }; };
const deployer = await fresh(1), treasury = await fresh(0), grad = await fresh(5);
const hash = await createWalletClient({ account: deployer.a, chain: rhc(4663, URL_), transport: http(URL_) }).sendTransaction({
  data: encodeDeployData({ abi: LAUNCHPAD_ABI, bytecode: LAUNCHPAD_BYTECODE, args: [deployer.a.address, treasury.a.address, grad.a.address, "0x0000000000000000000000000000000000000000", PONS_FACTORY, PONS_DISTRIBUTORS] }),
});
const r = await client.waitForTransactionReceipt({ hash });
const dir = new URL("../data/evm-local/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/graduator.key`, grad.k + "\n", { mode: 0o600 });
const envLine = `EVM_RPC_URL=${URL_} EVM_LAUNCHPAD=${r.contractAddress} EVM_DEPLOY_BLOCK=${r.blockNumber}`;
writeFileSync(`${dir}/env`, envLine + "\n");
console.log(`local Robinhood Chain on ${URL_} (chain id 4663), launchpad ${r.contractAddress}

  API:        ${envLine} DATA_DIR=${dir} RPC_URL=https://api.mainnet-beta.solana.com node server/api.mjs
  graduator:  ${envLine} EVM_KEY_FILE=${dir}graduator.key node server/evm-graduator.mjs
  site:       (cd web && npx vite)            → http://127.0.0.1:5311
Ctrl-C stops the chain.`);
await new Promise(() => {});
