# Certora Formal Verification: Lido Staking Vaults

This directory contains Certora's formal verification of the Lido protocol, focussing on the Staking Vaults. The verification covers the staking vaults infrastructure, including vault management, operator management, oracle functionality, and core Lido accounting.

## Directory Structure

### `specs/`

The CVL (Certora Verification Language) specification files, organized by domain.

- `specs/common/`: Shared summaries, ghost variables, and ERC20 specifications used across all specs.
  - `ERC20Standard.spec`, `ERC20Params.spec`, `ERC20Storage.spec`: Standard ERC20 properties.
  - `erc20-summary.spec`: ERC20 function summaries.
  - `lido-storage-ghost.spec`: Ghost variables for tracking Lido state across rules.
  - `lido-summaries.spec`: Summaries for Lido functions.
  - `StakingRouter-summary.spec`, `WithdrawalQueue-summary.spec`, `smoothen-summary.spec`: Dependency summaries.
- `specs/vaults/`: Vault-level specifications.
  - `VaultHub.spec`: Core VaultHub invariants (connectivity, liability bounds, reserve ratios, redemption shares).
  - `VaultHub_health.spec`: Vault health preservation across operations.
  - `vaults-array.spec`: Proves the vaults array is a proper set with correct index mappings.
  - `predeposit.spec`: Validator predeposit state machine transitions.
  - `lazy-oracle.spec`: LazyOracle quarantine integrity and state consistency.
  - `shortfall.spec`: Vault shortfall analysis.
  - `immutable-ratio.spec`: Analysis assuming constant share-to-ETH ratio.
  - `approximated-VaultHub.spec`: Approximated VaultHub analysis.
  - `lido-mock.spec`: Lido mock summaries for share-ETH conversions.
- `specs/core/`: Core protocol specifications.
  - `Accounting.spec`: Accounting oracle report integrity, fee calculations, and revert conditions.
  - `Accounting-burnlimit.spec`: Positive token rebase limiter burn limits.
  - `Accounting-fees-as-frac.spec`: Fee calculations as fractional amounts.
  - `Accounting-summarized.spec`: Summarized accounting verification.
  - `Lido_and_VaultHub.spec`: Integration properties between Lido and VaultHub.
  - `comprehensive-setup.spec`: Full integration of Lido, VaultHub, and Accounting.
- `specs/lido/`: Lido contract specifications.
  - `Lido.spec`: Share transitions, buffered ETH accounting, staking limits, and access control.
- `specs/misc/`: Miscellaneous contract specifications.
  - `burner.spec`: Burner contract invariants and share burning integrity.
  - `node_operators.spec`: Node operators registry properties.
- `specs/setup/`: Sanity checks and dispatching specs for component setup verification.
  - `sanity_*.spec`: Sanity check specifications per contract.
  - `dispatching_*.spec`: Method dispatching specifications per contract.
  - `snippet_*.spec`: Snippet specifications for specific components.

### `confs/`

Certora Prover configuration files, organized to mirror the spec structure.

- `confs/vaults/`: Vault-related configurations including partitioned health checks (`VaultHub_health_part1.conf` through `VaultHub_health_part6.conf`).
- `confs/core/`: Core protocol configurations for Accounting and integrated Lido+VaultHub verification.
- `confs/lido/`: Lido-specific configurations (`Base.conf`, `Lido_shares.conf`, `Lido_eth.conf`, `Lido_staking.conf`).
- `confs/misc/`: Burner and node operators configurations.
- `confs/setup/`: Sanity and autocvl configurations.

### `harness/`

Harness contracts that extend the original contracts to expose internal state and helper functions for verification.

- `VaultHubHarness.sol`: Exposes VaultHub internal state including vault records, connections, deltas, and calculations.
- `LidoHarness.sol`: Exposes Lido share rate calculations and storage.
- `AccountingHarness.sol`: Exposes Accounting contract internals.
- `LazyOracleHarness.sol`: Exposes LazyOracle quarantine info and vault data.
- `BurnerHarness.sol`: Exposes Burner contract state.
- `NativeTransferFuncs.sol`: Utility functions for native ETH transfers.

### `mocks/`

Mock implementations of external dependencies for isolated verification.

- `ILidoMock.sol`: Mock Lido interface with share-to-ETH conversion helpers.
- `IHashConsensusMock.sol`: Mock beacon chain consensus contract.
- `IDepositContractMock.sol`: Mock Ethereum 2.0 deposit contract.
- `StorageExtension*.sol`: Storage extensions enabling property verification on internal storage slots for VaultHub, LazyOracle, OperatorGrid, StakingVault, PredepositGuarantee, and NodeOperatorsRegistry.

### `patches/`

