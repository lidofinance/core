#!/usr/bin/env bash
set -e +u
set -o pipefail

export SKIP_INTERFACES_CHECK=true
export SKIP_CONTRACT_SIZE=true
export SKIP_GAS_REPORT=true
export SKIP_LINT_SOLIDITY=true
# migration-env.sh only defaults STEPS_FILE when MODE=scratch, but a devnet deploy
# against an external node leaves MODE unset/forking -> migrate.ts aborts with
# 'Please provide a STEPS_FILE'. Set it explicitly.
export STEPS_FILE=scratch/steps.json

bash scripts/run-migration.sh
