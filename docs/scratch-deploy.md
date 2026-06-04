# Deploy Lido protocol middleware from scratch

Operator handbook: how to run, configure, and verify a scratch deploy. For how
the pipeline works internally (step mechanics, Dual Governance wiring, state
file semantics, CI architecture), see [flow.md](./flow.md).

## TL;DR

```shell
# Start a local Ethereum node
anvil -p 8555 --base-fee 0 --gas-price 0

# In a separate terminal, run the deployment script
bash scripts/dao-local-deploy.sh
```

### Sepolia fork

Same flow, but anvil forks Sepolia (preserving chainId 11155111, which triggers `0010-deploy-deposit-contract` to deploy `SepoliaDepositAdapter` wrapping Sepolia's real beacon deposit contract):

```shell
# Terminal 1 — fork Sepolia
anvil --fork-url "$SEPOLIA_RPC_URL" -p 8555 --base-fee 0 --gas-price 0

# Terminal 2 — deploy
bash scripts/dao-sepolia-fork-deploy.sh
```

### Agent / CI mode (quiet logs)

The scripts above print full deploy + test output to the terminal — gas reports, per-tx traces, and ~700 mocha test ticks. That is fine for a human watching interactively but wasteful for automation / LLM agents.

Agent-friendly variants tee the full output to a file and forward only milestones, mocha counts (`N passing / N pending / N failing`), failure bullets, assertion/provider errors, and the tail of the log to the terminal:

```shell
# Full deploy + tests, log at logs/scratch-deploy.log (override via LOG_FILE env):
bash scripts/dao-local-deploy-agent.sh
bash scripts/dao-sepolia-fork-deploy-agent.sh   # logs/scratch-deploy-sepolia-fork.log

# Just the test suites, with their own log files:
yarn test:integration:fork:local:agent   # logs/integration-fork-local.log
yarn test:integration:scratch:agent      # logs/integration-scratch.log
yarn test:integration:agent              # logs/integration-tests.log (forking mode)
```

All three yarn variants and the deploy wrappers route through `scripts/run-logged.sh <logfile> <command...>`, which you can use to wrap any long-running command the same way.

## Requirements

Same as for the rest of the repo, see [CONTRIBUTING.md](../CONTRIBUTING.md).

In addition, scratch deploy installs Dual Governance from the bundled
`foundry/lib/dual-governance` submodule via `forge script`, so the deploy host
needs:

- `forge` on `PATH` (Foundry; same toolchain used elsewhere in the repo)
- The submodule initialised: `git submodule update --init --recursive` after
  cloning. CI workflows must use `actions/checkout@v4` with `submodules: recursive`.

## General Information

The repository contains bash scripts for deploying the DAO across various environments:

- Local Node Deployment - `scripts/dao-local-deploy.sh` (Supports Ganache, Anvil, Hardhat Network, and other local
  Ethereum nodes)

The protocol requires configuration of numerous parameters for a scratch deployment. The default configurations are
stored in JSON files named `deployed-<deploy env>-defaults.json`, where `<deploy env>` represents the target
environment. Currently, a single default configuration file exists: `testnet-defaults.json`, which is tailored
for testnet deployments. This configuration differs from the mainnet setup, featuring shorter vote durations and more
frequent oracle report cycles, among other adjustments.

> [!NOTE]
> Some parameters in the default configuration file are intentionally set to `null`, indicating that they require
> further specification during the deployment process.

The deployment script performs the following steps regarding configuration:

1. Copies the appropriate default configuration file (e.g., `testnet-defaults.json`) to a new file named
   `deployed-<network name>.json`, where `<network name>` corresponds to a network configuration defined in
   `hardhat.config.js`.

2. Populates the `deployed-<network name>.json` file with specific contract addresses and transaction hashes as the
   deployment progresses.

Detailed information for each setup is provided in the sections below.

> [!NOTE]
> Aragon UI for Lido DAO is to be deprecated and replaced by a custom solution, thus not included in the deployment
> script, see https://research.lido.fi/t/discontinuation-of-aragon-ui-use/7992.

### Deployment Steps

A detailed overview of the deployment script's process:

- Prepare `deployed-<network name>.json` file
  - Copied from `testnet-defaults.json`
  - Enhanced with environment variable values, e.g., `DEPLOYER`
  - Progressively updated with deployed contract information
- (optional) Deploy DepositContract
  - Skipped if DepositContract address is pre-specified
- (optional) Deploy ENS
  - Skipped if ENS Registry address is pre-specified
- Deploy Aragon framework environment
- Deploy standard Aragon apps contracts (e.g., `Agent`, `Voting`)
- Deploy `LidoTemplate` contract
  - Auxiliary contract for DAO configuration
- Deploy Lido custom Aragon apps implementations (bases) for `Lido`, `NodeOperatorsRegistry`
- Register Lido APM name in ENS
- Deploy Aragon package manager contract `APMRegistry` (via `LidoTemplate`)
- Deploy Lido custom Aragon apps repo contracts (via `LidoTemplate`)
- Deploy Lido DAO (via `LidoTemplate`)
- Issue DAO tokens (via `LidoTemplate`)
- Deploy non-Aragon Lido contracts: `OracleDaemonConfig`, `LidoLocator`, `OracleReportSanityChecker`, `EIP712StETH`,
  `WstETH`, `WithdrawalQueueERC721`, `WithdrawalVault`, `LidoExecutionLayerRewardsVault`, `StakingRouter`,
  `DepositSecurityModule`, `AccountingOracle`, `HashConsensus` for AccountingOracle, `ValidatorsExitBusOracle`,
  `HashConsensus` for ValidatorsExitBusOracle, `Burner`
- Finalize Lido DAO deployment: issue unvested LDO tokens, set Aragon permissions, register Lido DAO name in Aragon ID
  (via `LidoTemplate`)
- Initialize non-Aragon Lido contracts
- Set parameters of `OracleDaemonConfig`
- Setup non-Aragon permissions
- Plug NodeOperatorsRegistry as Curated staking module
- Unpause sealable withdrawal blockers (`0145`) — resume `WithdrawalQueueERC721`
  and `ValidatorsExitBusOracle` so the upcoming DG deploy can register them as
  withdrawal blockers; skipped when DG is disabled
- Transfer all admin roles from deployer to `Agent` (`0150`)
  - OpenZeppelin admin roles: `Burner`, both `HashConsensus` instances,
    `StakingRouter`, `AccountingOracle`, `ValidatorsExitBusOracle`,
    `WithdrawalQueueERC721`, `OracleDaemonConfig`, `OracleReportSanityChecker`,
    `TriggerableWithdrawalsGateway`, `VaultHub`, `PredepositGuarantee`,
    `OperatorGrid`, `LazyOracle`
  - OssifiableProxy admin roles for the proxied contracts
  - `DepositSecurityModule` owner
- Deploy and launch Dual Governance (`0160`) — deploys the DG contracts from the
  `foundry/lib/dual-governance` submodule via `forge script`, records their
  addresses in the network state file, wires `ResealManager` pause/resume rights
  on the sealables, and performs the governance hand-off on-chain via
  `LidoTemplate.finalizePermissionsAfterDGDeployment(adminExecutor)` (Voting
  loses direct Agent control; DG's AdminExecutor gains it). No impersonation —
  works on a live network. Mechanics, diagrams, and rationale:
  [flow.md](./flow.md#phase-4-in-detail).

To opt out of DG, set `DG_DEPLOYMENT_ENABLED=false` (any of `false`/`0`/`off`/`no`,
case-insensitive; default is enabled). With the toggle off, step `0145` is a
no-op, step `0150` renounces WQ/VEBO admin immediately, and step `0160` calls
`LidoTemplate.finalizePermissionsWithoutDGDeployment()` (keeps Voting as
permission manager) before setting the template owner to Agent.

### Dual Governance configuration

The `[dualGovernance]` section of the deploy-params toml mirrors the structure
of `dual-governance/deploy-config/deploy-config-mainnet.toml`. Timings are short
(15 min `after_submit_delay`, 5 min veto signalling, etc.) so integration tests
don't have to advance time across multi-day mainnet windows. Committee
addresses default to anvil dev accounts — replace them per network when running
against real testnets:

- `dualGovernance.resealCommittee` — Gnosis Multisig on mainnet
- `dualGovernance.timelock.emergencyProtection.{emergencyGovernanceProposer,
emergencyActivationCommittee, emergencyExecutionCommittee}`
- `dualGovernance.tiebreaker.committees[N].members`

## Deployment Environments

### Local Deployment

This section describes how to deploy the DAO to a local development node (such as Anvil, Hardhat, or Ganache) running
at http://127.0.0.1:8555.

The deployment process utilizes the default test account `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, which is derived
from the standard mnemonic phrase: `test test test test test test test test test test test junk`

To ensure a successful deployment, configure your local node with the default test accounts associated with this
mnemonic.

Follow these steps for local deployment:

1. Run `yarn install` (ensure repo dependencies are installed)
2. Run the node on port 8555 (for the commands, see subsections below)
3. Run the script `bash scripts/dao-local-deploy.sh` from root repo directory
4. Check out the artifacts in `deployed-local.json`

#### Supported Local Nodes

##### Anvil

```shell
anvil -p 8555 --mnemonic "test test test test test test test test test test test junk" --base-fee 0 --gas-price 0
```

##### Hardhat Node

```shell
yarn hardhat node
```

### Testnet Deployment

To do a testnet deployment, the following parameters must be set up via env variables:

- `DEPLOYER`. The deployer address. The deployer must own its private key. To ensure proper operation, it should have an
  adequate amount of ether. The total deployment gas cost is approximately 120,000,000 gas, and this cost can vary based
  on whether specific components of the environment, such as the DepositContract, are deployed or not.
- `RPC_URL`. Address of the Ethereum RPC node to use, e.g.: `https://<network>.infura.io/v3/<yourProjectId>`
- `GENESIS_TIME`. Beacon chain genesis timestamp of the network, e.g. `1655733600` for Sepolia. Required (no default).
- `GENESIS_FORK_VERSION`. Genesis fork version of the network to use, e.g. `0x00000000` for Mainnet, `0x90000069` for Sepolia,
  `0x10000910` for Hoodi. Used to properly calculate the deposit domain for the network.
- `GAS_PRIORITY_FEE`. Gas priority fee. By default set to `2`
- `GAS_MAX_FEE`. Gas max fee. By default set to `100`
- `GATE_SEAL_FACTORY`. Address of the [GateSeal Factory](https://github.com/lidofinance/gate-seals) contract. Must be
  deployed in advance. Can be set to any `0x0000000000000000000000000000000000000000` to debug deployment
- `WITHDRAWAL_QUEUE_BASE_URI`. BaseURI for WithdrawalQueueERC721. By default not set (left an empty string)
- `DSM_PREDEFINED_ADDRESS`. Address to use instead of deploying `DepositSecurityModule` or `null` otherwise. If used,
  the deposits can be made by calling `Lido.deposit` from the address.

Also you need to specify the `DEPLOYER` private key in `accounts.json` under `/eth/<network>` like `"<network>": ["<key>"]`.
See [`accounts.sample.json`](../accounts.sample.json) for the schema. Both `accounts.json` and `.env` are gitignored,
so secrets stay local.

To start the deployment, run `scripts/dao-deploy.sh` with `NETWORK` set to a network configured in
`hardhat.config.ts` (e.g. `sepolia`, `hoodi`, `mainnet`). All env variables listed above must be in scope —
typically loaded from `.env`:

```shell
NETWORK=hoodi \
NETWORK_STATE_FILE=deployed-hoodi.json \
NETWORK_STATE_DEFAULTS_FILE=scripts/defaults/testnet-defaults.json \
bash scripts/dao-deploy.sh
```

`NETWORK_STATE_FILE` defaults to `deployed-<network>.json` if unset; override it (e.g.
`deployed-hoodi-scratch-test.json`) to keep multiple parallel deploys side by side.

Deployment artifacts will be stored in the file pointed at by `NETWORK_STATE_FILE`.

## Post-Deployment Tasks

### Verifying a Live-Testnet Scratch Deployment

The integration suite uses anvil/hardhat-only RPC methods
(`evm_snapshot`/`evm_revert`, `hardhat_setCode`, `*_impersonateAccount`,
chain-time manipulation), so it never runs against the live chain itself —
it always works on a fork. There are two distinct modes; pick by what you
want to verify:

**Verify an existing deployment (forking mode)** — this is what testnet CI
(`tests-integration-hoodi.yml`) runs. Hardhat forks the RPC in-process and
the suite tests the contracts recorded in the deployment artifact; nothing
is deployed, the live chain is never written to:

```shell
RPC_URL="$HOODI_RPC_URL" \
NETWORK_STATE_FILE=deployed-hoodi.json \
yarn test:integration
```

For Sepolia, substitute the RPC and `deployed-sepolia.json` (or whichever
filename you passed to the deploy step). `RPC_URL` can be the live testnet
RPC directly or a local node in front of it.

The DG suite (`dg-scratch.integration.ts`) runs as part of this whenever the
artifact has `dg:adminExecutor` recorded (i.e. the deploy ran with DG), the
network is not mainnet, and `DG_DEPLOYMENT_ENABLED` is not set to a falsy
value. It asserts the post-launch topology (`timelock.governance ==
dualGovernance`, zero launch proposals), the role moves (AdminExecutor has
Agent's `RUN_SCRIPT`/`EXECUTE`, Voting doesn't; Agent owns
`CREATE_PERMISSIONS_ROLE`), ResealManager wiring on every sealable, and an
end-to-end no-op proposal routed Voting → DG → AdminExecutor → Agent. If the
artifact has no DG entries, the suite self-skips and the core tests continue.

To run only the DG suite for fast feedback on the governance hand-off:

```shell
RPC_URL="$HOODI_RPC_URL" \
NETWORK_STATE_FILE=deployed-hoodi.json \
MODE=forking \
yarn hardhat test test/integration/dual-governance/dg-scratch.integration.ts
```

Caveats:

- Verify promptly after deploy. The DG test asserts
  `timelock.getProposalsCount() == 0`; if anyone submits a proposal to the
  testnet's DG between deploy and verification, that assertion fails.
- Voting, Agent, and the deployer are impersonated on the fork. Don't expect
  the same calls to succeed against the live RPC.

**Re-deploy and test from scratch (scratch mode)** — `yarn
test:integration:fork:local` (`MODE=scratch`, network `local`) does **not**
verify an existing deployment: the test process performs a complete fresh
scratch deploy against `LOCAL_RPC_URL` (step `0000` resets the state file
from the deploy params, then every step runs — including a second forge DG
deploy) and tests the instance it just deployed. This answers "does scratch
deploy work against this chain", which is what scratch CI runs against a
blank node. Two warnings:

- Step `0000` **overwrites** whatever `NETWORK_STATE_FILE` points at. Never
  aim it at a deployment artifact you want to keep — copy the file first.
- The chain accumulates a full extra protocol instance per run; only use
  disposable forks/nodes.

### Publishing Sources to Etherscan

```shell
yarn verify:deployed --network <network> (--file <path-to-deployed-json>)
```

#### Issues with verification of part of the contracts deployed from factories

There are some contracts deployed from other contracts for which automatic hardhat etherscan verification fails:

- `AppProxyUpgradeable` of multiple contracts (`app:lido`, `app:node-operators-registry`, `app:oracle`,
  `app:voting`, ...)
- `KernelProxy` -- proxy for `Kernel`
- `AppProxyPinned` -- proxy for `EVMScriptRegistry`
- `MiniMeToken` -- LDO token
- `CallsScript` -- Aragon internal contract
- `EVMScriptRegistry` -- Aragon internal contract

The workaround used during Holesky deployment is to deploy auxiliary instances of these contracts standalone and verify
them via hardhat Etherscan plugin. After this Etherscan will mark the target contracts as verified by "Similar Match
Source Code".

Note that some contracts require additional auxiliary contracts to be deployed. Namely, the constructor of
`AppProxyPinned` depends on proxy implementation ("base" in Aragon terms) contract with `initialize()` function and
`Kernel` contract, which must return the implementation by call `kernel().getApp(KERNEL_APP_BASES_NAMESPACE, _appId)`.
See `@aragon/os/contracts/apps/AppProxyBase.sol` for the details.

### Initialization to Fully Operational State

In order to make the protocol fully operational, the following additional steps are required:

- add oracle committee members to `HashConsensus` contracts for `AccountingOracle` and `ValidatorsExitBusOracle`:
  `HashConsensus.addMember`;
- initialize initial epoch for `HashConsensus` contracts for `AccountingOracle` and `ValidatorsExitBusOracle`:
  `HashConsensus.updateInitialEpoch`;
- add guardians to `DepositSecurityModule`: `DepositSecurityModule.addGuardians`;
- resume protocol: `Lido.resume`;
- resume WithdrawalQueue: `WithdrawalQueueERC721.resume`;
- add at least one Node Operator: `NodeOperatorsRegistry.addNodeOperator`;
- add validator keys to the Node Operators: `NodeOperatorsRegistry.addSigningKeys`;
- set staking limits for the Node Operators: `NodeOperatorsRegistry.setNodeOperatorStakingLimit`.

> [!NOTE]
> Some of these actions require prior granting of the required roles, e.g. `STAKING_MODULE_MANAGE_ROLE` for
> `StakingRouter.addStakingModule`:

```js
await stakingRouter.grantRole(STAKING_MODULE_MANAGE_ROLE, agent.address, { from: agent.address });
await stakingRouter.addStakingModule(
  state.nodeOperatorsRegistry.deployParameters.stakingModuleTypeId,
  nodeOperatorsRegistry.address,
  NOR_STAKING_MODULE_STAKE_SHARE_LIMIT_BP,
  NOR_STAKING_MODULE_PRIORITY_EXIT_SHARE_THRESHOLD_BP,
  NOR_STAKING_MODULE_MODULE_FEE_BP,
  NOR_STAKING_MODULE_TREASURY_FEE_BP,
  NOR_STAKING_MODULE_MAX_DEPOSITS_PER_BLOCK,
  NOR_STAKING_MODULE_MIN_DEPOSIT_BLOCK_DISTANCE,
  { from: agent.address },
);
await stakingRouter.renounceRole(STAKING_MODULE_MANAGE_ROLE, agent.address, { from: agent.address });
```

## Protocol Parameters

This section describes part of the parameters and their values used during deployment. The values are specified in
`testnet-defaults.json`.

### OracleDaemonConfig

```python
# Parameters related to "bunker mode"
# See https://research.lido.fi/t/withdrawals-for-lido-on-ethereum-bunker-mode-design-and-implementation/3890/4
# and https://snapshot.org/#/lido-snapshot.eth/proposal/0xa4eb1220a15d46a1825d5a0f44de1b34644d4aa6bb95f910b86b29bb7654e330
# NB: BASE_REWARD_FACTOR: https://ethereum.github.io/consensus-specs/specs/phase0/beacon-chain/#rewards-and-penalties
NORMALIZED_CL_REWARD_PER_EPOCH = 64
NORMALIZED_CL_REWARD_MISTAKE_RATE_BP = 1000  # 10%
REBASE_CHECK_NEAREST_EPOCH_DISTANCE = 1
REBASE_CHECK_DISTANT_EPOCH_DISTANCE = 23  # 10% of AO 225 epochs frame
VALIDATOR_DELAYED_TIMEOUT_IN_SLOTS = 7200  # 1 day

# See https://snapshot.org/#/lido-snapshot.eth/proposal/0xa4eb1220a15d46a1825d5a0f44de1b34644d4aa6bb95f910b86b29bb7654e330 for "Requirement not be considered Delinquent"
VALIDATOR_DELINQUENT_TIMEOUT_IN_SLOTS = 28800  # 4 days

# See "B.3.I" of https://snapshot.org/#/lido-snapshot.eth/proposal/0xa4eb1220a15d46a1825d5a0f44de1b34644d4aa6bb95f910b86b29bb7654e330
NODE_OPERATOR_NETWORK_PENETRATION_THRESHOLD_BP = 100  # 1% network penetration for a single NO

# Time period of historical observations used for prediction of the rewards amount
# see https://research.lido.fi/t/withdrawals-for-lido-on-ethereum-bunker-mode-design-and-implementation/3890/4
PREDICTION_DURATION_IN_SLOTS = 50400  # 7 days

# Max period of delay for requests finalization in case of bunker due to negative rebase
# twice min governance response time - 3 days voting duration
FINALIZATION_MAX_NEGATIVE_REBASE_EPOCH_SHIFT = 1350  # 6 days
```
