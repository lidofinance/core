# Core verifiers on Panda

One Hardhat/Mocha suite starts **one local Panda network**, performs **one scratch deployment**,
then checks the four core verifiers in order. The suite stops its own network in `after`, including
when a test fails.

```sh
PANDA_ROOT=/path/to/panda yarn test:integration:panda --bail
```

The Panda checkout must already have the local `gloas:panda` bake and its Docker images; `PANDA_BAKE`
selects another compatible tag. The test starts containers; it does not build clients. Node, Yarn,
Forge and `just` are the same prerequisites as scratch deployment. Hardhat uses port 18547 by default;
`PANDA_PORT` selects another local port.

Read [verifiers.integration.ts](verifiers.integration.ts) for the scenarios. Network lifecycle and
HTTP calls live in `lib/panda/index.ts`; protocol fixture setup, the existing scratch command, and
SSZ proof construction live in `helpers/`. Tests use Hardhat's real-network provider, TypeChain,
Mocha and Chai. There is no second test runner.

Run the whole file: the groups form one sequential scenario. The validator deposited in the PDG
group is later activated, used as a consolidation target, and voluntarily exited. There are no
snapshots or hidden redeployments between groups.

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
- **ValidatorExitDelayVerifier:** real VEB delivery → protocol eligibility deadline → recent
  validator proof → StakingRouter/registry event. The historical path uses the summary actually
  created by CL. Corrupted headers and historical branches must revert. After Lighthouse accepts
  a signed voluntary exit, the real changed validator state must invalidate the exit-unset proof.
  The suite then checks resumed CL/EL finality and a fresh proof.

Only the four core entrypoints are in scope. External CSM/CMv2 verifiers, funded top-up allocation
and successful consolidation processing are separate scenarios.

## Evidence and time

Each run saves network/deployment logs, deployment addresses, captured CL states and transaction
receipts under `.local/panda/core-<id>/`. The SDK asserts fresh genesis before deployment. Every
witness is anchored only after its complete reconstructed state root matches Lighthouse and its
beacon root matches both the EL child header and EIP-4788.

The current bake implements large `advanceTo` jumps using skipped slots and real state transitions.
The exit/history scenarios explicitly exercise that path. They do **not** certify complete validator
duty coverage or absence of missed-duty penalties. Voting and validator activation advance full
slots. Protocol delays and fork constants are unchanged.

The SSZ schema is pinned to the Lighthouse version in `gloas:panda`:
`2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`. A different layout must fail root equality rather than
silently creating a synthetic root.
