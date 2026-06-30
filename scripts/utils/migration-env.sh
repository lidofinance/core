#!/usr/bin/env bash

DEFAULT_TEST_DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# NETWORK selects source artifacts and RPC namespace.
# RUN_NETWORK selects the Hardhat runtime passed via --network.

derive_rpc_url() {
  load_env_var RPC_URL && return 0

  local network="$1"
  if [[ $network == "hardhat" ]]; then
    return 0
  fi

  local rpc_var="${network^^}_RPC_URL"
  # rpc_var="$(printf '%s' "$network" | tr '[:lower:]' '[:upper:]' | tr '-' '_')_RPC_URL"
  if [[ $network == "local" ]]; then
    # set default local rpc url if not
    load_env_var "$rpc_var" "http://localhost:8545"
  else
    load_env_var "$rpc_var" || {
      echo "Error: RPC_URL or ${rpc_var} must be set"
      exit 1
    }
  fi

  echo "Derive RPC_URL from ${rpc_var}"
  export RPC_URL="${!rpc_var:-}"
}

copy_network_state_file() {
  local src_network="$1"
  local dst_network="$2"
  local remove_dst_file="$3"

  load_env_var NETWORK_STATE_FILE "deployed-${src_network}.json"
  local dst_network_state_file="deployed-${dst_network}.json"

  if is_true "$remove_dst_file"; then
    rm -f "$dst_network_state_file"
  fi

  if [[ -f $NETWORK_STATE_FILE ]]; then
    # do not overwrite existing file (allow keep state between runs on external nodes, e.g. when RUN_NETWORK=local)
    if [[ ! -f $dst_network_state_file ]]; then
      cp "$NETWORK_STATE_FILE" "$dst_network_state_file"
      echo "Copy: $NETWORK_STATE_FILE -> $dst_network_state_file"
    else
      echo "Using existing: $dst_network_state_file"
    fi
  fi
  export NETWORK_STATE_FILE="$dst_network_state_file"
}

copy_upgrade_parameters_file() {
  local src_network="$1"
  local dst_network="$2"
  local remove_dst_file="$3"

  load_env_var UPGRADE_PARAMETERS_FILE "scripts/upgrade/upgrade-params-${src_network}.toml"
  local dst_upgrade_parameters_file="scripts/upgrade/upgrade-params-${dst_network}.toml"

  if is_true "$remove_dst_file"; then
    rm -f "$dst_upgrade_parameters_file"
  fi

  if [[ -f $UPGRADE_PARAMETERS_FILE ]]; then
    # do not overwrite existing file (allow keep state between runs on external nodes, e.g. when RUN_NETWORK=local)
    if [[ ! -f $dst_upgrade_parameters_file ]]; then
      cp "$UPGRADE_PARAMETERS_FILE" "$dst_upgrade_parameters_file"
      echo "Copy: $UPGRADE_PARAMETERS_FILE -> $dst_upgrade_parameters_file"
    else
      echo "Using existing: $dst_upgrade_parameters_file"
    fi
  fi
  export UPGRADE_PARAMETERS_FILE="$dst_upgrade_parameters_file"
}

