// RPC_URL=… PLATFORM_KEY=keys/platform.json HOOK_PROGRAM=… node scripts/create-configs.mjs
import { env, connect, loadKeypair } from "../lib/env.mjs";
import { ensureConfigs } from "../lib/configs.mjs";
const configs = await ensureConfigs({ conn: connect(), platform: loadKeypair(env.platformKeyPath), hookProgram: env.hookProgram, dataDir: env.dataDir });
console.log(configs);
