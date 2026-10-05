// A loopback JSON-RPC proxy for Foundry. Robinhood Chain's public RPC sits behind Cloudflare, which refuses
// Foundry's default User-Agent, and `forge`/`anvil --fork-url` cannot set headers. This listens on 127.0.0.1,
// forwards each request as it is, and adds a browser User-Agent on the way out. Nothing is logged or cached.
//
//   node evm/scripts/rpc-proxy.mjs            → use http://127.0.0.1:8899 as the RPC
//   PORT=9001 UPSTREAM=https://… node evm/scripts/rpc-proxy.mjs
import http from "node:http";

const PORT = Number(process.env.PORT || 8899);
const UPSTREAM = process.env.UPSTREAM || "https://rpc.mainnet.chain.robinhood.com";
const HEADERS = { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", accept: "application/json" };

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const r = await fetch(UPSTREAM, { method: "POST", headers: HEADERS, body: Buffer.concat(chunks), signal: AbortSignal.timeout(60_000) });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `proxy: ${e.message}` } }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`rpc proxy on http://127.0.0.1:${PORT} → ${UPSTREAM}`));
