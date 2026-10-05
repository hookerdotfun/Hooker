# Hooker

**Launch a Pumpfun or Pons token with rules built into the token itself.** · [hooker.fun](https://hooker.fun) · [@hookerdotfun](https://x.com/hookerdotfun)

A Hooker token carries its rules (hooks) in the token itself. The creator picks the hooks at launch, the chain runs them on every buy, sell and transfer, and a trade that breaks the rules never lands. The token trades on a bonding curve shaped exactly like the one it graduates into, and when the curve fills it **graduates into a normal coin** in one transaction: the curve's money creates and buys the new coin, and every holder receives their share automatically.

It runs on two chains:

| | Solana | Robinhood Chain |
|---|---|---|
| Graduates into | a **Pumpfun** coin | a **Pons V2** coin |
| The rules | a Token-2022 **transfer hook** | the **token contract** itself |
| The curve | a Meteora bonding curve shaped like Pumpfun's | Hooker's own curve, shaped like Pons's |
| Paid in | SOL | ETH |
| Wallets | Phantom, Solflare, Backpack, … | MetaMask, Rabby, … |

Every Solana token address (the Hooker token and its Pumpfun coin) ends in `hook`.

**The burn.** Every coin that graduates names Hooker's burn wallet as its creator, so the coin's creator fees on Pumpfun or Pons buy $HOOKER and burn it, forever (`lib/flywheel.mjs`; Pons fees are bridged to Solana through Relay). A creator can route a coin's fees to its holders instead with the "Creator fees to holders" hook. Every claim and burn is a public transaction, listed on hooker.fun.

## Hooks

All hooks are off by default; a creator combines any of them.

| Hook | What it does |
|---|---|
| Allowlist / Blocklist | Only listed wallets can buy and hold it, or listed wallets never can |
| Max per wallet | No wallet can hold more than a set share of supply |
| Launch window | A tighter cap for the first minutes |
| Rising max per wallet | The cap starts small and rises on a timer |
| Trade guard | No single trade can move more than a set share of supply |
| Sniper-fee cap | Buys paying sniper-sized priority fees or tips are refused at launch (Solana) |
| Anti-bundle | Only a few buys can land in one block |
| Anti-snipe fee | The trading fee starts at 50% and falls to 1% over two minutes |
| FOMO only | Only the FOMO app can buy; selling works anywhere (Solana) |
| Trading hours | Trades only on chosen days and hours |
| Size fee · Auto burn · Holder share | Bigger buys pay more, a share of every buy is burned, part of the fees buys extra coins for holders |
| Creator fees to holders | After graduation, the coin's creator fees go to its holders instead of the $HOOKER burn (Pumpfun holder rewards, or Pons holder fee sharing) |

Holders can always sell back into the curve.

**At launch a creator also picks** where it graduates, a graduation size (35–100% of Pumpfun's or Pons's own), and their fee per trade (default, 1%, 2% or 3%). On Pumpfun they can pick a **custom pair**: one of Pumpfun's own custom-pair tokens (BTC, ETH, PUMP, xStocks, …) with at least $1M of liquidity, with a Pumpfun creator fee of 0.01–3%. At graduation the curve's SOL is swapped into the pair through Jupiter; if the pair no longer qualifies then, the coin pairs with SOL instead.

## How it is built

| Path | What |
|---|---|
| `programs/hooker-hook` | The Solana transfer hook (native Rust). Per-token rules at PDA `["cfg", mint]`, lists at `["list", mint]` |
| `evm/src/HookerToken.sol` | The Robinhood Chain token: the same rules in its transfer, and each holder's balance × time for holder share |
| `evm/src/HookerLaunchpad.sol` | The Robinhood Chain curve, and its graduation: Pons V2 `launchAndBuy` in one transaction, then every holder paid on chain |
| `lib/rules.mjs` | The rules layout, validation (mirrors the program) and refusal messages |
| `lib/curve.mjs`, `lib/configs.mjs` | Economics and the Pumpfun-shaped Meteora curves (one config per size × anti-snipe × fee step), remade when Pumpfun changes its curve |
| `lib/launch.mjs` | The Solana launch transaction (pool + rules + the creator's buy in one transaction) and trade builders |
| `lib/settle.mjs` | Replays a Solana token's on-chain history into each holder's Pumpfun allocation |
| `lib/graduate.mjs` | The Solana graduation service: idempotent, ledger-first steps (every signature stored before it is sent) |
| `lib/pairs.mjs` | Custom pairs: Pumpfun's quote-control list, liquidity and safety checks, the Jupiter swap |
| `lib/pumpprice.mjs` | Prices a coin in every phase: Hooker curve → Pumpfun curve → PumpSwap |
| `lib/evm.mjs` | The Robinhood Chain API: one launchpad per asset (ETH, USDG), launches, quotes, trades, and the transactions the site asks a wallet to send |
| `lib/flywheel.mjs` | The burn: claims the burn wallet's creator fees, buys $HOOKER on PumpSwap and burns it |
| `lib/lander.mjs` | Rebroadcasts a signed Solana transaction until it lands or provably cannot |
| `lib/relay.mjs` | What the API will relay: only the transactions the site builds |
| `server/api.mjs` | The HTTP API. It builds every transaction; the browser only signs |
| `server/graduator.mjs`, `server/evm-graduator.mjs` | The graduation services, one per chain |
| `server/gate.mjs` | An optional login gate in front of the site |
| `web/` | The site (React 19 + Vite; Wallet Standard for Solana, EIP-6963 for EVM wallets; no chain library in the browser) |
| `tools/grind` | Grinds `…hook` vanity keys |
| `test/`, `evm/test/` | Unit tests and end-to-end suites against a local validator and a fork of Robinhood Chain |

## Running it locally

Requirements: Node 22+, the Solana CLI (Agave 4.x, for `solana-test-validator` and `cargo-build-sbf`), Rust, and Foundry for the Robinhood Chain side.

```sh
npm install && (cd web && npm install)
solana-keygen new --no-bip39-passphrase -o keys/hooker-hook-keypair.json        # the hook's program id, locally
solana-keygen new --no-bip39-passphrase -o keys/test-app-forwarder-keypair.json # a test-only app program (never deployed)
(cd programs/test-app-forwarder && cargo-build-sbf --sbf-out-dir ../../fixtures)
(cd programs/hooker-hook && cargo-build-sbf --sbf-out-dir ../../fixtures)       # build the hook
node scripts/make-pair-fixtures.mjs                                              # two real pair tokens, for the pair tests
nohup ./scripts/validator.sh > validator.log 2>&1 &                              # a local validator with mainnet's Meteora + Pumpfun
(cd tools/grind && cargo build --release) && tools/grind/target/release/hooker-grind hook 5 6 keys/test-vanity
(cd evm && forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.7.0 --no-git && forge build)
node scripts/evm-abi.mjs                                                         # the contracts' ABIs for the API
```

Tests:

```sh
node --test test/*.test.mjs              # unit tests
node test/e2e.mjs                        # launch → trade → graduate → every holder paid
TEST_SIZES=2 node test/e2e-v2.mjs        # every hook, against the real programs
node test/api.mjs                        # the HTTP API
TEST_SIZES=2 node test/e2e-pairs.mjs     # graduating into custom pairs (WBTC, an xStock), and the SOL fallback
(cd evm && forge test)                   # every Robinhood Chain hook, no network
node test/e2e-evm.mjs                    # Robinhood Chain: launch → trade → graduate into Pons → every holder paid
```

The end-to-end suites run against the **real mainnet bytecode**: Meteora's bonding curve and Pumpfun cloned into the local validator, and a fork of live Robinhood Chain with the real Pons V2 contracts. `node scripts/evm-local.mjs` starts that fork with the launchpad deployed, to try the site against it.

## On chain

- Solana hook program: `GE5TW1AFehhNFLYiSiaAkmbTjnHTB3hdhw6ZZFBP5sLV`
- Robinhood Chain launchpad (ETH): `0x376e3648c57e0e9154103f458cc1ce3f88445c19`
- Robinhood Chain launchpad (USDG pairs): `0x2d2d03fbfca55626b78d734b5526446e58c6b527`
- Burn wallet (the creator of every graduated coin, buys and burns $HOOKER): `hookXkHBi86pLTAPxShbvXiQsAPuyDmnanfXDs38p8n`

## Security

- The rules are enforced by the token on chain; nobody can change them after launch.
- Graduation is run by Hooker's services with their own wallets: every step is a public transaction. On Solana every payout can be recomputed from the token's on-chain history (`lib/settle.mjs`); on Robinhood Chain the payout is computed by the contract itself, and `graduate` and `payout` can be called by anyone.
- No keys are in this repository. `keys/`, `data/` and every `.env` are ignored.

Found a problem? Reach us at [@hookerdotfun](https://x.com/hookerdotfun).
