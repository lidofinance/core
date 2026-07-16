#!/usr/bin/env bash
set -e +u
set -o pipefail

export SKIP_INTERFACES_CHECK=true
export SKIP_CONTRACT_SIZE=true
export SKIP_GAS_REPORT=true
export SKIP_LINT_SOLIDITY=true

# Pin the full scratch step list explicitly. The rewrite to run-migration.sh dropped the STEPS_FILE export,
# and migration-env.sh only defaults it on the MODE=scratch / UPGRADE=true paths — so the external-node
# (forking) deploy would otherwise die with "Please provide a STEPS_FILE environment variable!".
export STEPS_FILE=scratch/steps.json

bash scripts/run-migration.sh
