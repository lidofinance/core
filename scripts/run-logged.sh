#!/bin/bash
# Usage: scripts/run-logged.sh <log-file> <command...>
#
# Runs <command...>, writing full combined stdout+stderr to <log-file>. Only
# a curated subset is forwarded to the terminal so an LLM agent (or a human
# who just wants signal) isn't buried under gas reports, per-tx traces, or
# 700+ mocha test ticks. Full detail stays in the log.
#
# Forwarded lines: deploy-step completions, provision markers, mocha counts
# (passing/pending/failing), failure bullets, assertion/provider errors,
# hardhat/compile errors. At exit, prints the log path, exit code, log size,
# and the tail of the log.

set -o pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <log-file> <command...>" >&2
  exit 2
fi

LOG="$1"; shift
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

FILTER='✅|⚠️|Skipping|Funded Sepolia|^[[:space:]]*[0-9]+ (passing|pending|failing)\b|^[[:space:]]*[0-9]+\)[[:space:]]|AssertionError|ProviderError:|HardhatError|Compilation (failed|finished)|Nothing to compile|\bCompiled [0-9]+ Solidity|Deployed to|Error:[^(]|revert(ed)?\b'

# Run the command, tee every line to the log, filter to stdout.
"$@" 2>&1 | tee "$LOG" | grep -E --line-buffered "$FILTER"
CODE=${PIPESTATUS[0]}

SIZE=$(wc -c <"$LOG" | tr -d ' ')
LINES=$(wc -l <"$LOG" | tr -d ' ')

echo
echo "=== run-logged summary ==="
echo "exit code : $CODE"
echo "log file  : $LOG ($SIZE bytes, $LINES lines)"
echo "--- last 40 lines ---"
tail -n 40 "$LOG"

exit "$CODE"
