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

/// @dev Implemented by every contract whose Gloas fork switch this upgrade introduces:
///      `ValidatorExitDelayVerifier`, `ConsolidationGateway`, and the `PredepositGuarantee`
///      and `TopUpGateway` implementations.
interface IGloasForkAware {
    function GLOAS_SLOT() external view returns (uint64);
}
