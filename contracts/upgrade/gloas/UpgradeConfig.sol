// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {UpgradeParameters} from "./UpgradeTypes.sol";

/// @title UpgradeConfig
/// @notice Immutable address book for the Gloas upgrade, validated once at deployment.
contract UpgradeConfig {
    error ZeroAddress(string field);
    error InvalidChainId(uint256 chainId);
    error NotReplaced(string field, address value);

    uint256 public immutable CHAIN_ID;

    address public immutable VOTING;
    address public immutable AGENT;
    address public immutable DUAL_GOVERNANCE;

    address public immutable LOCATOR;
    address public immutable LOCATOR_ADMIN;
    address public immutable OLD_LOCATOR_IMPLEMENTATION;
    address public immutable NEW_LOCATOR_IMPLEMENTATION;

    address public immutable STAKING_ROUTER;
    address public immutable CIRCUIT_BREAKER;
    address public immutable CIRCUIT_BREAKER_COMMITTEE;
    address public immutable RESEAL_MANAGER;

    address public immutable PREDEPOSIT_GUARANTEE;
    address public immutable NEW_PREDEPOSIT_GUARANTEE_IMPL;
    address public immutable TOP_UP_GATEWAY;
    address public immutable NEW_TOP_UP_GATEWAY_IMPL;
    address public immutable CONSOLIDATION_BUS;
    address public immutable NEW_CONSOLIDATION_BUS_IMPL;
    address public immutable WITHDRAWAL_VAULT;
    address public immutable NEW_WITHDRAWAL_VAULT_IMPL;

    address public immutable OLD_VALIDATOR_EXIT_DELAY_VERIFIER;
    address public immutable NEW_VALIDATOR_EXIT_DELAY_VERIFIER;
    address public immutable OLD_CONSOLIDATION_GATEWAY;
    address public immutable NEW_CONSOLIDATION_GATEWAY;

    constructor(UpgradeParameters memory params) {
        if (params.chainId == 0) revert InvalidChainId(params.chainId);
        CHAIN_ID = params.chainId;

        VOTING = _nonZero(params.voting, "voting");
        AGENT = _nonZero(params.agent, "agent");
        DUAL_GOVERNANCE = _nonZero(params.dualGovernance, "dualGovernance");

        LOCATOR = _nonZero(params.locator, "locator");
        LOCATOR_ADMIN = _nonZero(params.locatorAdmin, "locatorAdmin");
        OLD_LOCATOR_IMPLEMENTATION = _nonZero(params.oldLocatorImplementation, "oldLocatorImplementation");
        NEW_LOCATOR_IMPLEMENTATION = _nonZero(params.newLocatorImplementation, "newLocatorImplementation");

        STAKING_ROUTER = _nonZero(params.stakingRouter, "stakingRouter");
        CIRCUIT_BREAKER = _nonZero(params.circuitBreaker, "circuitBreaker");
        CIRCUIT_BREAKER_COMMITTEE = _nonZero(params.circuitBreakerCommittee, "circuitBreakerCommittee");
        RESEAL_MANAGER = _nonZero(params.resealManager, "resealManager");

        PREDEPOSIT_GUARANTEE = _nonZero(params.predepositGuarantee, "predepositGuarantee");
        NEW_PREDEPOSIT_GUARANTEE_IMPL = _nonZero(params.newPredepositGuaranteeImpl, "newPredepositGuaranteeImpl");
        TOP_UP_GATEWAY = _nonZero(params.topUpGateway, "topUpGateway");
        NEW_TOP_UP_GATEWAY_IMPL = _nonZero(params.newTopUpGatewayImpl, "newTopUpGatewayImpl");
        CONSOLIDATION_BUS = _nonZero(params.consolidationBus, "consolidationBus");
        NEW_CONSOLIDATION_BUS_IMPL = _nonZero(params.newConsolidationBusImpl, "newConsolidationBusImpl");
        WITHDRAWAL_VAULT = _nonZero(params.withdrawalVault, "withdrawalVault");
        NEW_WITHDRAWAL_VAULT_IMPL = _nonZero(params.newWithdrawalVaultImpl, "newWithdrawalVaultImpl");

        OLD_VALIDATOR_EXIT_DELAY_VERIFIER =
            _nonZero(params.oldValidatorExitDelayVerifier, "oldValidatorExitDelayVerifier");
        NEW_VALIDATOR_EXIT_DELAY_VERIFIER =
            _nonZero(params.newValidatorExitDelayVerifier, "newValidatorExitDelayVerifier");
        OLD_CONSOLIDATION_GATEWAY = _nonZero(params.oldConsolidationGateway, "oldConsolidationGateway");
        NEW_CONSOLIDATION_GATEWAY = _nonZero(params.newConsolidationGateway, "newConsolidationGateway");

        // A parameters file that repeats an address on both sides would make the vote a no-op
        // and the template's pre/post checks contradictory, so reject it here.
        _replaced("locatorImplementation", params.oldLocatorImplementation, params.newLocatorImplementation);
        _replaced(
            "validatorExitDelayVerifier", params.oldValidatorExitDelayVerifier, params.newValidatorExitDelayVerifier
        );
        _replaced("consolidationGateway", params.oldConsolidationGateway, params.newConsolidationGateway);
    }

    function _replaced(string memory field, address oldValue, address newValue) private pure {
        if (oldValue == newValue) revert NotReplaced(field, oldValue);
    }

    function _nonZero(address value, string memory field) private pure returns (address) {
        if (value == address(0)) revert ZeroAddress(field);
        return value;
    }
}
