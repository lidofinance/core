#!/bin/bash
# Agent-friendly wrapper around dao-local-deploy.sh.
#
# Full deploy + integration-test output lands in $LOG_FILE (default
# logs/scratch-deploy.log). Only milestones, mocha counts, and failures reach
# the terminal. Any arg after the script is forwarded to dao-local-deploy.sh.
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${LOG_FILE:-logs/scratch-deploy.log}"

exec bash "$HERE/run-logged.sh" "$LOG_FILE" bash "$HERE/dao-local-deploy.sh" "$@"
