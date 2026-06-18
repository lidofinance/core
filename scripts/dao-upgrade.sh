#!/usr/bin/env bash
set -e +u
set -o pipefail

export UPGRADE=true

bash scripts/doa-deploy.sh
