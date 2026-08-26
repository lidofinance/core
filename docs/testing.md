# Testing landscape

How and where the tests run in this repo. The protocol is tested at several
"layers" — from single-contract unit tests to whole-protocol scenarios against a
fork of mainnet — and which layer you get depends on a small set of environment
variables. This document maps the whole space so you can pick the right command.

For the deploy pipeline these tests exercise, see
[scratch-deploy.md](./scratch-deploy.md). For why integration tests behave
differently on an external node (anvil) vs the in-process hardhat node, see
[external-node-test-compat.md](./external-node-test-compat.md).

## TL;DR

```shell
# Contract unit tests (no RPC, no deploy)
yarn test                      # TypeScript unit tests (test/**/*.test.ts)
yarn test:forge                # Solidity unit tests (Foundry)

# Whole-protocol integration tests (test/integration/**)
yarn test:integration:scratch  # deploy the protocol in-process, then test it
yarn test:integration          # fork a real chain + read an existing deployment
                               #   needs RPC_URL + NETWORK_STATE_FILE
yarn test:integration:fork:local  # drive an external node on :8555 directly
```

## The three axes

Every run is the combination of three independent choices.

### 1. Test kind — _what_ is tested

| Kind                   | Location                                       | Count | Runner                                     |
| ---------------------- | ---------------------------------------------- | ----- | ------------------------------------------ |
| TypeScript unit        | `test/**/*.test.ts` (excl. `test/integration`) | ~127  | hardhat + mocha, per-contract **fixtures** |
| Solidity unit          | `test/**/*.t.sol`                              | —     | Foundry (`forge test`)                     |
| TypeScript integration | `test/integration/**/*.ts`                     | ~66   | hardhat + mocha, **whole protocol**        |

Unit tests deploy individual contracts via fixtures; they never stand up the
whole protocol. Integration tests need a _complete, operational_ Lido
deployment — that is where `MODE` and `--network` come in.

### 2. `MODE` — _how_ the protocol comes to exist

Read in `hardhat.helpers.ts` (`getMode()`, default `scratch`) and acted on in
`lib/protocol/context.ts` (`getProtocolContext`).

