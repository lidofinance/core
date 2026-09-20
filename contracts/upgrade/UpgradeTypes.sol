// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

/// @notice Every address the Gloas upgrade touches.
/// @dev `old*` entries are the live contracts the vote replaces; `new*` entries are deployed by
///      `0400-deploy-gloas-contracts` before the vote script is built.
struct UpgradeParameters {
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
    address stakingRouter;
    address circuitBreaker;
    address circuitBreakerCommittee;
    address resealManager;
    // proxies that only get a new implementation
    address predepositGuarantee;
    address newPredepositGuaranteeImpl;
    address topUpGateway;
    address newTopUpGatewayImpl;
    address consolidationBus;
    address newConsolidationBusImpl;
    address withdrawalVault;
    address newWithdrawalVaultImpl;
    // non-upgradeable contracts replaced by a fresh deployment
    address oldValidatorExitDelayVerifier;
    address newValidatorExitDelayVerifier;
    address oldConsolidationGateway;
    address newConsolidationGateway;
}

/// @dev `WithdrawalVault` sits behind `WithdrawalsManagerProxy`, not an `OssifiableProxy`.
interface IWithdrawalsManagerProxy {
    function proxy_getAdmin() external view returns (address);
    function implementation() external view returns (address);
    function proxy_upgradeTo(address newImplementation, bytes memory setupCalldata) external;
}

/// @dev The chain profile the exit-delay verifier is pinned to at construction. Both the outgoing
///      and the incoming deployment expose every field, so the template diffs them against each
///      other instead of trusting the parameters file. The chain has not changed, so neither may
///      these; a wrong value here would not revert, it would silently mis-locate every proof.
interface IValidatorExitDelayVerifier {
    function LOCATOR() external view returns (address);

    function GENESIS_TIME() external view returns (uint64);

    function SLOTS_PER_EPOCH() external view returns (uint32);

    function SECONDS_PER_SLOT() external view returns (uint32);

    function SHARD_COMMITTEE_PERIOD_IN_SECONDS() external view returns (uint32);

    function FIRST_SUPPORTED_SLOT() external view returns (uint64);

    function CAPELLA_SLOT() external view returns (uint64);

    function SLOTS_PER_HISTORICAL_ROOT() external view returns (uint64);
}

/// @dev The consolidation gateway is not behind a proxy, so the replacement starts with a clean
///      pause flag and a full rate-limit budget. The template reads the live one to make sure
///      neither is silently discarded.
interface IConsolidationGateway {
    function isPaused() external view returns (bool);

    function getConsolidationRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxConsolidationRequestsLimit,
            uint256 consolidationsPerFrame,
            uint256 frameDurationInSec,
            uint256 prevConsolidationRequestsLimit,
            uint256 currentConsolidationRequestsLimit
        );
}

/// @dev The two contracts this upgrade redeploys only because they hold the consolidation gateway
///      in an immutable. Both expose it, so the template can prove the new implementations point at
///      the replacement rather than trusting the deployment step.
interface IConsolidationBus {
    function getConsolidationGateway() external view returns (address);
}

interface IWithdrawalVault {
    function CONSOLIDATION_GATEWAY() external view returns (address);
}

/// @dev Implemented by every contract whose Gloas fork switch this upgrade introduces:
///      `ValidatorExitDelayVerifier`, `ConsolidationGateway`, and the `PredepositGuarantee`
///      and `TopUpGateway` implementations.
interface IGloasForkAware {
    function GLOAS_SLOT() external view returns (uint64);
}
