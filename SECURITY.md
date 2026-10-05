# Security

Hooker runs with real money on Solana mainnet and Robinhood Chain. If you find a way to break a token's rules, take funds from a curve or a graduation, or make the site sign or relay something it should not, please tell us privately first.

- DM [@hookerdotfun](https://x.com/hookerdotfun) on X.
- Say which part it is in (the Solana hook program, the Robinhood Chain contracts, the API, the site) and how to reproduce it.

We answer within a day, fix it before saying anything public, and credit you if you want.

## What is in scope

- `programs/hooker-hook`: the Solana transfer hook (program `GE5TW1AFehhNFLYiSiaAkmbTjnHTB3hdhw6ZZFBP5sLV`).
- `evm/src`: the Robinhood Chain token and launchpad (`0xbd8e608d3314240c48c8e0c85bc3da4a8b8447f8`).
- `server/` and `lib/`: the API and the graduation services.
- `web/`: the site.

## What is not

- Pumpfun, Pons, Meteora, Jupiter and the chains themselves. Report those to their teams.
- The economics of a token someone launched (its rules, its fees, its creator).
