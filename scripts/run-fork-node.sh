#!/usr/bin/env bash
set -e +u
set -o pipefail

. .env

if [[ -z ${NETWORK} ]]; then
  echo "Error: Environment variable NETWORK must be set"
  exit 1
fi
echo "NETWORK: $NETWORK"

# Derive RPC_URL from <NETWORK>_RPC_URL if not set explicitly
if [[ -z ${RPC_URL} ]]; then
  RPC_VAR="${NETWORK^^}_RPC_URL"
  RPC_URL="${!RPC_VAR}"
  if [[ -z ${RPC_URL} ]]; then
    echo "Error: RPC_URL is not set and ${RPC_VAR} is also not set"
    exit 1
  fi
  echo "RPC_URL derived from \${${RPC_VAR}}"
  export RPC_URL
fi

TEMP_NETWORK_STATE_FILE="deployed-local.json"
TEMP_UPGRADE_PARAMETERS_FILE="upgrade-params-local.toml"

if [[ -f $TEMP_NETWORK_STATE_FILE ]]; then
  rm -f $TEMP_NETWORK_STATE_FILE
fi

if [[ -f $TEMP_UPGRADE_PARAMETERS_FILE ]]; then
  rm -f $TEMP_UPGRADE_PARAMETERS_FILE
fi

echo "RPC_URL: $RPC_URL"
echo "FORKING_BLOCK_NUMBER: $FORKING_BLOCK_NUMBER"
BLOCK_ARG=${FORKING_BLOCK_NUMBER:+--fork-block-number $FORKING_BLOCK_NUMBER}

yarn hardhat node --fork $RPC_URL $BLOCK_ARG --nocompile --trace --gascost --vvv
# anvil -f $RPC_URL $BLOCK_ARG --chain-id 1 --config-out localhost.json --timeout 90000 --print-traces --steps-tracing --auto-impersonate
