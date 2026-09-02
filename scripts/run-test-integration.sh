#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/migration-env.sh

load_env_var MODE "forking"
export AUTO_CONFIRM=true
export ALLOW_SKIP_STEPS=true
export SKIP_INTERFACES_CHECK=true
export SKIP_CONTRACT_SIZE=true
export SKIP_LINT_SOLIDITY=true

prepare_migration_env "test"
prepare_trace_args

# bash expands an unquoted ** as *, which drops the top-level files and the doubly nested suites
TEST_FILES=($(find test/integration -name '*.ts' | sort))

yarn hardhat --network "$RUN_NETWORK" test "${TEST_FILES[@]}" "${TRACE_ARGS[@]}"
