#!/usr/bin/env bash
# Report the tPOT balance (and nonce) for the wallet behind a private key, on Portaldot V3.
#
# Usage:
#   scripts/check-balance.sh                # prompt for private key (not echoed)
#   scripts/check-balance.sh 0x<pk>         # arg
#   PRIVATE_KEY=0x<pk> scripts/check-balance.sh
#   RPC_URL=https://custom scripts/check-balance.sh 0x<pk>
#
# The private key never leaves this shell: it is passed to `cast` only to derive the
# public address, nothing is logged, and the key itself is scrubbed from the environment
# before the balance query is sent.
#
# Requires `cast` from Foundry on PATH (https://getfoundry.sh).

set -euo pipefail

RPC_URL="${RPC_URL:-https://test-evm-rpc-v3.portaldot.dev}"

if ! command -v cast >/dev/null 2>&1; then
  echo "error: 'cast' not found on PATH. Install Foundry: curl -L https://foundry.paradigm.xyz | bash" >&2
  exit 1
fi

# Resolve the private key: arg > env > prompt. The prompt reads silently.
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  PK="$1"
elif [[ -n "${PRIVATE_KEY:-}" ]]; then
  PK="$PRIVATE_KEY"
else
  read -r -s -p "Private key (input hidden): " PK
  echo
fi

if [[ -z "${PK}" ]]; then
  echo "error: no private key provided" >&2
  exit 1
fi

# Normalise: add 0x if missing.
case "$PK" in
  0x*|0X*) ;;
  *) PK="0x$PK" ;;
esac

# Derive the address (reads PK only; never prints it).
ADDRESS="$(cast wallet address --private-key "$PK" 2>/dev/null)" || {
  echo "error: could not derive address from the given private key" >&2
  exit 1
}

# Scrub the key from the environment before any network call.
unset PK PRIVATE_KEY

# Query the chain.
WEI="$(cast balance --rpc-url "$RPC_URL" "$ADDRESS")"
# tPOT uses 18 decimals on the EVM side (nativeToEthRatio = 10000 bridges Substrate's 14 decimals).
TPOT="$(cast to-unit "$WEI" ether)"
CHAIN="$(cast chain-id --rpc-url "$RPC_URL")"
NONCE="$(cast nonce --rpc-url "$RPC_URL" "$ADDRESS")"

printf 'address: %s\n' "$ADDRESS"
printf 'balance: %s wei\n' "$WEI"
printf '       = %s tPOT\n' "$TPOT"
printf 'chainId: %s\n' "$CHAIN"
printf 'nonce:   %s\n' "$NONCE"
