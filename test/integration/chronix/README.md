# Core verifiers on Chronix

One Hardhat/Mocha suite connects to **one running Chronix service**, performs **one scratch
deployment**, then checks the three core verifiers in order. The suite talks to Chronix only through
its SDK, [`@lidofinance/chronix-client`](https://github.com/lidofinance/chronix/blob/main/docs/client.md),
pinned to a release commit in `package.json`.

Start the published Chronix image with its controller on loopback.
`ghcr.io/lidofinance/chronix-gloas:latest` follows the latest successful stable Chronix publication:

```sh
docker run --detach --platform linux/amd64 --privileged \
  --name chronix-core --label io.chronix.id=core-chronix \
  --stop-timeout 120 \
  -p 127.0.0.1:18547:8545 \
  --pull always ghcr.io/lidofinance/chronix-gloas:latest
```

Wait for `docker inspect --format '{{.State.Health.Status}}' chronix-core` to report `healthy`, then run:

```sh
yarn test:integration:chronix --bail
```

The Hardhat `chronix` network points at `http://127.0.0.1:18547`; `CHRONIX_URL` or `CHRONIX_PORT`
selects another controller. The controller serves EL JSON-RPC, the Beacon API and the control API
on that one port. Node, Yarn, Forge and `just` are the same prerequisites as scratch deployment.

Inspect controller/client output with `docker logs chronix-core` and
`docker exec chronix-core chronix logs cl --tail 200` (`el` and `vc` select the other clients).
After the run, stop and remove only this test service:

```sh
docker stop chronix-core
docker rm --volumes chronix-core
```

The service must provide fresh Gloas genesis with automine off; the suite performs its own deployment
and warmup. The suite never stops the service. The **Integration Tests Chronix** workflow runs on
every push, like the other integration workflows, using `ghcr.io/lidofinance/chronix-gloas:latest`.
It also supports a manual run with a published version tag or image digest from the same repository
when needed. CI records the selected image in its summary. A missing `latest`, authentication and
network failures stop the job.

Read [verifiers.integration.ts](verifiers.integration.ts) for the scenarios. Chronix calls go
through the SDK. The Lido checks of genesis, Gloas execution and finality, protocol fixture setup,
the existing scratch command and SSZ proof construction live in `helpers/`. As in the other core
integration tests, `getChronixProtocolContext()` returns a ready context with typed `ctx.contracts`,
and tests call the contracts directly with TypeChain and Chai assertions.

Helpers take `ctx` as their first argument. `read…` and `build…` only read data or construct inputs;
`advance…`, `deposit…` and `submit…` change the chain. `anchorHead()` checks the current CL state and
mines one child slot to anchor its root in EL/EIP-4788. `recordTransaction()` waits for a typed
transaction and saves its receipt. Module IDs come from actual StakingRouter registrations; the
operator and key references used by the verifier fixtures are explicit.

Run the whole file: the groups form one sequential scenario. The validator deposited in the PDG
group is later activated and used as a consolidation target. There are no
snapshots or hidden redeployments between groups. Use `--bail` to stop the whole scenario on its
first failure. The shared `bailOnFailure` helper also skips remaining tests within a failed group,
as in the protocol happy-path suite.

## What crosses the real client boundary

- **PredepositGuarantee:** full Lighthouse state → independently calculated Gloas SSZ root →
  validator witness → EIP-4788 root written by Geth → the deployed contract. Validator indices
  span progressive-list boundaries. Modified fields, branches and timestamps must revert.
- **BLS deposits:** a correct deposit domain passes the PDG verifier and is registered by CL.
  An incorrect domain fails PDG verification; the deposit transaction can still succeed in EL,
  but CL must reject the validator. These are real signed transactions and real Geth precompiles.
- **TopUpGateway:** after actual CL activation, the complete validator witness reaches the deployed
  gateway and StakingRouter. A zero-allocation case checks verification/routing without claiming a
  funded top-up. Authenticated field changes, premature calls and expired roots must revert.
- **ConsolidationGateway:** a target with foreign withdrawal credentials is rejected by the
  contract. A valid Lido-vault target produces an actual EL request visible in a CL block. The
  foreign source remains active. This small mainnet-preset network also has zero consolidation
  churn capacity, so this case does not isolate the CL credentials check or claim a successful
  consolidation.
- **Finality:** the suite ends by checking that CL/EL finality advances and a fresh proof passes.

Only the three core entrypoints are in scope. External CSM/CMv2 verifiers, funded top-up allocation
and successful consolidation processing are separate scenarios.

## Evidence and time

Each run saves network/deployment logs, deployment addresses, captured CL states and transaction
receipts under `.local/chronix/core-<id>/`. Before deployment, `deployScratch()` checks fresh EL
and canonical, non-optimistic CL genesis, matching genesis time and chain ID, and the mainnet/Gloas
configuration.

Every witness is anchored only after its complete reconstructed state root matches Lighthouse,
its Gloas bid and payload envelope agree on the captured Beacon root/slot and execution hash/parent,
and the canonical EL block agrees on hash, parent, number and timestamp. The beacon root must also
match both the EL child header and EIP-4788. Captures record the checked execution hash and number.
Deposit processing waits for a CL checkpoint confirmed by EL, using Gloas's checkpoint execution
parent rule. The final test requires both CL finalized epoch and confirmed EL block number
to advance.

Voting, validator activation and finality advance full slots. Protocol delays and fork constants
are unchanged.

The SSZ schema is pinned to the Lighthouse version in `gloas:chronix`:
`2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`. A different layout must fail root equality rather than
silently creating a synthetic root.

The suite gives every Chronix request 120 seconds (`timeoutMs` of the client) and Mocha 20 minutes
per test or hook. The client does not change the service's configuration.
