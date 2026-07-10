#!/usr/bin/env bash
set -e +u
set -o pipefail

export STEPS_FILE=tooling/steps-deploy-alerting-harness.json

bash scripts/dao-deploy.sh
