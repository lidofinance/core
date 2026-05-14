#!/bin/bash
# Agent-friendly wrapper around dao-sepolia-fork-deploy.sh.
#
# Full deploy + integration-test output lands in $LOG_FILE (default
# logs/scratch-deploy-sepolia-fork.log). Only milestones, mocha counts, and
# failures reach the terminal. Any arg after the script is forwarded to
# dao-sepolia-fork-deploy.sh.
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${LOG_FILE:-logs/scratch-deploy-sepolia-fork.log}"

exec bash "$HERE/run-logged.sh" "$LOG_FILE" bash "$HERE/dao-sepolia-fork-deploy.sh" "$@"