| `MODE`                | Behavior                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scratch` _(default)_ | **Re-deploy the whole protocol in-process now**, then provision it (oracle committee, hash-consensus initial epoch, unpause, seed TVL). No `RPC_URL` needed.                                                |
| `forking`             | **Do not deploy.** Fork `RPC_URL` and **discover an existing deployment** from `NETWORK_STATE_FILE` (`deployed-*.json`). Throws if `RPC_URL` is unset. Optional `FORKING_BLOCK_NUMBER` pins the fork block. |

A related flag, `isScratch` (`context.ts`), tells tests which privileged signer
to use: a scratch deployment still has the **Agent** holding powers and no
EasyTrack, whereas a real testnet/mainnet deployment uses the **EasyTrack**
path. `isScratch` is true for `MODE=scratch` and for `PROVISION_ON_FORK=1`
(forking a _local scratch_ deploy); false for a plain real-chain fork.

### 3. `--network` — _where_ the EVM runs

Networks are defined in `hardhat.config.ts`.

| `--network`                     | EVM location                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_ → `hardhat`            | **In-process EDR node**, inside the test process. If `MODE=forking`, _this_ node does the forking.                                       |
| `local`                         | An **external node you started** (`url = LOCAL_RPC_URL \|\| RPC_URL`, e.g. anvil or a hardhat node on `:8555`). Tests drive it directly. |
| `sepolia` / `hoodi` / `mainnet` | A **real remote chain** — used by deploy scripts that send real transactions, not by the test suite.                                     |

## The commands

All from `package.json`. `*:trace` / `*:fulltrace` add `hardhat-tracer`; `*:agent`
wrap the command in `scripts/run-logged.sh` for file logging. They are omitted
below.

| Command                            | Kind                 | MODE / network                     | EVM                             | Deployment under test                      |
| ---------------------------------- | -------------------- | ---------------------------------- | ------------------------------- | ------------------------------------------ |
| `yarn test`                        | TS unit              | default / `hardhat`, no fork       | in-process                      | per-test fixtures                          |
| `yarn test:forge`                  | Solidity unit        | — (Foundry EVM)                    | forge                           | Solidity fixtures                          |
| `yarn test:coverage`               | TS unit + coverage   | `COVERAGE=unit`                    | in-process                      | fixtures                                   |
| `yarn test:integration:scratch`    | TS integration       | `MODE=scratch` / `hardhat`         | in-process                      | **deployed in-process now**                |
| `yarn test:integration`            | TS integration       | `MODE=forking` / `hardhat`         | in-process, **forks `RPC_URL`** | read from `NETWORK_STATE_FILE`             |
| `yarn test:integration:fork:local` | TS integration       | `MODE=scratch` + `--network local` | **external node** (`:8555`)     | scratch-deployed **on that node**, in-test |
| `yarn test:integration:upgrade`    | TS integration       | `MODE=forking` + `UPGRADE=1`       | in-process fork                 | state file, then runs upgrade steps        |
| `yarn test:fork:pdg-validator`     | one integration file | `MODE=forking`                     | in-process fork                 | state file                                 |

## The four "where does the chain come from" scenarios

This is the part that trips people up. Integration tests can sit on top of four
distinct chain topologies.

### A. In-process scratch — `test:integration:scratch`

```
[ test process = EVM ]  ← deploys the whole protocol fresh, every run
```

`MODE=scratch`, no `--network`. Self-contained — no external node, no RPC — **but
it cannot deploy Dual Governance**. DG's deploy step (`0160`) shells out to
`forge … --rpc-url --broadcast`, a separate process that needs a reachable HTTP
RPC; the in-process node exposes none. So the `test:integration:scratch` command
sets `DG_DEPLOYMENT_ENABLED=false` for you (the deploy would otherwise throw at
0160, or with a dotenv `RPC_URL` set try to broadcast DG to that _other_ chain).
To exercise a scratch deploy **with** DG, use scenario **C**
(`test:integration:fork:local`) against an external node. Slowest startup (it
redeploys everything) but hermetic and reproducible.

### B. Fork of a real chain — `test:integration`

```
[ test process: EDR ] --forks--> [ real mainnet / hoodi RPC ]
                       reads deployment from deployed-mainnet.json
```

`MODE=forking`, `RPC_URL` = a real archive RPC, `NETWORK_STATE_FILE` = the
matching artifact. One fork, of a real chain. Real-chain RPCs return valid
block headers, so there are no fork-mechanics surprises. This is what the
mainnet and hoodi CI jobs do.

### C. Live external node, driven directly — `test:integration:fork:local`

```
[ test process ] --RPC--> [ external node on :8555 ]  (which itself forks Sepolia)
                          one chain; tests talk to it directly