prepare_migration_env() {
  local command="${1:-migrate}"

  # MODE env is undefined by default, this allows to identify real forking mode
  load_env_var MODE ""
  echo "MODE: $MODE"
  normalize_bool_env UPGRADE "false"
  echo "UPGRADE: $UPGRADE"

  load_env_var NETWORK "hardhat"
  load_env_var RUN_NETWORK || {
    if [[ $NETWORK != "local" && $MODE == "forking" ]]; then
      export RUN_NETWORK="hardhat"
      load_env_var FORKING_BLOCK_NUMBER ""
    else
      export RUN_NETWORK="$NETWORK"
    fi
  }
  echo "NETWORK: $NETWORK"
  echo "RUN_NETWORK: $RUN_NETWORK"

  if [[ $RUN_NETWORK == "hardhat" ]]; then
    derive_rpc_url "$NETWORK"
  else
    derive_rpc_url "$RUN_NETWORK"
  fi
  echo "RPC_URL: $RPC_URL"

  if [[ -n ${FORKING_BLOCK_NUMBER:-} ]]; then
    echo "FORKING_BLOCK_NUMBER: ${FORKING_BLOCK_NUMBER}"
  fi

  load_env_var NETWORK_STATE_FILE "deployed-${NETWORK}.json"

  if [[ $MODE == "scratch" ]]; then
    rm -f "$NETWORK_STATE_FILE"

    load_env_var SCRATCH_DEPLOY_CONFIG "scripts/scratch/deploy-params-testnet.toml"
    load_env_var STEPS_FILE "scratch/steps.json"

    export GENESIS_TIME=1639659600
  else
    # if MODE env is undefined, it means run migration on external node directly
    if [[ $NETWORK != $RUN_NETWORK ]]; then
      local remove_dst_file="false"
      # always delete any files from previous runs of HardHat in-process node
      if [[ $RUN_NETWORK == "hardhat" || $command == "test" ]]; then
        remove_dst_file="true"
      fi

      copy_network_state_file "$NETWORK" "$RUN_NETWORK" "$remove_dst_file"

      load_env_var HOLDER ""
      # export ALLOW_SKIP_STEPS=1
      # export AUTO_CONFIRM=1
      export DEPLOYER="$DEFAULT_TEST_DEPLOYER"
      export GAS_LIMIT=16000000
      export GAS_PRIORITY_FEE=1
      export GAS_MAX_FEE=100
    fi

    if [[ $UPGRADE == "true" ]]; then
      load_env_var UPGRADE_PARAMETERS_FILE "scripts/upgrade/upgrade-params-${NETWORK}.toml"
      load_env_var STEPS_FILE "upgrade/steps-upgrade.json"

      # if MODE env is undefined, it means run migration on external node directly
      if [[ $NETWORK != $RUN_NETWORK ]]; then
        local remove_dst_file="false"
        # always delete any files from previous runs of HardHat in-process node
        if [[ $RUN_NETWORK == "hardhat" || $command == "test" ]]; then
          remove_dst_file="true"
        fi

        copy_upgrade_parameters_file "$NETWORK" "$RUN_NETWORK" "$remove_dst_file"
      fi
    fi
    export MODE="forking"
  fi

  echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"
  if [[ -n ${UPGRADE_PARAMETERS_FILE:-} ]]; then
    echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"
  fi
  if [[ -n ${SCRATCH_DEPLOY_CONFIG:-} ]]; then
    echo "SCRATCH_DEPLOY_CONFIG: $SCRATCH_DEPLOY_CONFIG"
  fi
  if [[ -n ${STEPS_FILE:-} ]]; then
    echo "STEPS_FILE: $STEPS_FILE"
  fi

  load_env_var DEPLOYER "$DEFAULT_TEST_DEPLOYER"
  normalize_bool_env ALLOW_SKIP_STEPS "true"
  normalize_bool_env AUTO_CONFIRM "false"

  echo "DEPLOYER: $DEPLOYER"
  if [[ -n ${HOLDER:-} ]]; then
    echo "HOLDER: $HOLDER"
  fi
  echo "ALLOW_SKIP_STEPS: $ALLOW_SKIP_STEPS"
  echo "AUTO_CONFIRM: $AUTO_CONFIRM"

  load_env_var GAS_PRIORITY_FEE "1"
  load_env_var GAS_MAX_FEE "100"
  load_env_var GAS_LIMIT "16000000"
  load_env_var GENESIS_TIME "1639659600"
}

prepare_trace_args() {
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
      echo "Error: TRACE must be empty, 'trace', 'fulltrace', or 'all'"
      exit 1
      ;;
  esac
}

load_env_var() {
  local name="$1"
  local default="${2-}"

  # try load from env
  if [[ -n ${!name:-} ]]; then
    export "$name"
    return 0
  fi

  # try load from .env
  if [[ -f .env ]]; then
    local value
    value="$(
      set -a
      . ./.env
      printf '%s' "${!name:-}"
    )"

    if [[ -n $value ]]; then
      export "$name=$value"
      return 0
    fi
  fi

  # use default value if provided
  if [[ $# -ge 2 ]]; then
    export "$name=$default"
    return 0
  fi

  return 1
}

is_true() {
  case "${1:-}" in
    true | TRUE | True | 1 | yes | YES | Yes | y | Y | on | ON | On)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_bool_env() {
  local name="$1"
  local default="$2"

  load_env_var "$name" "$default"
  if is_true "${!name:-}"; then
    export "$name=true"
  else
    export "$name=false"
  fi
}
