# Scratch deployment on Panda Gloas

This checkout is based on Lido core PR 1940, commit
`2f4a21d0ba89826087ef328ecf9fbdf0775f8e44`.

From this core checkout, install dependencies (`HUSKY=0 yarn install --immutable`), then run:

```sh
PANDA_ROOT=/path/to/panda yarn test:integration:panda --bail
```

This optional local mode requires Deno 2.9.7 on `PATH` and an existing compatible Panda bake.
The HTTP service mode below needs neither Deno nor a Panda checkout on the core test runner.

To use a running Panda service, set `PANDA_URL=http://127.0.0.1:18547` instead of `PANDA_ROOT`:

```sh
PANDA_URL=http://127.0.0.1:18547 PANDA_BEACON_URL=http://127.0.0.1:5052 \
  yarn test:integration:panda --bail
```

The service must expose a fresh Gloas chain (block 0, slot 0, automine off). The client connects over
HTTP and leaves the externally owned service running when the suite ends. Validator import and
voluntary exits use Panda's `/control` API; keymanager credentials stay inside Panda.

The **Integration Tests Panda** workflow runs on every push with
`ghcr.io/lidofinance/panda-gloas:latest`, following the latest successful stable Panda publication.
If that tag does not exist yet, it selects `ghcr.io/lidofinance/panda-gloas:v0.1.0`. The selected image
is recorded in the workflow summary; authentication or network errors fail the job.
A published version tag or image digest from the same repository can be supplied through the manual
workflow's `image` input. It starts the image as a privileged service
with its own Docker daemon and binds RPC `127.0.0.1:18547:8545`, Beacon `127.0.0.1:5052:5052`
and validator API `127.0.0.1:5062:5062`. Deno and the Panda
runtime are contained in the image. The workflow uses the command above; scratch deployment remains
inside the existing suite. Private packages require `PANDA_REGISTRY_TOKEN` with package read access
unless this repository's `GITHUB_TOKEN` already has access.

The Hardhat suite uses one fresh Panda network and invokes the ordinary `yarn deploy:scratch`
command through the TypeScript [deployment helper](../test/integration/panda/helpers/deploy.ts).
The helper enables transaction-driven mining, waits for Geth indexer readiness, and records wall
time, migration steps and output under `.local/panda/core-<id>/`. Each run has its own
`deployment.json`. The suite then checks the four core verifiers. Local mode starts and stops its
own Panda process; service mode leaves lifecycle management to Docker/CI.
See the [suite documentation](../test/integration/panda/README.md) for prerequisites and coverage.
Local startup defaults to `gloas:panda`; `PANDA_BAKE` selects another compatible tag. In service mode,
`PANDA_BAKE` optionally asserts that the running service uses that exact bake tag.
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
- On Panda, module activation is encoded into one genuine DAO vote. The configured LDO holder creates the
  vote through TokenManager, votes, and executes it through Voting and Agent. There is no account
  impersonation or direct balance/code overwrite on that path. Ordinary Hardhat/Anvil scratch
  deployment keeps its Agent impersonation setup.
- The vote helper emits `scratch-vote-wait`. The TypeScript helper advances complete slots through the
  ordinary control API, preserving the original voting duration and validator duties. With an
  ordinary progressing chain the helper waits naturally, with a bounded wall-clock deadline.
- External HashConsensus activation derives its far-future sentinel from the contract's actual
  genesis time and slot parameters. The former constant silently left both external oracles
  inactive on this network; the real-chain acceptance caught this before the final fresh run.

## Validation

Run the standard repository checks:

```sh
yarn check
```

The Panda integration uses the existing Hardhat/Mocha command above and
[verifiers.integration.ts](../test/integration/panda/verifiers.integration.ts). Its current
coverage and limitations are documented in the [suite README](../test/integration/panda/README.md).

This is the upstream scratch scope: EasyTrack is still its upstream `EasyTrackEVMScriptExecutorStub`.

For a new measurement, rerun the Hardhat command above. Each run starts a fresh chain and stores
its own artifacts; source/build caches may be reused.

## Original pilot evidence

The original pilot checked all 21 migration steps, transaction receipts, deployed bytecode,
four registered staking modules, active external modules/consensus, circuit breaker permissions,
final DAO admin ownership with deployer rights revoked, and an executed DAO vote. These historical
acceptance results are separate from the current verifier suite's coverage.

The original pilot's verified fresh-chain run completed all 21 steps in **263.27 seconds** with cached dependencies
and compiler artifacts: 514 successful transactions, no failed receipts, and all six acceptance
groups passing. Network startup (10.69 seconds) and initial indexer warmup (0.40 seconds) are outside
that timer. The vote's 24 complete slots took 8.91 seconds inside the deployment timer.
