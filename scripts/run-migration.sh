#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/migration-env.sh

prepare_migration_env
print_migration_env

echo "Compiling contracts..."
yarn hardhat compile

echo "Starting migration..."
yarn hardhat --network "$RUN_NETWORK" run --no-compile scripts/utils/migrate.ts

# Need this to get sure the last transactions are mined
# yarn hardhat --network "$RUN_NETWORK" run --no-compile scripts/utils/mine.ts
