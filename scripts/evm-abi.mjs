// Copies the compiled contracts' ABIs (and the launchpad's bytecode, for local deploys) out of evm/out into
// lib/evm-abi.json, so the server needs neither Foundry nor the build folder.   node scripts/evm-abi.mjs
import { readFileSync, writeFileSync } from "node:fs";
const out = (n) => JSON.parse(readFileSync(new URL(`../evm/out/${n}.sol/${n}.json`, import.meta.url)));
const pad = out("HookerLaunchpad"), tok = out("HookerToken");
writeFileSync(new URL("../lib/evm-abi.json", import.meta.url), JSON.stringify({ launchpad: pad.abi, token: tok.abi, launchpadBytecode: pad.bytecode.object }) + "\n");
console.log("lib/evm-abi.json written");
