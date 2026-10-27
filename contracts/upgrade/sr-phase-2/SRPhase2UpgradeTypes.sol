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
    // untouched contracts the vote reads or grants roles on
    address validatorsExitBusOracle;
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
    // limits the vote sets on the new gateway: the bus first, then the staking module ejectors
    GatewayConsumerLimits[] gatewayConsumers;
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
