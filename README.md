# Hooker

**Launch a Pumpfun token with rules built into the token itself.** · [hooker.fun](https://hooker.fun) · [@hookerdotfun](https://x.com/hookerdotfun)

A Hooker token is a Solana **Token-2022** token with a **transfer hook**. The creator picks the hooks (rules) at launch; Solana runs the hook on every buy, sell and transfer, so a trade that breaks the rules never lands. The token trades on a **Meteora bonding curve shaped exactly like Pumpfun's**, and when the curve fills it **graduates into a normal Pumpfun coin**: in one transaction the curve's SOL creates and buys the new coin, and every holder receives their share automatically. Every token address (the Hooker token and its Pumpfun coin) ends in `hook`.

## Hooks

All hooks are off by default; a creator combines any of them.

| Hook | What it does |
|---|---|
| Allowlist / Blocklist | Only listed wallets can buy and hold it, or listed wallets never can |
| Max per wallet | No wallet can hold more than a set share of supply |
| Launch window | A tighter cap for the first minutes |
| Rising max per wallet | The cap starts small and rises on a timer |
| Trade guard | No single trade can move more than a set share of supply |
| Sniper-fee cap | Buys paying sniper-sized priority fees or tips are refused at launch |
| Anti-bundle | Only a few buys can land in one block |
| Anti-snipe fee | The trading fee starts at 50% and falls to 1% over two minutes |
| FOMO only | Only the FOMO app can buy; selling works anywhere |
| Trading hours | Trades only on chosen days and hours |
| Size fee · Auto burn · Holder share | Settled at graduation from the token's public trade history |
| Creator fees to holders | After graduation, the Pumpfun coin's creator fees go to holders |

Holders can always sell back into the curve.

**At launch a creator also picks** a graduation size (35–100% of Pumpfun's own), their fee per trade (default, 1%, 2% or 3%), and optionally a **custom Pumpfun pair**: one of Pumpfun's own custom-pair tokens (BTC, ETH, PUMP, xStocks, …) with at least $1M of liquidity, with a Pumpfun creator fee of 0.01–3%. At graduation the curve's SOL is swapped into the pair through Jupiter; if the pair no longer qualifies then, the coin pairs with SOL instead.

## How it is built

| Path | What |
|---|---|
| `programs/hooker-hook` | The transfer hook (native Rust). Per-token rules at PDA `["cfg", mint]`, lists at `["list", mint]` |
| `lib/rules.mjs` | The rules layout, validation (mirrors the program) and refusal messages |
| `lib/curve.mjs`, `lib/configs.mjs` | Economics and the Pumpfun-shaped Meteora curves (one config per size × anti-snipe × fee step), remade when Pumpfun changes its curve |
| `lib/launch.mjs` | The launch transaction (pool + rules + the creator's buy in one transaction) and trade builders |
| `lib/settle.mjs` | Replays a token's on-chain history into each holder's Pumpfun allocation |
| `lib/graduate.mjs` | The graduation service: idempotent, ledger-first steps (every signature stored before it is sent) |
| `lib/pairs.mjs` | Custom pairs: Pumpfun's quote-control list, liquidity and safety checks, the Jupiter swap |
| `lib/pumpprice.mjs` | Prices a coin in every phase: Hooker curve → Pumpfun curve → PumpSwap |
| `lib/lander.mjs` | Rebroadcasts a signed transaction until it lands or provably cannot |
| `lib/relay.mjs` | What the API will relay: only the transactions the site builds |
| `server/api.mjs` | The HTTP API. It builds every transaction; the browser only signs |
| `server/graduator.mjs` | The graduation service as a long-running process |
| `server/gate.mjs` | An optional login gate in front of the site |
| `web/` | The site (React 19 + Vite, Wallet Standard; no Solana library in the browser) |
| `tools/grind` | Grinds `…hook` vanity keys |
| `test/` | Unit tests and end-to-end suites against a local validator |

## Running it locally

Requirements: Node 22+, the Solana CLI (Agave 4.x, for `solana-test-validator` and `cargo-build-sbf`), Rust.

```sh
npm install && (cd web && npm install)
solana-keygen new --no-bip39-passphrase -o keys/hooker-hook-keypair.json        # the hook's program id, locally
solana-keygen new --no-bip39-passphrase -o keys/test-app-forwarder-keypair.json # a test-only app program (never deployed)
(cd programs/test-app-forwarder && cargo-build-sbf --sbf-out-dir ../../fixtures)
(cd programs/hooker-hook && cargo-build-sbf --sbf-out-dir ../../fixtures)       # build the hook
node scripts/make-pair-fixtures.mjs                                              # two real pair tokens, for the pair tests
nohup ./scripts/validator.sh > validator.log 2>&1 &                              # a local validator with mainnet's Meteora + Pumpfun
(cd tools/grind && cargo build --release) && tools/grind/target/release/hooker-grind hook 5 6 keys/test-vanity
```

Tests:

```sh
node --test test/*.test.mjs              # unit tests
node test/e2e.mjs                        # launch → trade → graduate → every holder paid
TEST_SIZES=2 node test/e2e-v2.mjs        # every hook, against the real programs
node test/api.mjs                        # the HTTP API
TEST_SIZES=2 node test/e2e-pairs.mjs     # graduating into custom pairs (WBTC, an xStock), and the SOL fallback
```

The end-to-end suites run against the **real mainnet bytecode** of Meteora's bonding curve and Pumpfun, cloned into the local validator.

## Security

- The rules are enforced by the token's transfer hook on Solana; nobody can change them after launch.
- Graduation is run by Hooker's service with its own wallet: every step is a public transaction, and every payout can be recomputed from the token's on-chain history (`lib/settle.mjs`).
- No keys are in this repository. `keys/`, `data/` and every `.env` are ignored.

Found a problem? Reach us at [@hookerdotfun](https://x.com/hookerdotfun).
