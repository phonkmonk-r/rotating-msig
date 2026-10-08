#!/usr/bin/env bash
# Local RotationGuard demo on an Anvil fork of mainnet. Uses only the public test mnemonic and Anvil accounts.
#   demo/run.sh             run the demo and stop Anvil afterwards
#   KEEP=1 demo/run.sh      leave Anvil running on :8545 so you can poke at it with cast
#   ROUNDS=8 SIZE=12 demo/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="demo/out"
RPC="http://127.0.0.1:8545"
ROUNDS="${ROUNDS:-6}"
SIZE="${SIZE:-20}"
BASES=(100000 200000 300000)
CLI="node generator/dist/cli.js"

[ -f .env ] && set -a && source .env && set +a
: "${MAINNET_RPC_URL:?set MAINNET_RPC_URL in .env}"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

if curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' "$RPC" >/dev/null 2>&1; then
  echo "something is already listening on $RPC; stop it first" >&2
  exit 1
fi

rm -rf "$OUT" && mkdir -p "$OUT"
echo "test test test test test test test test test test test junk" > "$OUT/mnemonic.txt"

step "Building core and generator"
npm install --silent --no-audit --no-fund && npm run build --silent

step "Starting Anvil (mainnet fork)"
anvil --fork-url "$MAINNET_RPC_URL" --port 8545 --silent &
ANVIL_PID=$!
if [ -z "${KEEP:-}" ]; then trap 'kill $ANVIL_PID 2>/dev/null' EXIT; fi
until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.5; done
echo "fork ready at block $(cast block-number --rpc-url "$RPC")"

forge_run() {
  DEMO_BASE_0=${BASES[0]} DEMO_BASE_1=${BASES[1]} DEMO_BASE_2=${BASES[2]} \
    forge script script/Demo.s.sol:Demo --rpc-url "$RPC" --broadcast --slow "$@" 2>&1 \
    | sed -n '/== Logs ==/,/^$/p' | grep -vE '== Logs ==|No transactions to broadcast' || true
}

step "1. Deploy a 2-of-3 Safe (real Safe 1.5.0 contracts) and RotationGuard"
forge_run --sig "deploySafe()"
SAFE=$(jq -r .safe "$OUT/deployment.json")

step "2. Each signer generates a tree of fresh addresses bound to $SAFE"
for slot in 0 1 2; do
  $CLI generate --safe "$SAFE" --slot "$slot" --base "${BASES[$slot]}" --size "$SIZE" \
    --mnemonic-file "$OUT/mnemonic.txt" --out "$OUT/slot$slot.json" 2>/dev/null | sed -n '1,2p;5p'
  $CLI config --tree "$OUT/slot$slot.json" --cid "demo-slot-$slot" > "$OUT/slot$slot-config.json"
  $CLI entries --tree "$OUT/slot$slot.json" --from 1 --count $((SIZE - 1)) | jq '{count: length, entries: .}' > "$OUT/slot$slot-entries.json"
done

step "3. Legacy owners sign one setup transaction (2-of-3) installing the guard"
forge_run --sig "install()"

step "4. $ROUNDS transfers; every signer is rotated out in the same transaction"
forge_run --sig "rotate(uint256)" "$ROUNDS"

step "Final state"
forge_run --sig "status()"

if [ -n "${KEEP:-}" ]; then
  cat <<MSG

Anvil is still running on $RPC (pid $ANVIL_PID). Try:
  cast call $SAFE "getOwners()(address[])" --rpc-url $RPC
  DEMO_BASE_0=${BASES[0]} DEMO_BASE_1=${BASES[1]} DEMO_BASE_2=${BASES[2]} forge script script/Demo.s.sol:Demo --sig "rotate(uint256)" 1 --rpc-url $RPC --broadcast
Stop it with: kill $ANVIL_PID
MSG
fi
