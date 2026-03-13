#!/bin/bash
set -e +u
set -o pipefail

export NETWORK=${NETWORK:="hoodi"}
export RPC_URL=${RPC_URL:="http://127.0.0.1:8545"}

export DEPLOYER=${DEPLOYER:="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}
export GAS_PRIORITY_FEE=${GAS_PRIORITY_FEE:=1}
export GAS_MAX_FEE=${GAS_MAX_FEE:=100}

export NETWORK_STATE_FILE=${NETWORK_STATE_FILE:="deployed-hoodi.json"}
export STEPS_FILE=${STEPS_FILE:="upgrade/steps-srv3-cmv2-hoodi.json"}
export UPGRADE_PARAMETERS_FILE=${UPGRADE_PARAMETERS_FILE:="scripts/upgrade/upgrade-params-hoodi.toml"}
export STAKING_ROUTER_V3_VOTE_PROPOSAL_METADATA=${STAKING_ROUTER_V3_VOTE_PROPOSAL_METADATA:="staking-router-v3-vote"}

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts
