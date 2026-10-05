#!/usr/bin/env bash
# Local validator: the REAL mainnet bytecode of Meteora DBC + DAMM v2 and pump.fun cloned, plus our
# hook and the test app forwarder loaded at genesis (restart after rebuilding either).
# pump.fun account list from ~/pumpfamily/validator.sh (proven to run create_v2 locally).
set -euo pipefail
cd "$(dirname "$0")/.."
# default: Solana's public endpoint, so test runs never spend another project's RPC quota
RPC="${CLONE_RPC_URL:-https://api.mainnet-beta.solana.com}"
PORT="${LOCAL_RPC_PORT:-8997}"
DAMM_CFGS=$(node -e 'import("@meteora-ag/dynamic-bonding-curve-sdk").then(s=>console.log(s.DAMM_V2_MIGRATION_FEE_ADDRESS.map(a=>"--clone "+a).join(" ")))')
HOOK_ID=$(solana-keygen pubkey keys/hooker-hook-keypair.json)
APP_ID=$(solana-keygen pubkey keys/test-app-forwarder-keypair.json)
exec solana-test-validator --url "$RPC" --rpc-port "$PORT" --faucet-port $((PORT+3)) --gossip-port $((PORT+4)) \
  --dynamic-port-range $((PORT+10))-$((PORT+60)) --ledger test-ledger --reset --quiet \
  --limit-ledger-size 500000000 \
  `# mainnet's own Token-2022 and token-account programs, not the validator's built-in copies` \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --clone ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL \
  --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  $DAMM_CFGS \
  --clone-upgradeable-program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P \
  --clone-upgradeable-program pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ \
  --clone-upgradeable-program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA \
  `# PumpSwap's global config: pump.fun's migrate CPIs into it when a coin leaves the pump.fun curve` \
  --clone ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw \
  --clone C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw --clone 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf \
  --clone Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1 \
  --clone Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y \
  --clone TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM \
  --clone 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt \
  --clone 62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV \
  --clone 5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD \
  --clone-upgradeable-program MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e \
  --clone 13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ \
  --clone BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s \
  `# custom pairs: pump.fun's quote-control list + two real pair tokens with a TEST mint authority (scripts/make-pair-fixtures.mjs)` \
  --clone 6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP \
  --account 3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh fixtures/pair-WBTC-mint.json \
  --account XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W fixtures/pair-SPYx-mint.json \
  --bpf-program "$HOOK_ID" fixtures/hooker_hook.so \
  --bpf-program "$APP_ID" fixtures/test_app_forwarder.so