```

`MODE=scratch` + `--network local`. The external node may itself be a fork of
Sepolia, but the **tests do not fork it** — they connect directly, so there is a
single chain and snapshots/`evm_revert` happen on that one node. This is what the
**scratch CI** does (see below), and the recommended way to test a from-scratch
deploy on a hardhat-node-backed Sepolia fork.

### D. Fork-of-a-fork — `test:integration` against a local node ⚠️

```
[ test process: EDR ] --forks--> [ local node :8555 ] --forks--> [ Sepolia RPC ]
```

`MODE=forking` with `RPC_URL` pointing at a **local** node. The in-process EDR
node forks the local node, which itself forks Sepolia (used by
`scripts/dao-sepolia-fork-deploy.sh`). This **works on anvil but breaks on a
plain hardhat node**: during `evm_revert` EDR fetches the backend's _pending_
block, and a hardhat node returns `nonce: null` there, which EDR rejects
(`InvalidArgumentsError: invalid type: null, expected a 8 byte hex string`).
anvil normalizes the nonce to zero, so it is fine. For a hardhat-node backend,
prefer scenario **C**. See
[external-node-test-compat.md](./external-node-test-compat.md).

## What CI runs

| Workflow                        | Scenario | Backend / RPC                                                                   | Command                            |
| ------------------------------- | -------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `tests-unit.yml`                | unit     | in-process                                                                      | `yarn test`                        |
| `tests-integration-mainnet.yml` | **B**    | forks real mainnet (`ETH_RPC_URL` secret) + `deployed-mainnet.json`             | `yarn test:integration`            |
| `tests-integration-hoodi.yml`   | **B**    | forks real Hoodi, pinned `FORKING_BLOCK_NUMBER`, `deployed-hoodi.json`          | `yarn test:integration`            |
| `tests-integration-scratch.yml` | **C**    | `ghcr.io/lidofinance/hardhat-node` service on `:8555` → `dao-deploy.sh` → tests | `yarn test:integration:fork:local` |
| `coverage.yml`                  | coverage | in-process                                                                      | `yarn test:coverage*`              |

The scratch workflow runs four variants: with/without Dual Governance, on a blank
node and on a Sepolia fork. The Sepolia-fork variant exercises step `0010`'s
`SepoliaDepositAdapter` branch (chainId `11155111`).

## Cross-cutting knobs

| Variable                                                                                  | Effect                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `NODE_OPTIONS=--max-old-space-size=<MB>`                                                  | The process holding the EVM is memory-hungry. CI uses ~7200 MB for forks; a local fork-of-fork (D) needs substantially more. |
| `RPC_URL`                                                                                 | The fork source for `MODE=forking`; also the `local` network fallback URL.                                                   |
| `FORKING_BLOCK_NUMBER`                                                                    | Pin the fork to a specific block (e.g. pre-upgrade state).                                                                   |
| `NETWORK_STATE_FILE`                                                                      | Which deployment artifact (`deployed-*.json`) to discover contracts from.                                                    |
| `PROVISION_ON_FORK=1`                                                                     | Provision a forked local scratch deploy (makes it operational + sets `isScratch`).                                           |
| `INTEGRATION_WITH_CSM=off`                                                                | Skip CSM-dependent integration assertions.                                                                                   |
| `DEPLOYER`, `GAS_PRIORITY_FEE`, `GAS_MAX_FEE`, `GENESIS_TIME`, `GENESIS_FORK_VERSION`     | Scratch-deploy parameters; required when `MODE=scratch` re-deploys in-test.                                                  |
| `DG_ALLOW_DEV_COMMITTEES=1`                                                               | Allow anvil dev addresses as Dual Governance committees on a non-local chainId (forks only).                                 |
| `SKIP_GAS_REPORT` / `SKIP_CONTRACT_SIZE` / `SKIP_INTERFACES_CHECK` / `SKIP_LINT_SOLIDITY` | Quiet the compile/test extras.                                                                                               |

## Rules of thumb

- **Testing a single contract?** → `yarn test` or `yarn test:forge`. No RPC, no deploy.
- **Testing protocol behavior with no infrastructure?** → `yarn test:integration:scratch` (A). It forces `DG_DEPLOYMENT_ENABLED=false`, since in-process scratch can't deploy Dual Governance (DG needs an external RPC for `forge`); to cover scratch **with** DG use (C).
- **Testing against mainnet/hoodi state?** → `yarn test:integration` with `RPC_URL` = a real archive RPC and the matching `deployed-*.json` (B).
- **Testing a from-scratch deploy on a Sepolia fork?** → start a node on `:8555`, run `dao-deploy.sh`, then `yarn test:integration:fork:local` (C). Only use the `MODE=forking` fork-of-fork (D) if that node is **anvil**.
