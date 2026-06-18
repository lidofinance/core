#!/usr/bin/env bash
set -e +u
set -o pipefail

export NETWORK=local

bash scripts/dao-deploy.sh

# Run acceptance tests
export INTEGRATION_WITH_CSM="off"
yarn test:integration:fork:local
