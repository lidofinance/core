# Scratch deployment on zap-net Gloas

This checkout is based on Lido core PR 1940, commit
`2f4a21d0ba89826087ef328ecf9fbdf0775f8e44`. No commits are created by this pilot.

Start a fresh network from the zap-net repository (separate terminal):

```sh
ZAP_ID=lido1940fix ZAP_PORT=18546 ./scripts/deno task up --profile gloas --bake stable
```

From this core checkout, install dependencies (`HUSKY=0 yarn install --immutable`), then run:

```sh
python3 scripts/run-scratch-zapnet.py
RPC_URL=http://127.0.0.1:18546 node scripts/tests/scratch-acceptance.cjs
```

The runner requires genesis state and no existing `deployed-local-devnet.json`. It enables
transaction-driven mining, produces one empty block for Geth indexer readiness, and invokes the
ordinary `yarn deploy:scratch` command. It records wall time, migration steps and output under
`.local/zapnet/<PILOT_RUN>/` (default `run1`). `ZAP_RPC_URL` and `ZAP_ID` override the endpoint/id.
The standard public Hardhat development key is used only against this local Gloas network.

The supplied scratch TOML keeps the original token allocations and vote durations, but assigns
the local deployer the largest LDO allocation and sets the four Gloas activation slots to zero.
Genesis time, fork version and deposit contract address match the existing Gloas bake.

## Changes

- The shell helper respects the configured genesis time and defaults to RPC gas estimation.
- CircuitBreaker, EDF, CSM and CMv2 use Foundry RPC estimation (`--skip-simulation`) with sequential
  receipt-confirmed broadcasting. Contract source is unchanged.
- External sources use fixed commits and retain dependencies/compiler artifacts under
  `.cache/external-deploy/`. `EXTERNAL_DEPLOY_CACHE` can override this directory. Source revision
  and tracked-file cleanliness are checked before use.
- Module activation is encoded into one genuine DAO vote. The configured LDO holder creates the
  vote through TokenManager, votes, and executes it through Voting and Agent. There is no account
  impersonation or direct balance/code overwrite.
- The vote helper emits `scratch-vote-wait`. The zap-net runner advances complete slots through the
  ordinary control API, preserving the original voting duration and validator duties. With an
  ordinary progressing chain the helper waits naturally, with a bounded wall-clock deadline.
- External HashConsensus activation derives its far-future sentinel from the contract's actual
  genesis time and slot parameters. The former constant silently left both external oracles
  inactive on this network; the real-chain acceptance caught this before the final fresh run.

## Acceptance

Before changes, the environment regression fails because genesis is overwritten and 16M gas is
forced. The real-chain acceptance fails on the original partial deployment because external
packages, modules, final handoff and the governance vote are missing. Red logs are preserved with
this pilot's report.

```sh
node --test scripts/tests/migration-env.test.cjs
yarn typecheck
```

A successful deployment requires all 21 migration steps, no failed transaction receipts, deployed
bytecode, four registered staking modules, active external modules/consensus, circuit breaker
permissions, final DAO admin ownership with deployer rights revoked, and an executed DAO vote.
The acceptance command reads the actual Geth state and does not run repository test fixtures.

This is the upstream scratch scope: EasyTrack is still its upstream `EasyTrackEVMScriptExecutorStub`.
Protocol operation tests (deposits, oracle reports, withdrawals, and Gloas proofs) are separate work.

For a new measurement, archive the previous deployment artifact, stop only `lido1940fix`, and start
a fresh network with the same id/profile/bake. Source/build cache may be reused; chain state must
be new. `PILOT_RUN=run2` selects another log directory. No Docker prune is used.

The verified fresh-chain run completed all 21 steps in **263.27 seconds** with cached dependencies
and compiler artifacts: 514 successful transactions, no failed receipts, and all six acceptance
groups passing. Network startup (10.69 seconds) and initial indexer warmup (0.40 seconds) are outside
that timer. The vote's 24 complete slots took 8.91 seconds inside the deployment timer.
