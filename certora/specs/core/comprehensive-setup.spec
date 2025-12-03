/* A comprehensive setup for `Lido`, `VaultHub` and `Accounting`

Setup containing:
- `Accounting`
- `VaultHubHarness`
- `LidoHarness`
- `StakingVault`
*/

import "../vaults/vaults-array.spec";  // Also uses `VaultHubHarness` as `_VaultHub`

using Accounting as _Accounting;
using LidoHarness as _Lido;
using LidoLocator as _LidoLocator;
using Burner as _Burner;
using LidoExecutionLayerRewardsVault as _ELRewardsVault;
using WithdrawalVault as _WithdrawalVault;

methods {
    // `LidoLocator`
    function _.vaultHub() external => _VaultHub expect address;
    function _.lido() external => _Lido expect address;
    function _.accounting() external => _Accounting expect address;
    function _.burner() external => _Burner expect address;
    function _.withdrawalQueue() external => NONDET;
    function _.withdrawalVault() external => _WithdrawalVault expect address;
    function _.elRewardsVault() external => _ELRewardsVault expect address;
    function _.depositSecurityModule() external => NONDET;
    function _.stakingRouter() external => NONDET;

    // `LidoHarness`
    function Lido._getLidoLocator() internal returns (address) => _LidoLocator;
    function LidoHarness.getExternalShares() external returns (uint256) envfree;
    function LidoHarness.getInternalEther() external returns (uint256) envfree;
    function LidoHarness.getShareRateNumerator() external returns (uint256) envfree;
    function LidoHarness.getShareRateDenominator() external returns (uint256) envfree;
    function LidoHarness.eip712Domain() external returns (
        string, string, uint256, address
    ) => CVLeip712Domain();

    function LidoHarness.getSharesByPooledEth(
        uint256 _ethAmount
    ) external returns (uint256) => CVLgetSharesByPooledEth(_ethAmount);
    function LidoHarness.getPooledEthBySharesRoundUp(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthBySharesRoundUp(_sharesAmount);

    // `IKernel` (`@aragon/os/contracts/kernel/IKernel.sol`) called by `AragonApp`
    function _.hasPermission(address, address, bytes32, bytes) external => NONDET;

    // `ConversionHelpers` Lib (`node_modules/@aragon/os/contracts/common/ConversionHelpers.sol`
    // called by `AragonApp`
    // The summary below is not sound since we return a reference type, however it is
    // only used as parameter for `hasPermission` above, which is summarized as `NONDET`.
    function ConversionHelpers.dangerouslyCastUintArrayToBytes(
        uint256[] memory
    ) internal returns (bytes memory) => CVLNondetBytes();

    // The following is a view function in `@aragon/os/contracts/kernel/Kernel.sol`
    function _.getRecoveryVault() external => NONDET;

    // `Burner`
    function _.commitSharesToBurn(uint256) external => DISPATCHER(true);
    function _.requestBurnShares(address, uint256) external => DISPATCHER(true);

    // `IEIP712StETH`
    function _.hashTypedDataV4(address, bytes32) external => NONDET;

    // `LazyOracle`
    function _.latestReportTimestamp() external => NONDET;

    // `StakingVault`
    // Without the following summary, the call from `VaultHub`:Line 1071,
    // `_predepositGuarantee().proveUnknownValidator(_witness, IStakingVault(_vault))`,
    // becomes unresolved ("callee contract unresolved").
    function _.withdraw(address, uint256) external => DISPATCHER(true);

    function _.beaconChainDepositsPaused() external => DISPATCHER(true);
    function _.resumeBeaconChainDeposits() external => DISPATCHER(true);
    function _.pauseBeaconChainDeposits() external => DISPATCHER(true);
    function _.transferOwnership(address) external => DISPATCHER(true);
    function _.pendingOwner() external => DISPATCHER(true);
    function _.depositor() external => DISPATCHER(true);
    function _.owner() external => DISPATCHER(true);
    function _.nodeOperator() external => DISPATCHER(true);
    function _.acceptOwnership() external => DISPATCHER(true);
    function _.fund() external => DISPATCHER(true);
    function _.requestValidatorExit(bytes) external => DISPATCHER(true);
    function _.triggerValidatorWithdrawals(bytes, uint64[], address) external => DISPATCHER(true);

    // Summarize the call to `WITHDRAWAL_REQUEST` in `TriggerableWithdrawals` library
    // as `NONDET`. NOTE: This is not sound but necessary for analysis.
    unresolved external in StakingVault.triggerValidatorWithdrawals(
        bytes, uint64[], address
    ) => DISPATCH [] default NONDET;

    // `PredepositGuarantee`
    // Without the following summary, the call from `VaultHub`:Line 929,
    // `_predepositGuarantee().proveUnknownValidator(_witness, IStakingVault(_vault))`,
    // becomes unresolved ("callee contract unresolved").
    function _.proveUnknownValidator(
        IPredepositGuarantee.ValidatorWitness, address
    ) external => DISPATCHER(true);

    // `BLS` Library
    // Summarizing the `BLS` library since the Prover cannot easily handle such
    // calculations and it contains many unsafe memory operations that hurt static
    // analysis. Using NONDET as it's the most practical approach for verification.
    function BLS12_381.verifyDepositMessage(
        bytes calldata,
        bytes calldata,
        uint256,
        BLS12_381.DepositY calldata,
        bytes32,
        bytes32
    ) internal => NONDET;
    function BLS12_381.sha256Pair(bytes32, bytes32) internal returns (bytes32) => NONDET;
    function BLS12_381.pubkeyRoot(bytes calldata) internal returns (bytes32) => NONDET;

    // `SSZ` Library
    // NOTE: Summarized as NONDET due to complexity of SSZ operations
    function SSZ.hashTreeRoot(SSZ.BeaconBlockHeader memory) internal returns (bytes32) => NONDET;
    function SSZ.hashTreeRoot(SSZ.Validator memory) internal returns (bytes32) => NONDET;
    function SSZ.verifyProof(bytes32[] calldata, bytes32, bytes32, SSZ.GIndex) internal => NONDET;

    // `CLProofVerifier`
    // NOTE: Using wildcard and NONDET as the Prover cannot resolve CLProofVerifier
    // (it worked in previous versions of the code `d1b4b34ebc911f01aca285d8d7b758f8c5fc7619`)
    function _._validatePubKeyWCProof(
        IPredepositGuarantee.ValidatorWitness calldata,
        bytes32
    ) internal => NONDET;

    // `StakingRouter` (called by `Accounting`)
    function _.getStakingRewardsDistribution() external => NONDET;
    function _.getStakingModuleMaxDepositsCount(uint256, uint256) external => NONDET;
    // NOTE: The summary of `reportRewardsMinted` is not sound - returns NONDET
    function _.reportRewardsMinted(uint256[], uint256[]) external => NONDET;
    // NOTE: The summary of `deposit` is not sound - returns NONDET
    function _.deposit(uint256, uint256, bytes) external => NONDET;

    // `OracleReportSanityChecker`
    function _.smoothenTokenRebase(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => NONDET;
    function _.checkAccountingOracleReport(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => NONDET;
    function _.checkWithdrawalQueueOracleReport(uint256, uint256) external => NONDET;

    // `WithdrawalQueueERC721`
    function _.isPaused() external => NONDET;
    function _.prefinalize(uint256[], uint256) external => NONDET;
    function _.isBunkerModeActive() external => NONDET;
    function _.unfinalizedStETH() external => NONDET;
    // NOTE: The summary of `finalize` is not sound - returns NONDET
    function _.finalize(uint256, uint256) external => NONDET;

    // `LidoExecutionLayerRewardsVault`
    function _.withdrawRewards(uint256) external => DISPATCHER(true);

    // `WithdrawalVault`
    function _.withdrawWithdrawals(uint256) external => DISPATCHER(true);

    // `IPostTokenRebaseReceiver`
    // This interface has a single function. Its only implementation is in
    // `test/0.4.24/contracts/PostTokenRebaseReceiver__MockForAccounting.sol` where it
    // does nothing apart from emitting an event.
    function _.handlePostTokenRebase(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => NONDET;
}

// -- Summary functions --------------------------------------------------------

/// @dev Summarize the multiplication and division to reduce chances of timeout.
/// @notice While the original function will revert if `_ethAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetSharesByPooledEth(uint256 _ethAmount) returns uint256 {
    uint256 numeratorInEther = _Lido.getShareRateNumerator();
    uint256 denominatorInShares = _Lido.getShareRateDenominator();

    require(
        numeratorInEther > 0, "Avoid division by zero in getSharesByPooledEth summary"
    );
    require(
        denominatorInShares < 2^128, 
        "Cannot be higher than 2^128 due to the way it is stored"
    );

    return require_uint256((_ethAmount * denominatorInShares) / numeratorInEther);
}


/// @dev Summarize the multiplication and division to reduce chances of timeout.
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthBySharesRoundUp(uint256 _sharesAmount) returns uint256 {
    uint256 numeratorInEther = _Lido.getShareRateNumerator();
    uint256 denominatorInShares = _Lido.getShareRateDenominator();

    require(
        denominatorInShares > 0,
        "Avoid division by zero in getPooledEthBySharesRoundUp summary"
    );
    // NOTE: Lido has been notified about potential overflow risk
    require(
        numeratorInEther < 2^128,
        "Prevent numeratorInEther * _shareAmount from overflowing in getPooledEthBySharesRoundUp"
    );
    require(
        denominatorInShares < 2^128, 
        "Cannot be higher than 2^128 due to the way it is stored"
    );

    return require_uint256(
        // Add `denominatorInShares - 1` to round up
        (_sharesAmount * numeratorInEther + denominatorInShares - 1)
        / denominatorInShares
    );
}


/// @dev Summarize `Lido.eip712Domain` as non-deterministic
function CVLeip712Domain() returns (string, string, uint256, address) {
    string name;
    string version;
    uint256 chainId;
    address verifyingContract;
    return (name, version, chainId, verifyingContract);
}


/// @dev A non-deterministic bytes array
function CVLNondetBytes() returns bytes {
    bytes ret;
    return ret;
}

// ---- Rules: verifying summaries ---------------------------------------------

/// @title Verifies summary of `getSharesByPooledEthSummary`
rule verifygetSharesByPooledEthSummary(uint256 _ethAmount) {
    env e;
    assert _Lido.getSharesByPooledEth(e, _ethAmount) == CVLgetSharesByPooledEth(_ethAmount);
}


/// @title Verifies summary of `getPooledEthBySharesRoundUp`
rule verifygetPooledEthBySharesRoundUp(uint256 _sharesAmount) {
    env e;
    assert (
        _Lido.getPooledEthBySharesRoundUp(e, _sharesAmount) ==
        CVLgetPooledEthBySharesRoundUp(_sharesAmount)
    );
}
