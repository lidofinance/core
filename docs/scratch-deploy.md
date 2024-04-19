# Deploy Lido protocol from scratch

## Disclaimer: WIP!

This scratch deployment manual is partially outdated and is a subject of further refinement.

## TLDR: local deployment

Do

```shell
anvil -p 8555
```

and

```shell
bash scripts/scratch/dao-local-deploy.sh
```

## Requirements

- same as for the rest of the repo

## General info

The repo contains bash scripts for deployment of the DAO under multiple environments:

- local node (ganache, anvil, hardhat network) `scripts/scratch/dao-local-deploy.sh`
- holesky testnet - `scripts/scratch/dao-holesky-deploy.sh`

The protocol has a bunch of parameters to configure for the scratch deployment. The default configuration is stored in files `deployed-<deploy env>-defaults.json`, where `<deploy env>` is the target environment. Currently, there is a single default configuration, `deployed-testnet-defaults.json`, suitable for testnet deployments. Compared to the mainnet configuration, it has lower vote durations, more frequent oracle report cycles, etc. Part of the parameters require further specification -- they are marked with `null` values.
During the deployment, the "default" configuration is copied to `deployed-<network name>.json`, where `<network name>` is the name of a network configuration defined in `hardhat.config.js`. The file `deployed-<network name>.json` gets populated with the contract addresses and transaction hashes during the deployment process.

These are the deployment setups, supported currently:

