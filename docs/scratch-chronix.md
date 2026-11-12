# Scratch deployment on Chronix Gloas

This checkout is based on Lido core PR 1940, commit
`2f4a21d0ba89826087ef328ecf9fbdf0775f8e44`.

From this core checkout, install dependencies (`HUSKY=0 yarn install --immutable`). Start a Chronix
service as the [suite documentation](../test/integration/chronix/README.md) shows, then run:

```sh
CHRONIX_URL=http://127.0.0.1:18547 yarn test:integration:chronix --bail
```

The service must expose a fresh Gloas chain (block 0, slot 0, automine off). The suite connects to it
through the Chronix SDK, `@lidofinance/chronix-client`, and leaves the externally owned service
running when it ends. Validator import uses Chronix's control API; keymanager
credentials stay inside Chronix. The test runner needs neither Deno nor a Chronix checkout.

The suite is separate from the other integration tests: `yarn test:integration` and the other
integration workflows run only `*.integration.ts` files, and this suite is `verifiers.devnet.ts`.

The **Integration Tests Chronix** workflow runs only when started manually (`workflow_dispatch`), not
on push. By default it uses `ghcr.io/lidofinance/chronix-gloas:latest`, following the latest successful
stable Chronix publication. If that tag does not exist, the job fails. The selected image is recorded
in the workflow summary; authentication or network errors also fail the job.
A published version tag or image digest from the same repository can be supplied through the
workflow's `image` input. It starts the image as a privileged service
with its own Docker daemon and binds the controller to `127.0.0.1:18547:8545`. Deno and the Chronix
runtime are contained in the image. The workflow uses the command above; scratch deployment remains
inside the existing suite. The workflow pulls the image with this repository's `GITHUB_TOKEN`
(`packages: read`).

The Hardhat suite uses one fresh Chronix network and invokes the ordinary `yarn deploy:scratch`
command through the TypeScript [deployment helper](../test/integration/chronix/helpers/deploy.ts).
The helper enables transaction-driven mining, waits for Geth indexer readiness, and records wall
time, migration steps and output under `.local/chronix/core-<id>/`. Each run has its own
`deployment.json`. The suite then checks the three core verifiers. Docker or CI owns the service
lifecycle. See the [suite documentation](../test/integration/chronix/README.md) for prerequisites
and coverage.
The standard public Hardhat development key is used only against this local Gloas network.

The supplied scratch TOML keeps the original token allocations and vote durations, but assigns
the local deployer the largest LDO allocation and sets the three Gloas activation slots to zero.
Genesis time, fork version and deposit contract address match the existing Gloas bake.

## Changes

- The shell helper respects the configured genesis time and defaults to RPC gas estimation.
- CircuitBreaker, EDF, CSM and CMv2 use Foundry RPC estimation (`--skip-simulation`) with sequential
  receipt-confirmed broadcasting. Contract source is unchanged.
- External sources use fixed commits and retain dependencies/compiler artifacts under
  `.cache/external-deploy/`. `EXTERNAL_DEPLOY_CACHE` can override this directory. Source revision
  and tracked-file cleanliness are checked before use.
- On Chronix, module activation is encoded into one genuine DAO vote. The configured LDO holder creates the
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

The Chronix integration uses the existing Hardhat/Mocha command above and
[verifiers.devnet.ts](../test/integration/chronix/verifiers.devnet.ts). Its current
coverage and limitations are documented in the [suite README](../test/integration/chronix/README.md).

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
