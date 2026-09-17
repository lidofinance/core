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
# hardhat/compile errors. While the command runs, a periodic heartbeat reports
# elapsed time and log growth to the terminal — so a long quiet phase (e.g. a
# slow integration test, which mocha lets run up to 20 min before timing out)
# isn't mistaken for a freeze; it also flags when the log stops growing.
# At exit, prints the log path, exit code, log size, and the tail of the log.
#
# Tunables (env): HEARTBEAT_SECONDS (default 30; set 0 to disable).

set -o pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <log-file> <command...>" >&2
  exit 2
fi

LOG="$1"; shift
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

FILTER='✅|⚠️|Skipping|Funded Sepolia|^[[:space:]]*[0-9]+ (passing|pending|failing)\b|^[[:space:]]*[0-9]+\)[[:space:]]|AssertionError|ProviderError:|HardhatError|Compilation (failed|finished)|Nothing to compile|\bCompiled [0-9]+ Solidity|Deployed to|Error:[^(]|revert(ed)?\b'

# Heartbeat: while the command runs, periodically tell the terminal we're still
# alive and whether the log is still growing. Distinguishes "slow but working"
# from "actually stalled" without flooding stdout. Goes to stderr so it never
# lands in the (already complete) log. Disable with HEARTBEAT_SECONDS=0.
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-30}"
HB_PID=""
if [[ "$HEARTBEAT_SECONDS" != "0" ]]; then
  (
    el=0; prev=-1; stale=0
    while sleep "$HEARTBEAT_SECONDS"; do
      el=$((el + HEARTBEAT_SECONDS))
      ln=$(wc -l <"$LOG" 2>/dev/null | tr -d ' '); ln=${ln:-0}
      if [[ "$ln" == "$prev" ]]; then
        stale=$((stale + HEARTBEAT_SECONDS))
        printf '… still running (%dm%02ds elapsed) — no new log output for %ds, possible stall\n' \
          $((el / 60)) $((el % 60)) "$stale" >&2
      else
        stale=0
        printf '… still running (%dm%02ds elapsed, %s log lines)\n' \
          $((el / 60)) $((el % 60)) "$ln" >&2
      fi
      prev=$ln
    done
  ) &
  HB_PID=$!
  # Make sure the heartbeat never outlives this script (Ctrl-C, error, exit).
  trap '[[ -n "$HB_PID" ]] && kill "$HB_PID" 2>/dev/null' EXIT INT TERM
fi

# Run the command, tee every line to the log, filter to stdout.
"$@" 2>&1 | tee "$LOG" | grep -E --line-buffered "$FILTER"
CODE=${PIPESTATUS[0]}

# Stop the heartbeat now that the command has finished.
if [[ -n "$HB_PID" ]]; then
  kill "$HB_PID" 2>/dev/null
  wait "$HB_PID" 2>/dev/null
  HB_PID=""
fi

SIZE=$(wc -c <"$LOG" | tr -d ' ')
LINES=$(wc -l <"$LOG" | tr -d ' ')

echo
echo "=== run-logged summary ==="
echo "exit code : $CODE"
echo "log file  : $LOG ($SIZE bytes, $LINES lines)"
echo "--- last 40 lines ---"
tail -n 40 "$LOG"

exit "$CODE"
