// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* solhint-disable one-contract-per-file */

pragma solidity 0.8.25;

/// @notice Every address the SR phase 2 (LIP-38) upgrade touches.
/// @dev `old*` entries are the live contracts the vote replaces; `new*` entries and the bus are deployed by
///      `0600-deploy-sr-phase-2-contracts` before the vote script is built.
struct SRPhase2UpgradeParameters {
    uint256 chainId;
    // governance
    address voting;
    address agent;
    address dualGovernance;
    // locator
    address locator;
    address locatorAdmin;
    address oldLocatorImplementation;
    address newLocatorImplementation;
    // the oracle gets an implementation that publishes to the bus, finalized to v4 with a new consensus version
    address withdrawalsOracle;
    address newWithdrawalsOracleImpl;
    uint256 withdrawalsOracleConsensusVersion;
    uint256 withdrawalsOracleMaxRequestsPerReport;
    // untouched contracts the vote reads or grants roles on
    address oracleReportSanityChecker;
    address circuitBreaker;
    address circuitBreakerCommittee;
    address resealManager;
    // proxies that only get a new implementation
    address stakingRouter;
    address newStakingRouterImpl;
    address withdrawalVault;
    address newWithdrawalVaultImpl;
    // triggerable withdrawals
    address oldTriggerableWithdrawalsGateway;
    address newTriggerableWithdrawalsGateway;
    address triggerableWithdrawalsBus;
    // removed from the protocol
    address validatorExitDelayVerifier;
    // exit request hash delivery removed from the WithdrawalsOracle:
    // the role holder and the Easy Track factories using it
    address easyTrack;
    address easyTrackEvmScriptExecutor;
    address curatedSubmitExitRequestHashesFactory;
    address sdvtSubmitExitRequestHashesFactory;
    // limits the vote sets on the new gateway: the bus, then the CSM, CSM 0x02 and CMv2 ejectors
    GatewayConsumerLimits[] gatewayConsumers;
    // sanity limit the vote sets, in whole ETH; LIP-38 makes it equal to the bus PWR maxLimit
    uint256 maxBalanceExitRequestedPerReportInEth;
}

/// @notice Limits the vote sets for one consumer of the new TriggerableWithdrawalsGateway (LIP-38 "Initial limits").
struct GatewayConsumerLimits {
    address consumer;
    ITriggerableWithdrawalsGateway.LimitConfig pwrLimit; // in gwei
    ITriggerableWithdrawalsGateway.LimitConfig fwrLimit; // in validators
}

/// @dev `WithdrawalVault` sits behind `WithdrawalsManagerProxy`, not an `OssifiableProxy`.
interface IWithdrawalsManagerProxy {
    function proxy_getAdmin() external view returns (address);
    function implementation() external view returns (address);
    function proxy_upgradeTo(address newImplementation, bytes memory setupCalldata) external;
}

/// @dev The live locator before the vote still exposes the verifier this upgrade removes.
interface ILidoLocatorWithVerifier {
    function validatorExitDelayVerifier() external view returns (address);
}

interface IWithdrawalVault {
    function TRIGGERABLE_WITHDRAWALS_GATEWAY() external view returns (address);
    function CONSOLIDATION_GATEWAY() external view returns (address);
}

interface ITriggerableWithdrawalsGateway {
    struct LimitConfig {
        uint256 maxLimit;
        uint256 limitPerFrame;
        uint256 frameDurationInSec;
    }

    struct LimitInfo {
        uint256 maxLimit;
        uint256 limitPerFrame;
        uint256 frameDurationInSec;
        uint256 prevLimit;
        uint256 currentLimit;
    }

    function LOCATOR() external view returns (address);

    function isPaused() external view returns (bool);

    function setConsumerLimits(address consumer, LimitConfig calldata pwrLimit, LimitConfig calldata fwrLimit) external;

    function getConsumerLimitsFullInfo(
        address consumer
    ) external view returns (LimitInfo memory pwrLimit, LimitInfo memory fwrLimit);
}

interface ITriggerableWithdrawalsBus {
    function LOCATOR() external view returns (address);

    function unprocessedIntentsCount() external view returns (uint256);
}

/// @dev The tiebreaker part of DualGovernance; its `Duration` type is a uint32.
interface IDualGovernanceTiebreaker {
    struct TiebreakerDetails {
        bool isTie;
        address tiebreakerCommittee;
        uint32 tiebreakerActivationTimeout;
        address[] sealableWithdrawalBlockers;
    }

    function addTiebreakerSealableWithdrawalBlocker(address sealableWithdrawalBlocker) external;

    function removeTiebreakerSealableWithdrawalBlocker(address sealableWithdrawalBlocker) external;

    function getTiebreakerDetails() external view returns (TiebreakerDetails memory);
}

interface IStakingRouter {
    function getContractVersion() external view returns (uint256);
}

interface IWithdrawalsOracle {
    function SECONDS_PER_SLOT() external view returns (uint256);

    function GENESIS_TIME() external view returns (uint256);

    function MAX_REQUESTS_PER_REPORT() external view returns (uint256);

    function getContractVersion() external view returns (uint256);

    function getConsensusVersion() external view returns (uint256);

    function finalizeUpgrade_v4(uint256 consensusVersion) external;
}

/// @dev `LimitsList` mirrors the deployed 0.8.9 checker field by field; the vote sets only one of them.
interface IOracleReportSanityChecker {
    struct LimitsList {
        uint256 exitedEthAmountPerDayLimit;
        uint256 appearedEthAmountPerDayLimit;
        uint256 annualBalanceIncreaseBPLimit;
        uint256 simulatedShareRateDeviationBPLimit;
        uint256 maxBalanceExitRequestedPerReportInEth;
        uint256 maxEffectiveBalanceWeightWCType01;
        uint256 maxEffectiveBalanceWeightWCType02;
        uint256 maxItemsPerExtraDataTransaction;
        uint256 maxNodeOperatorsPerExtraDataItem;
        uint256 requestTimestampMargin;
        uint256 maxPositiveTokenRebase;
        uint256 maxCLBalanceDecreaseBP;
        uint256 clBalanceOraclesErrorUpperBPLimit;
        uint256 consolidationEthAmountPerDayLimit;
        uint256 exitedValidatorEthAmountLimit;
        uint256 externalPendingBalanceCapEth;
    }

    function setMaxBalanceExitRequestedPerReportInEth(uint256 _maxBalanceExitRequestedPerReportInEth) external;

    function getOracleReportLimits() external view returns (LimitsList memory);
}

/// @dev Factory changes are gated by the Easy Track admin role, which the Aragon Voting holds, not the Agent.
interface IEasyTrack {
    function isEVMScriptFactory(address maybeEVMScriptFactory) external view returns (bool);

    function removeEVMScriptFactory(address evmScriptFactory) external;
}
