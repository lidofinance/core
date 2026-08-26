# External-node test compatibility (anvil vs hardhat node)

The integration suite can run against an **external** node (scenario C/D in
[testing.md](./testing.md)) — typically a node forking Sepolia on `:8555`, used
by `scripts/dao-sepolia-fork-deploy.sh` and the scratch CI. The two common
external nodes — **anvil** (Foundry) and **hardhat node** — are _not_
interchangeable here. This page explains where they differ and how to run the
suite so it passes on either.

## The one rule

> **Do not fork an external hardhat node from the in-process test node.**
> Drive it directly with `--network local` instead.

Concretely: for a hardhat-node backend, use

```shell
yarn test:integration:fork:local      # MODE=scratch + --network local  (scenario C)
```

not

```shell
yarn test:integration                 # MODE=forking, in-process fork    (scenario D)
```

Scenario D (the in-process EDR node _forking_ the external node — a "fork of a
fork") works on anvil but breaks on a hardhat node. Scenario C talks to the node
directly, so there is no second fork and the problem disappears.

## Why the fork-of-fork breaks on a hardhat node

When the in-process EDR node forks a backend and later runs `evm_revert`
(snapshot restore, used to isolate test files — see `test/suite/snapshot.ts`),
EDR re-reads the backend's **pending** block. EDR's header deserializer requires
an 8-byte `nonce`:

- A **hardhat node** returns `"nonce": null` (also `number`/`mixHash` null) for
  the pending block. EDR rejects it:

  ```
  InvalidArgumentsError: invalid type: null, expected a 8 byte hex string
  ```

  Snapshot isolation then collapses, and state leaks across files (cascading
  `DuplicateMember()` and similar). Result: the whole suite fails.

- **anvil** normalizes the pending block's nonce to `0x00…00`, so EDR is happy.

Pinning `FORKING_BLOCK_NUMBER` does **not** help — EDR still queries the pending
block at revert time.

### Escape hatch if you must fork-of-fork

The custom node image `ghcr.io/lidofinance/hardhat-node` (source:
`lido/hardhat-node`) exposes `DONT_SET_CHAIN_ID=1`, which omits the chainId from
the forked node's config. This fixes a _related_ fork-of-fork failure
(`header not found`). It is **not** needed for the `--network local` path, where
the node keeps its real chainId (e.g. `11155111`). A `mine()` root hook in
`test/hooks/index.ts` covers another fork-of-fork issue ("No known hardfork for
execution on historical block").

## Other external-node gotchas

### Deploy: post-forge `ECONNRESET` at step 0160

The Dual Governance step (`scripts/scratch/steps/0160-deploy-dual-governance.ts`)
shells out to `forge` via a blocking `spawnSync` (30–60 s). A hardhat node closes
the idle keep-alive RPC socket during that window, so the first reused request
afterward throws `read ECONNRESET`, killing the deploy at 0160. The step now
calls `reEstablishRpcAfterForge()` — a retried probe that drops the stale socket
before the post-forge transactions. anvil keeps the socket alive, so this is a
no-op there.

If a deploy ever dies at 0160 before this guard ran, the forge output is already
persisted to the state file (`dg:adminExecutor`, `resealManager`), so re-running
**only** step 0160 against the live node skips forge (idempotency guard) and
completes the wiring — without wiping state (i.e. not via `dao-deploy.sh`, which
does `rm -f $NETWORK_STATE_FILE`).

### chainId on a hardhat fork

A hardhat node does **not** inherit the forked chain's chainId (defaults to
`31337`) and `hardhat node` has no `--chainId` flag. Use the env-driven config:

```shell
MODE=forking RPC_URL=<sepolia-rpc> HARDHAT_CHAIN_ID=11155111 yarn hardhat node --port 8555
```

anvil preserves `11155111` from the fork automatically.

### Memory and upstream RPC stability

- The process holding the EVM is memory-hungry. A plain `yarn hardhat node`
  backing the scratch suite OOM'd at an 8 GB heap; give it more
  (`NODE_OPTIONS=--max-old-space-size=…`). CI uses the Docker image, which is
  sized appropriately.
- The fork's upstream RPC must be stable for a long run. A flaky provider can
  drop the fork-backend connection mid-suite (observed: the socket stuck in
  `CLOSE_WAIT`, wedging the node entirely). Use a reliable archive endpoint.

## Quick reference

| Backend on `:8555` | `test:integration:fork:local` (C, direct) | `test:integration` fork-of-fork (D) |
| ------------------ | ----------------------------------------- | ----------------------------------- |
| **anvil**          | ✅                                        | ✅                                  |
| **hardhat node**   | ✅ (needs large heap)                     | ❌ pending-block null nonce         |
