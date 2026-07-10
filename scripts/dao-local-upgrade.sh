#!/usr/bin/env bash
set -e +u
set -o pipefail

export NETWORK=local

bash scripts/dao-upgrade.sh

# Run acceptance tests
yarn test:integration:fork:local
