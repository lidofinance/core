#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/common-env.sh

load_env_var MODE "forking"
load_env_var UPGRADE "false"
load_env_var TEMPLATE_TEST "false"

echo "MODE: $MODE"
echo "UPGRADE: $UPGRADE"

load_env_var NETWORK "hardhat"
if [[ ${NETWORK:-} != "hardhat" ]]; then
  if [[ ${NETWORK} == "local" ]]; then
    # set default local rpc url if not
    load_env_var LOCAL_RPC_URL "http://localhost:8545"
  fi
  # Derive RPC_URL from <NETWORK>_RPC_URL if not set explicitly
  load_env_var RPC_URL || {
    RPC_VAR="${NETWORK^^}_RPC_URL"

    load_env_var "$RPC_VAR" || {
      echo "Error: RPC_URL or ${RPC_VAR} must be set"
      exit 1
    }
    echo "Derive RPC_URL from ${RPC_VAR}"
    export RPC_URL="${!RPC_VAR:-}"
  }
  # echo "RPC_URL: $RPC_URL"
fi

case "${MODE:-}" in
  scratch)
    case "${NETWORK:-}" in
      hardhat | local)
        :
        ;;
      *)
        export NETWORK="hardhat"
        ;;
    esac

    export NETWORK_STATE_FILE="deployed-hardhat.json"
    if [[ -f $NETWORK_STATE_FILE ]]; then
      rm -f $NETWORK_STATE_FILE
    fi

    load_env_var SCRATCH_DEPLOY_CONFIG "scripts/scratch/deploy-params-testnet.toml"
    echo "SCRATCH_DEPLOY_CONFIG: $SCRATCH_DEPLOY_CONFIG"

    load_env_var STEPS_FILE "scratch/steps.json"
    echo "STEPS_FILE: $STEPS_FILE"
    ;;
  forking)
    case "${NETWORK:-}" in
      hardhat)
        echo "Error: $(hardhat) network is not supported in forking mode"
        exit 1
        ;;
      local)
        # override fork block number to avoid HardHat uses lastSafeBlockNumber
        export FORKING_BLOCK_NUMBER="$(cast block-number --rpc-url "$LOCAL_RPC_URL")"
        ;;
      *)
        :
        ;;
    esac

    load_env_var NETWORK_STATE_FILE "deployed-${NETWORK}.json"
    echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"

    if [[ ${UPGRADE:-} == "true" ]]; then
      load_env_var UPGRADE_PARAMETERS_FILE "scripts/upgrade/upgrade-params-${NETWORK}.toml"
      echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"

      load_env_var STEPS_FILE "upgrade/steps-mock-upgrade.json"
      echo "STEPS_FILE: $STEPS_FILE"

      TEMP_NETWORK_STATE_FILE="deployed-${NETWORK}-upgrade.json"
      TEMP_UPGRADE_PARAMETERS_FILE="scripts/upgrade/upgrade-params-${NETWORK}-upgrade.toml"

      if [[ -f $TEMP_NETWORK_STATE_FILE ]]; then
        rm -f $TEMP_NETWORK_STATE_FILE
      fi

      if [[ -f $TEMP_UPGRADE_PARAMETERS_FILE ]]; then
        rm -f $TEMP_UPGRADE_PARAMETERS_FILE
      fi

      if [[ -f $NETWORK_STATE_FILE ]]; then
        cp "$NETWORK_STATE_FILE" "$TEMP_NETWORK_STATE_FILE"
        export NETWORK_STATE_FILE=$TEMP_NETWORK_STATE_FILE
      fi

      if [[ -f $UPGRADE_PARAMETERS_FILE ]]; then
        cp "$UPGRADE_PARAMETERS_FILE" "$TEMP_UPGRADE_PARAMETERS_FILE"
        export UPGRADE_PARAMETERS_FILE=$TEMP_UPGRADE_PARAMETERS_FILE
      fi
    else
      TEMP_NETWORK_STATE_FILE="deployed-hardhat.json"
      if [[ -f $TEMP_NETWORK_STATE_FILE ]]; then
        rm -f $TEMP_NETWORK_STATE_FILE
      fi

      if [[ -f $NETWORK_STATE_FILE ]]; then
        cp "$NETWORK_STATE_FILE" "$TEMP_NETWORK_STATE_FILE"
        export NETWORK_STATE_FILE=$TEMP_NETWORK_STATE_FILE
      fi
    fi

    export NETWORK="hardhat"
    ;;
  *)
    echo "Error: MODE must be set to $(scratch) or $(forking)"
    exit 1
    ;;
esac

export DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

export ALLOW_SKIP_STEPS=true
export AUTO_CONFIRM=true
export GAS_LIMIT=16000000
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export SKIP_INTERFACES_CHECK=true
export SKIP_CONTRACT_SIZE=true
export SKIP_GAS_REPORT=true
export SKIP_LINT_SOLIDITY=true

case "${TRACE:-}" in
  "")
    TRACE_ARGS=(--disabletracer)
    ;;
  trace)
    TRACE_ARGS=(--trace --disabletracer)
    ;;
  fulltrace)
    TRACE_ARGS=(--fulltrace --disabletracer)
    ;;
  all)
    TRACE_ARGS=(--fulltrace)
    ;;
  *)
    echo "Error: TRACE must be empty, 'trace', or 'fulltrace'"
    exit 1
    ;;
esac

yarn hardhat --network $NETWORK test test/integration/**/*.ts "${TRACE_ARGS[@]}"
