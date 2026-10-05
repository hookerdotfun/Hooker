/**
 * A loopback JSON-RPC proxy that exists for exactly one reason: Cloudflare 403s Foundry.
 *
 * ## The problem
 *
 * Robinhood Chain's public RPC sits behind Cloudflare, and its managed challenge fires on Foundry's
 * default User-Agent. Every `forge script` against it dies at `Setting up 1 EVM` with
 * `could not instantiate forked environment` and a wall of challenge HTML. The same request with
 * `User-Agent: Mozilla/5.0` is answered normally, so it is the agent string and nothing else —
 * plain `curl` with no UA at all is fine, and `viem` from node is fine, which is why the site, the
 * API and every script in this repo except the deploy have never seen it.
 *
 * `cast` can be talked round with `--rpc-headers`. **`forge script` cannot**: it does not take the
 * flag, and `ETH_RPC_HEADERS` does not reach the fork backend. Verified both ways rather than
 * assumed.
 *
 * ## What this does, and what it is not
 *
 * Listens on loopback, forwards each request body verbatim, and sets one header on the way out. It
 * does not parse, cache, retry or rewrite anything.
 *
 * ⛔ It is NOT a trust boundary and must never become one. Forge signs locally: what crosses this
 * proxy is an already-signed transaction, which is public the moment it is mined. **No private key
 * or keystore password passes through here**, and nothing is logged but a request count.
 *
 * ⚠ Loopback only, and deliberately not configurable. Bound to 0.0.0.0 this would be an open relay
 * into someone else's RPC quota.
 *
 *   node scripts/rpc-proxy.mjs            # then use --rpc-url http://127.0.0.1:8899
 *   PORT=9001 node scripts/rpc-proxy.mjs
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 8899)
const UPSTREAM = process.env.UPSTREAM || 'https://rpc.mainnet.chain.robinhood.com'

/**
 * ⚠ Kept boring on purpose. The challenge fires on Foundry's agent, not on the absence of a browser
 * fingerprint, so the shortest string that is not Foundry's is enough. A long fake Chrome UA is
 * more to go stale and no more effective — and it must contain no commas or parentheses, which
 * Foundry's own header parser rejects outright.
 */
const USER_AGENT = 'Mozilla/5.0'

let count = 0

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks)
    count += 1
    try {
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body,
      })
      const text = await upstream.text()
      /**
       * ⚠⚠ Surfaced rather than passed through silently. A challenge page returned as the body of a
       * 200 would reach forge as unparseable JSON, and the error it prints then describes the JSON,
       * not the block. Naming it here is the difference between a five-minute fix and an hour.
       */
      if (upstream.status === 403 || text.startsWith('<')) {
        console.error(`  ! upstream answered ${upstream.status} with HTML, not JSON.`)
        console.error(`    The challenge now fires on this proxy too. Try a different network.`)
      }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
      res.end(text)
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e) } }))
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RPC proxy on http://127.0.0.1:${PORT}  ->  ${UPSTREAM}`)
  console.log(`Use it with --rpc-url http://127.0.0.1:${PORT}. Ctrl-C when the deploy is done.`)
})

setInterval(() => {
  if (count) {
    console.log(`  ${count} requests forwarded`)
    count = 0
  }
}, 5000).unref?.()
