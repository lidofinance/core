# Scratch deployment + integration tests across environments.
#
# Each "node" recipe runs `test:integration:fork:local` (MODE=scratch + --network
# local) against a durable RPC node: it deploys every step onto the node AND tests
# the node directly (evm_snapshot/revert on that one node — scenario C in
# docs/testing.md). It does NOT have EDR fork the node (MODE=forking): when the node
# is itself a fork of a remote, EDR's fork-init wedges it mid-run.
#
# Deploy target is chosen automatically (see _deploy-and-test):
#   - blank recipes            → a fresh anvil started on $ANVIL_PORT (torn down on exit)
#   - $RPC_* is a LOCAL node   → deploy straight to it (it is already a fork node)
#   - $RPC_* is a REMOTE RPC    → fork it into a throwaway anvil first, so we never
#                                deploy onto the real chain
# A node target is MUTATED by the deploy (a full scratch protocol lands on it), which
# suits disposable forks (e.g. AnvilForksTray, or `anvil --fork-url <archive>`).
#
# Dual Governance: a "*-dg" recipe deploys DG (forge --broadcast against the target);
# a "*-no-dg" recipe sets DG_DEPLOYMENT_ENABLED=false. The in-process `scratch`
# recipe cannot deploy DG at all (no external RPC for forge), so it is DG-off only
# — use `scratch-node-dg` for a from-scratch deploy *with* DG on a blank node.
# See docs/scratch-deploy.md and docs/testing.md.
#
# Prereqs: foundry (anvil + forge) on PATH; the DG submodule initialised
# (`git submodule update --init --recursive`) for the *-dg recipes; and
# $RPC_ETHEREUM / $RPC_SEPOLIA pointing at a disposable fork node (or archive RPC)
# for the fork recipes.
#
# Output: like the dao-*-deploy.sh scripts, the deploy + test run is routed through
# scripts/run-logged.sh — full output goes to a per-recipe log under logs/, while
# only milestones / mocha counts / failures + a heartbeat reach the terminal. Pass
# FULL_OUTPUT=1 for the raw firehose, LOG_FILE=path to override the log location,
# HEARTBEAT_SECONDS=0 to silence the heartbeat.

set dotenv-load := false

# Applied to every recipe's environment: skip the slow/strict extras (gas report,
# contract-size, interface check) and let anvil dev accounts act as DG committees
# on local/fork chains. dotenv (`import "dotenv/config"`) is non-override, so these
# win over any .env values.
export SKIP_GAS_REPORT := "true"
export SKIP_CONTRACT_SIZE := "true"
export SKIP_INTERFACES_CHECK := "true"
export DG_ALLOW_DEV_COMMITTEES := "1"

anvil_port := env_var_or_default("ANVIL_PORT", "8555")
deployer := "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"  # anvil account #0 (default mnemonic)

# Show the available recipes.
default:
    @just --list

# ── in-process scratch (no external node) ────────────────────────────────────

# In-process deploy + test (fastest). DG-off only — in-process can't deploy DG.
scratch:
    @just _run "{{ env_var_or_default('LOG_FILE', 'logs/just-scratch.log') }}" yarn test:integration:scratch

# ── blank external anvil ─────────────────────────────────────────────────────

# Scratch deploy WITH Dual Governance on a blank anvil node.
scratch-node-dg:
    @just _deploy-and-test blank true

# Scratch deploy WITHOUT Dual Governance on a blank anvil node.
scratch-node-no-dg:
    @just _deploy-and-test blank false

# ── mainnet fork ($RPC_ETHEREUM) ─────────────────────────────────────────────

# Scratch deploy WITH Dual Governance on an anvil fork of mainnet.
mainnet-fork-dg:
    @just _deploy-and-test mainnet true

# Scratch deploy WITHOUT Dual Governance on an anvil fork of mainnet.
mainnet-fork-no-dg:
    @just _deploy-and-test mainnet false

# ── sepolia fork ($RPC_SEPOLIA) ──────────────────────────────────────────────
# chainId 11155111 makes step 0010 deploy SepoliaDepositAdapter over Sepolia's
# real beacon deposit contract.

# Scratch deploy WITH Dual Governance on an anvil fork of sepolia.
sepolia-fork-dg:
    @just _deploy-and-test sepolia true

# Scratch deploy WITHOUT Dual Governance on an anvil fork of sepolia.
sepolia-fork-no-dg:
    @just _deploy-and-test sepolia false

# Run the whole matrix sequentially (long; fork recipes need the RPC env vars).
all: scratch scratch-node-no-dg scratch-node-dg mainnet-fork-no-dg mainnet-fork-dg sepolia-fork-no-dg sepolia-fork-dg