- local (basically any node at http://127.0.0.1:8545);
- Holešky testnet.

Each is described in the details in the sections below.

> NB: Aragon UI for Lido DAO is to be deprecated and replaced by a custom solution, thus not included in the deployment script.

### Deploy steps

A brief description of what's going on under the hood in the deploy script.

- Prepare `deployed-<network name>.json` file
  - It is copied from `deployed-testnet-defaults.json`
  - and expended by env variables values, e. g. `DEPLOYER`.
  - It gets filled with the deployed contracts info from step to step.
- (optional) Deploy DepositContract.
  - The step is skipped if the DepositContract address is specified
- (optional) Deploy ENS
  - The step is skipped if the ENS Registry address is specified
- Deploy Aragon framework environment
- Deploy standard Aragon apps contracts (like `Agent`, `Voting`)
- Deploy `LidoTemplate` contract
  - This is an auxiliary deploy contract which performs DAO configuration
- Deploy Lido custom Aragon apps implementations (aka bases), namely for `Lido`, `LegacyOracle`, `NodeOperatorsRegistry`
- Registry Lido APM name in ENS
- Deploy Aragon package manager contract `APMRegistry` (via `LidoTemplate`)
- Deploy Lido custom Aragon apps repo contracts (via `LidoTemplate`)
- Deploy Lido DAO (via `LidoTemplate`)
- Issue DAO tokens (via `LidoTemplate`)
- Deploy non-Aragon Lido contracts: `OracleDaemonConfig`, `LidoLocator`, `OracleReportSanityChecker`, `EIP712StETH`, `WstETH`, `WithdrawalQueueERC721`, `WithdrawalVault`, `LidoExecutionLayerRewardsVault`, `StakingRouter`, `DepositSecurityModule`, `AccountingOracle`, `HashConsensus` for AccountingOracle, `ValidatorsExitBusOracle`, `HashConsensus` for ValidatorsExitBusOracle, `Burner`.
- Finalize Lido DAO deployment: issue unvested LDO tokens, set Aragon permissions, register Lido DAO name in Aragon ID (via `LidoTemplate`)
- Initialize non-Aragon Lido contracts
- Set parameters of `OracleDaemonConfig`
- Setup non-Aragon permissions
- Plug NodeOperatorsRegistry as Curated staking module
- Transfer all admin roles from deployer to `Agent`
  - OZ admin roles: `Burner`, `HashConsensus` for `AccountingOracle`, `HashConsensus` for `ValidatorsExitBusOracle`, `StakingRouter`, `AccountingOracle`, `ValidatorsExitBusOracle`, `WithdrawalQueueERC721`, `OracleDaemonConfig`
  - OssifiableProxy admins: : `LidoLocator`, `StakingRouter`, `AccountingOracle`, `ValidatorsExitBusOracle`, `WithdrawalQueueERC721`
  - `DepositSecurityModule` owner

## Local deployment

Deploys the DAO to local (http://127.0.0.1:8545) dev node (anvil, hardhat, ganache).
The deployment is done from the default test account `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` derived from the default mnemonic.
Thus the node must be configured with the default test accounts derived from the mnemonic `test test test test test test test test test test test junk`.

1. Run `yarn install` (get sure repo dependencies are installed)
2. Run the node on default port 8545 (for the commands, see subsections below)
3. Run the deploy script `bash scripts/scratch/dao-local-deploy.sh` from root repo directory
4. Check out the deploy artifacts in `deployed-local.json`

### Anvil

Run the node with the command:

```shell
anvil -p 8545 --mnemonic "test test test test test test test test test test test junk"
```

### Hardhat node

> NB: Hardhat node configuration is set in `hardhat.config.js` under `hardhat: { `.

To run hardhat node execute:

```shell
yarn hardhat node
```

## Holešky deployment

To do Holešky deployment, the following parameters must be set up via env variables:

- `DEPLOYER`. The deployer address. The deployer must own its private key. To ensure proper operation, it should have an adequate amount of ether. The total deployment gas cost is approximately 120,000,000 gas, and this cost can vary based on whether specific components of the environment, such as the DepositContract, are deployed or not.
- `RPC_URL`. Address of of the Ethereum RPC node to use. E.g. for Infura it is `https://holesky.infura.io/v3/<yourProjectId>`
- `GAS_PRIORITY_FEE`. Gas priority fee. By default set to `2`
- `GAS_MAX_FEE`. Gas max fee. By default set to `100`
- `GATE_SEAL_FACTORY`. Address of the [GateSeal Factory](https://github.com/lidofinance/gate-seals) contract. Must be deployed in advance. Can be set to any `0x0000000000000000000000000000000000000000` to debug deployment
- `WITHDRAWAL_QUEUE_BASE_URI`. BaseURI for WithdrawalQueueERC712. By default not set (left an empty string)
- `DSM_PREDEFINED_ADDRESS`. Address to use instead of deploying `DepositSecurityModule` or `null` otherwise. If used, the deposits can be made by calling `Lido.deposit` from the address.

Also you need to specify `DEPLOYER` private key in `accounts.json` under `/eth/holesky` like `"holesky": ["<key>"]`. See `accounts.sample.json` for an example.

To start the deployment, run (the env variables must already defined) from the root repo directory:

```shell
bash scripts/scratch/dao-holesky-deploy.sh
```

Deploy artifacts information will be stored in `deployed-holesky.json`.

## Publishing sources to Etherscan

After the deployment run

```shell
NETWORK=<PUT-YOUR-VALUE> RPC_URL=<PUT-YOUR-VALUE> bash ./scripts/scratch/verify-contracts-code.sh
```

### Issues with verification of part of the contracts deployed from factories

There are some contracts deployed from other contracts for which automatic hardhat etherscan verification fails:

- `AppProxyUpgradeable` of multiple contracts (`app:lido`, `app:node-operators-registry`, `app:oracle`, `app:voting`, ...)
- `KernelProxy` -- proxy for `Kernel`
- `AppProxyPinned` -- proxy for `EVMScriptRegistry`
- `MiniMeToken` -- LDO token
- `CallsScript` -- Aragon internal contract
- `EVMScriptRegistry` -- Aragon internal contract

The workaround used during Holešky deployment is to deploy auxiliary instances of these contracts standalone and verify them via hardhat Etherscan plugin. After this Etherscan will mark the target contracts as verified by "Similar Match Source Code".

NB, that some contracts require additional auxiliary contract to be deployed. Namely, the constructor of `AppProxyPinned` depends on proxy implementation ("base" in Aragon terms) contract with `initialize()` function and `Kernel` contract, which must return the implementation by call `kernel().getApp(KERNEL_APP_BASES_NAMESPACE, _appId)`. See `@aragon/os/contracts/apps/AppProxyBase.sol` for the details.

## Post deploy initialization

### Initialization up to the fully operational state

In order to make the protocol fully operational, the additional steps are required:

- add oracle committee members to `HashConsensus` contracts for `AccountingOracle` and `ValidatorsExitBusOracle`: `HashConsensus.addMember`;
- initialize initial epoch for `HashConsensus` contracts for `AccountingOracle` and `ValidatorsExitBusOracle`: `HashConsensus.updateInitialEpoch`;
- add guardians to `DepositSecurityModule`: `DepositSecurityModule.addGuardians`;
- resume protocol: `Lido.resume`;
- resume WithdrawalQueue: `WithdrawalQueueERC721.resume`;
- add at least one Node Operator: `NodeOperatorsRegistry.addNodeOperator`;
- add validator keys to the Node Operators: `NodeOperatorsRegistry.addSigningKeys`;
- set staking limits for the Node Operators: `NodeOperatorsRegistry.setNodeOperatorStakingLimit`.

NB, that part of the actions require prior granting of the required roles, e.g. `STAKING_MODULE_MANAGE_ROLE` for `StakingRouter.addStakingModule`:

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

## Protocol parameters

This section describes part of the parameters and their values used at the deployment. The values are specified in `deployed-testnet-defaults.json`.

### OracleDaemonConfig

```python
# Parameters related to "bunker mode"
# See https://research.lido.fi/t/withdrawals-for-lido-on-ethereum-bunker-mode-design-and-implementation/3890/4
# and https://snapshot.org/#/lido-snapshot.eth/proposal/0xa4eb1220a15d46a1825d5a0f44de1b34644d4aa6bb95f910b86b29bb7654e330
# NB: BASE_REWARD_FACTOR: https://ethereum.github.io/consensus-specs/specs/phase0/beacon-chain/#rewards-and-penalties
NORMALIZED_CL_REWARD_PER_EPOCH=64
NORMALIZED_CL_REWARD_MISTAKE_RATE_BP=1000  # 10%
REBASE_CHECK_NEAREST_EPOCH_DISTANCE=1
REBASE_CHECK_DISTANT_EPOCH_DISTANCE=23  # 10% of AO 225 epochs frame
VALIDATOR_DELAYED_TIMEOUT_IN_SLOTS=7200  # 1 day

# See https://snapshot.org/#/lido-snapshot.eth/proposal/0xa4eb1220a15d46a1825d5a0f44de1b34644d4aa6bb95f910b86b29bb7654e330 for "Requirement not be considered Delinquent"
VALIDATOR_DELINQUENT_TIMEOUT_IN_SLOTS=28800  # 4 days

# See "B.3.I" of https://snapshot.org/#/lido-snapshot.eth/proposal/0xa4eb1220a15d46a1825d5a0f44de1b34644d4aa6bb95f910b86b29bb7654e330
NODE_OPERATOR_NETWORK_PENETRATION_THRESHOLD_BP=100  # 1% network penetration for a single NO

# Time period of historical observations used for prediction of the rewards amount
# see https://research.lido.fi/t/withdrawals-for-lido-on-ethereum-bunker-mode-design-and-implementation/3890/4
PREDICTION_DURATION_IN_SLOTS=50400  # 7 days

# Max period of delay for requests finalization in case of bunker due to negative rebase
# twice min governance response time - 3 days voting duration
FINALIZATION_MAX_NEGATIVE_REBASE_EPOCH_SHIFT=1350  # 6 days
```
