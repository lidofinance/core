#!/bin/bash
set -e +u
set -o pipefail

export SKIP_GAS_REPORT=true
export SKIP_CONTRACT_SIZE=true
export SKIP_INTERFACES_CHECK=true

# Check for required environment variables
if [[ -z "${DEPLOYER}" ]]; then
  echo "Error: Environment variable DEPLOYER must be set"
  exit 1
fi
echo "DEPLOYER is $DEPLOYER"

if [[ -z "${NETWORK}" ]]; then
  echo "Error: Environment variable NETWORK must be set"
  exit 1
fi
echo "NETWORK is $NETWORK"

# RESUME (truthy) keeps the state file from a previous failed run so completed
# steps are skipped; see docs/scratch-deploy.md "Resuming a failed deploy".
case "$(echo "${RESUME:-}" | tr '[:upper:]' '[:lower:]')" in
  1 | true | yes | on) echo "RESUME is set: keeping ${NETWORK_STATE_FILE}" ;;
  *) rm -f "${NETWORK_STATE_FILE}" ;;
esac

# Compile contracts
yarn compile

# Generic migration steps file
export STEPS_FILE=scratch/steps.json

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts

# Final check: verify the deployed on-chain state with state-mate (foundry/lib/state-mate).
# The wiring config is scripts/scratch/state-mate/scratch.yaml; its .deployed/.inputs
# siblings and ABIs are generated from the network state file. STATE_MATE_CHECK=off skips it.
# Functional post-deploy checks live in the integration suite (see docs/testing.md).
if [[ "${STATE_MATE_CHECK:-on}" != "off" ]]; then
  state_file="${NETWORK_STATE_FILE:-deployed-${NETWORK}.json}"
  if [[ -z "${LOCAL_RPC_URL:-}${RPC_URL:-}" ]]; then
    echo "Error: the state-mate check needs LOCAL_RPC_URL or RPC_URL to be set (or set STATE_MATE_CHECK=off to skip it)"
    exit 1
  fi
  export LOCAL_RPC_URL="${LOCAL_RPC_URL:-$RPC_URL}"
  [[ -d foundry/lib/state-mate/node_modules ]] || (cd foundry/lib/state-mate && yarn install --immutable)
  NETWORK_STATE_FILE="$state_file" yarn ts-node scripts/scratch/state-mate/prepare-state-mate-check.ts
  state_mate_args=()
  # The l2 section of scratch.yaml holds the dual-governance checks
  grep -q '"dg:dualGovernance"' "$state_file" || state_mate_args+=(--only l1)
  config_path="$(pwd)/scripts/scratch/state-mate/scratch.yaml"
  (cd foundry/lib/state-mate && yarn start "$config_path" ${state_mate_args[@]+"${state_mate_args[@]}"})
fi