# ── engine ───────────────────────────────────────────────────────────────────
# env ∈ {blank, mainnet, sepolia};  dg ∈ {true, false}
_deploy-and-test env dg:
    #!/usr/bin/env bash
    set -euo pipefail

    env="{{env}}"
    dg_enabled="{{dg}}"
    port="{{anvil_port}}"

    rpc_probe() { curl -fsS -o /dev/null --max-time "${2:-2}" -X POST "$1" \
      -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null; }

    # Per-environment chain spec (genesis time / fork version) and fork source.
    case "$env" in
      blank)   src="";                                 genesis_time=1639659600; genesis_fork_version=0x00000000 ;;
      mainnet) src="${RPC_ETHEREUM:?set RPC_ETHEREUM}"; genesis_time=1606824023; genesis_fork_version=0x00000000 ;;
      sepolia) src="${RPC_SEPOLIA:?set RPC_SEPOLIA}";   genesis_time=1655733600; genesis_fork_version=0x90000069 ;;
      *)       echo "unknown env '$env' (want blank|mainnet|sepolia)" >&2; exit 1 ;;
    esac

    # Decide the deploy target. We must NOT stack an anvil on top of another local
    # node: EDR-forks-anvil-forks-anvil wedges the middle node mid-suite. So:
    #   - blank             → start a fresh anvil (no fork)
    #   - local node source → deploy straight to it (it is already a fork node)
    #   - remote RPC source → fork it into a throwaway anvil, so we never deploy to
    #                         the real chain and EDR only ever forks one anvil
    manage_anvil=0
    if [[ -z "$src" ]]; then
      manage_anvil=1; fork_args=(); rpc="http://127.0.0.1:${port}"; label="blank anvil on :$port"
    elif [[ "$src" =~ ^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|/|$) ]]; then
      rpc="$src"; label="existing local node $src (deploy mutates it)"
    else
      manage_anvil=1; fork_args=(--fork-url "$src"); rpc="http://127.0.0.1:${port}"; label="anvil on :$port forking $src"
    fi
    echo ">>> $label  —  Dual Governance: $dg_enabled"

    if [[ "$manage_anvil" == 1 ]]; then
      # Refuse to clobber whatever is already on the port.
      if rpc_probe "$rpc"; then
        echo "Something is already listening on $rpc — stop it first (or set ANVIL_PORT)." >&2; exit 1
      fi
      # foundry's default mnemonic → account #0 is the canonical deployer; zero fees keep it cheap.
      log="$(mktemp -t anvil-${port}.XXXXXX.log)"
      # ${arr[@]+...} guard: expanding an empty array under `set -u` errors on bash 3.2 (macOS).
      anvil ${fork_args[@]+"${fork_args[@]}"} \
        --port "$port" \
        --mnemonic "test test test test test test test test test test test junk" \
        --base-fee 0 --gas-price 0 >"$log" 2>&1 &
      anvil_pid=$!
      trap 'kill "$anvil_pid" 2>/dev/null || true' EXIT
      # Wait for anvil's "Listening on" banner in its log (appears the instant the RPC
      # server binds — no HTTP-poll spin), then one probe to confirm it actually answers
      # (a forking anvil may need a moment after binding to serve its first call).
      for i in $(seq 1 480); do
        grep -q "Listening on" "$log" 2>/dev/null && break
        if ! kill -0 "$anvil_pid" 2>/dev/null; then echo "anvil exited early:" >&2; cat "$log" >&2; exit 1; fi
        if [[ "$i" == 480 ]]; then echo "anvil never started:" >&2; cat "$log" >&2; exit 1; fi
        sleep 0.25
      done
      rpc_probe "$rpc" 30 || { echo "anvil bound but RPC not answering:" >&2; cat "$log" >&2; exit 1; }
    else
      # Using a node we did not start: just confirm it answers.
      rpc_probe "$rpc" 5 || { echo "Node at $rpc is not responding." >&2; exit 1; }
    fi

    # ---- deploy + test directly on the node (scenario C: MODE=scratch + --network local) ----
    # `test:integration:fork:local` runs every deploy step against the node — incl.
    # DG, since the `local` network has a url so 0160's `forge --broadcast` can target
    # it — and then tests the node DIRECTLY (evm_snapshot/revert on that one node).
    #
    # We deliberately do NOT use MODE=forking (EDR forking the node). When the node is
    # itself a fork of a remote (anvil --fork-url, AnvilForksTray, …), EDR's fork-init
    # WEDGES it mid-run. Driving it directly avoids the second fork entirely. This is
    # exactly what the scratch CI does — see docs/testing.md scenario C.
    export LOCAL_RPC_URL="$rpc"   # hardhat `local` network url (deploy + test target)
    export RPC_URL="$rpc"         # fallback url + forge broadcast target for DG
    export NETWORK_STATE_FILE="deployed-local.json"
    export SCRATCH_DEPLOY_CONFIG="scripts/scratch/deploy-params-testnet.toml"
    export DEPLOYER="{{deployer}}"
    export GENESIS_TIME="$genesis_time"
    export GENESIS_FORK_VERSION="$genesis_fork_version"
    export GAS_PRIORITY_FEE=1
    export GAS_MAX_FEE=100
    export DG_DEPLOYMENT_ENABLED="$dg_enabled"
    export INTEGRATION_WITH_CSM=off
    # SKIP_GAS_REPORT / SKIP_CONTRACT_SIZE / SKIP_INTERFACES_CHECK / DG_ALLOW_DEV_COMMITTEES
    # come from the top-level `export` assignments.

    # Route deploy+test through the _run wrapper (quiet terminal + full log + heartbeat,
    # like dao-*-deploy.sh). FULL_OUTPUT=1 bypasses it; LOG_FILE overrides the path.
    dg_word=no-dg; [[ "$dg_enabled" == true ]] && dg_word=dg
    just _run "${LOG_FILE:-logs/just-${env}-${dg_word}.log}" yarn test:integration:fork:local

# Run a command with full output to <logfile> via run-logged.sh (quiet terminal +
# heartbeat), like dao-*-deploy.sh. FULL_OUTPUT=1 streams the raw output instead.
_run logfile +cmd:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -n "${FULL_OUTPUT:-}" ]]; then
      {{cmd}}
    else
      echo ">>> logging to {{logfile}} (FULL_OUTPUT=1 for raw output)"
      bash scripts/run-logged.sh "{{logfile}}" {{cmd}}
    fi