Code modification scripts and patch files. These make internal functions accessible to the Prover by widening their visibility.

- `patch.sh` / `patch-undo.sh` (via `scripts/`): Apply and revert all patches.
- `Makefile`: Build automation for patch application.
- `patch-strategy-lib.patch`: Changes `MinFirstAllocationStrategy.allocate()` visibility for Certora access.
- `patch-total-shares-access.patch`: Adds storage access helpers for total shares.

> [!NOTE]
> The patches are applied as git patches and must be kept in sync with the source code. If the patched files change, the patch scripts will fail to apply and verification will not run.

## Certora Prover

The Certora Prover is a formal verification tool for smart contracts. It statically proves or disproves properties expressed as rules and invariants in the Certora Verification Language (CVL).

## Running Instructions

0. Install the latest Certora Prover by following the [installation guide](https://docs.certora.com/en/latest/docs/user-guide/install.html).

1. From the repository root, apply the patches:

    ```sh
    sh certora/scripts/patch.sh
    ```

    This only needs to be done once per working copy. **Do not commit the patched files.**

2. Run the desired verification job from the repository root (see table below for all properties). Example:

    ```sh
    certoraRun certora/confs/vaults/VaultHub.conf
    ```

3. To revert patches:

    ```sh
    sh certora/scripts/patch-undo.sh
    ```

## High-Level Properties

See the doc-comments in each spec file for detailed descriptions of individual rules.

### VaultHub (`specs/vaults/VaultHub.spec`, `confs/vaults/VaultHub.conf`)

- **Obligated Vault Is Connected** (`obligatedVaultIsConnected`): a vault with obligations must be connected.
- **Disconnected Vault Has No Liability** (`disconnectedVaultHasNoLiability`): disconnected vaults have zero liability shares.
- **Disconnected Vault Has No Locked** (`disconnectedVaultHasNoLocked`): a vault with locked value must be connected.
- **Vault Locked Covers Liability and Reserve** (`vaultLockedCoversLiabilityAndReserve`): the locked amount of a vault covers its shares and reserve.
- **Reserve Ratio Not Big** (`reserveRatioNotBig`): a vault's reserve ratio is at most 100%.
- **Tier Reserve Ratio Bounded** (`tierReserveRatioLeqOne`): reserve ratio for tiers is at most 100%.
- **Tier Reserve Ratio Exceeds Threshold** (`tierReserveRatioGeThreshold`): for each tier, the reserve ratio is greater than the force rebalance threshold.
- **Vault Reserve Ratio Exceeds Threshold** (`vaultReserveRatioGeThreshold`): for every vault, its reserve ratio is greater than its force rebalance threshold.
- **Max Liability Shares Bound** (`maxLiabilitySharesGeqLiabilityShares`): max liability shares is greater than or equal to liability shares.
- **Redemption Shares Bound** (`redemptionSharesLeqLiabilityShares`): redemption shares are less than or equal to liability shares.
- **Pending Has No Shares** (`pendingHasNoShares`): pending disconnect vaults have no shares.
- **Every Non-Default Tier Has Group** (`everyNonDefaultTierHasGroup`): every non-default tier has a group.
- **Can Increase Total Value** (`canIncreaseTotalValue`): which functions can increase a vault's total value.
- **Redemptions Increase** (`redemptionsIncrease`): fees can only be increased by `applyVaultReport`.

### Vault Health (`specs/vaults/VaultHub_health.spec`, `confs/vaults/VaultHub_health*.conf`)

- **Vault Is Healthy Until Report** (`vaultIsHealtyhUntilReport`): a healthy vault remains healthy until a new report is produced, with the exception of settling fees.
- **Summary Correct** (`summaryCorrect`): correctness of summary in terms of functional equivalence.

### Vaults Array (`specs/vaults/vaults-array.spec`, `confs/vaults/VaultHub.conf`)

- **Vaults Array Is Never Empty** (`vaultsArrayIsNeverEmpty`): the `vaults` array in `VaultHub` has address 0 at index 0 after initialization.
- **Index to Vault Is Correct** (`indexToVaultIsCorrect`): array index to vault mapping is correct.
- **Vault to Index Is Correct** (`vaultToIndexIsCorrect`): vault to index mapping is correct.
- **Disconnected Vault Is Not Pending** (`disconnectedVaultIsNotPending`): a vault that is pending disconnect must be connected.

### Predeposit (`specs/vaults/predeposit.spec`, `confs/vaults/predeposit.conf`)

- **Validator Status Transitions** (`validatorStatusTransitions`): valid state transitions for validator predeposit stages: NONE -> PREDEPOSITED -> PROVEN -> ACTIVATED (or COMPENSATED).

### Lazy Oracle (`specs/vaults/lazy-oracle.spec`, `confs/vaults/lazy-oracle.conf`)

- **Quarantine Integrity** (`quarantineIntegrity`): basic integrity for quarantines.
- **Quarantine State Consistency** (`quarantineStateConsistency`): quarantine state consistency.
- **Handle Sanity Checks Revert Conditions** (`handleSanityChecksRevertConditions`): revert conditions for `_handleSanityChecks`.
- **Quarantine Expiry** (`quarantineExpiry`): once a quarantine expires it cannot be reused.

### Accounting (`specs/core/Accounting.spec`, `confs/core/Accounting.conf`)

- **Fees Mint Shares** (`feesMintShares`): rewards are shares minted as fees and `Lido` balance increase.
- **Report Not Reverts By Deposit** (`reportNotRevertsByDeposit`): a deposit done after a report was computed but before it was applied will not cause a revert.
- **Report Not Reverts By Submit** (`reportNotRevertsBySubmit`): a `submit` done after a report was computed but before it was applied will not cause a revert.
- **Handle Oracle Report Revert Conditions** (`handleOracleReportRevertConditions`): revert conditions for `handleOracleReport`.

### Accounting - Burn Limit (`specs/core/Accounting-burnlimit.spec`, `confs/core/Accounting-burnlimit.conf`)

- **Burn Limit Integrity**: positive token rebase limiter burn limits are correctly enforced.

### Lido and VaultHub Integration (`specs/core/Lido_and_VaultHub.spec`, `confs/core/Lido_and_VaultHub.conf`)

- **Only Called By VaultHub** (`verifyOnlyCalledByVaultHub`): verifies the `Lido` functions that can only be called by `VaultHub`.
- **Only Called By Accounting** (`verifyOnlyCalledByAccounting`): verifies functions that can only be called by `Accounting`.
- **Disconnected Vault Has No Liability** (`disconnectedVaultHasNoLiability`): disconnected vaults have no liability shares.
- **External Shares At Most Sum Liability Shares** (`externalSharesAtMostSumLiabilityShares`): external shares are at most the sum of liability shares plus internalized bad debt.
- **External Shares Liability Shares Change Together** (`externalSharesLiabilitySharesChangeTogether`): external shares and liability shares increase/decrease together.

### Lido (`specs/lido/Lido.spec`, `confs/lido/`)

- **Buffered ETH Backed By Balance** (`bufferedEthBackedByBalance`): buffered ETH is backed by contract balance.
- **Shares Transition** (`sharesTransition`): relations between total, external, and internal shares.
- **Total Shares Change Control** (`totalSharesCanOnlyBeChangedBy`): determines the functions that can increase or decrease total shares.
- **Buffered ETH Change Control** (`bufferedEthCanOnlyBeChangedBy`): determines the functions that can change the buffered ETH.
- **Deposited Validators Only Increasing** (`depositedValidatorsOnlyIncreasing`): deposited validators count only increases.
- **Staking Limits Are Kept** (`stakingLimitsAreKept`): internal ETH and shares increase cannot violate the staking limits.
- **Staking Limits Unchanged If Staking** (`stakingLimitsUnchangedIfStaking`): staking limits cannot change in the same function that stakes.
- **Previous Staking Block Number Increasing** (`prevStakingBlockNumberIncreasing`): previous staking block number is weakly monotonically increasing.

### Burner (`specs/misc/burner.spec`, `confs/misc/burner.conf`)

- **Burner Does Not Approve** (`burnerDoesNotApprove`): the `Burner` contract gives no allowance to any address.
- **Burner Shares Only Burnt** (`burnerSharesOnlyBurnt`): `Burner` shares can only be reduced by burning (excluding excess shares).
- **Burner Does Not Affect Third-Party Shares** (`burnerDoesNotAffectThirdPartyShares`): burner does not affect unrelated parties' shares.
- **Burn Requests Integrity** (`burnRequestsIntegrity`): integrity of request burn methods.
- **Commit Burn Integrity** (`commitBurnIntergrity`): integrity of `commitSharesToBurn`.

## General Assumptions

- **Loop unrolling.** All specs use `optimistic_loop: true`. `loop_iter` is set to 2 to keep verification tractable.
- **Optimistic fallback.** Specs use `optimistic_fallback: true` for calls to unresolved external functions.
- **Optimistic hashing.** `optimistic_hashing: true` is used to simplify hash-related reasoning.
- **Hashing length bound.** `hashing_length_bound` ranges from 98 to 500 depending on the configuration.
- **Summarization.** Complex operations (BLS, SSZ, cryptography) are summarized as `NONDET` for tractability.
- **Partitioned verification.** Complex specs like `VaultHub_health` are split into multiple parts (`part1` through `part6`) to manage solver complexity.
