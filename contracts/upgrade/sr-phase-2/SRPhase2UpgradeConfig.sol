// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {GatewayConsumerLimits, SRPhase2UpgradeParameters} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2UpgradeConfig
/// @notice Immutable address book for the SR phase 2 (LIP-38) upgrade, validated once at deployment.
/// @dev The gateway consumer limits are a list, so they live in storage; nothing changes them after deployment.
contract SRPhase2UpgradeConfig {
    error ZeroAddress(string field);
    error InvalidChainId(uint256 chainId);
    error NotReplaced(string field, address value);
    error BusLimitsMissing();
    error DuplicateGatewayConsumer(address consumer);

    uint256 public immutable CHAIN_ID;

    address public immutable VOTING;
    address public immutable AGENT;
    address public immutable DUAL_GOVERNANCE;

    address public immutable LOCATOR;
    address public immutable LOCATOR_ADMIN;
    address public immutable OLD_LOCATOR_IMPLEMENTATION;
    address public immutable NEW_LOCATOR_IMPLEMENTATION;

    address public immutable VALIDATORS_EXIT_BUS_ORACLE;
    address public immutable CIRCUIT_BREAKER;
    address public immutable CIRCUIT_BREAKER_COMMITTEE;
    address public immutable RESEAL_MANAGER;

    address public immutable STAKING_ROUTER;
    address public immutable NEW_STAKING_ROUTER_IMPL;
    address public immutable WITHDRAWAL_VAULT;
    address public immutable NEW_WITHDRAWAL_VAULT_IMPL;

    address public immutable OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY;
    address public immutable NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY;
    address public immutable TRIGGERABLE_WITHDRAWALS_BUS;

    address public immutable VALIDATOR_EXIT_DELAY_VERIFIER;

    GatewayConsumerLimits[] internal _gatewayConsumers;

    constructor(SRPhase2UpgradeParameters memory params) {
        if (params.chainId == 0) revert InvalidChainId(params.chainId);
        CHAIN_ID = params.chainId;

        VOTING = _nonZero(params.voting, "voting");
        AGENT = _nonZero(params.agent, "agent");
        DUAL_GOVERNANCE = _nonZero(params.dualGovernance, "dualGovernance");

        LOCATOR = _nonZero(params.locator, "locator");
        LOCATOR_ADMIN = _nonZero(params.locatorAdmin, "locatorAdmin");
        OLD_LOCATOR_IMPLEMENTATION = _nonZero(params.oldLocatorImplementation, "oldLocatorImplementation");
        NEW_LOCATOR_IMPLEMENTATION = _nonZero(params.newLocatorImplementation, "newLocatorImplementation");

        VALIDATORS_EXIT_BUS_ORACLE = _nonZero(params.validatorsExitBusOracle, "validatorsExitBusOracle");
        CIRCUIT_BREAKER = _nonZero(params.circuitBreaker, "circuitBreaker");
        CIRCUIT_BREAKER_COMMITTEE = _nonZero(params.circuitBreakerCommittee, "circuitBreakerCommittee");
        RESEAL_MANAGER = _nonZero(params.resealManager, "resealManager");

        STAKING_ROUTER = _nonZero(params.stakingRouter, "stakingRouter");
        NEW_STAKING_ROUTER_IMPL = _nonZero(params.newStakingRouterImpl, "newStakingRouterImpl");
        WITHDRAWAL_VAULT = _nonZero(params.withdrawalVault, "withdrawalVault");
        NEW_WITHDRAWAL_VAULT_IMPL = _nonZero(params.newWithdrawalVaultImpl, "newWithdrawalVaultImpl");

        OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY =
            _nonZero(params.oldTriggerableWithdrawalsGateway, "oldTriggerableWithdrawalsGateway");
        NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY =
            _nonZero(params.newTriggerableWithdrawalsGateway, "newTriggerableWithdrawalsGateway");
        TRIGGERABLE_WITHDRAWALS_BUS = _nonZero(params.triggerableWithdrawalsBus, "triggerableWithdrawalsBus");

        VALIDATOR_EXIT_DELAY_VERIFIER = _nonZero(params.validatorExitDelayVerifier, "validatorExitDelayVerifier");

        _setGatewayConsumers(params.gatewayConsumers, params.triggerableWithdrawalsBus);

        // A parameters file that repeats an address on both sides would make the vote a no-op
        // and the template's pre/post checks contradictory, so reject it here.
        _replaced("locatorImplementation", params.oldLocatorImplementation, params.newLocatorImplementation);
        _replaced(
            "triggerableWithdrawalsGateway",
            params.oldTriggerableWithdrawalsGateway,
            params.newTriggerableWithdrawalsGateway
        );
    }

    /// @notice Limits the vote sets on the new gateway: the bus first, then the staking module ejectors.
    function getGatewayConsumers() external view returns (GatewayConsumerLimits[] memory) {
        return _gatewayConsumers;
    }

    /// @dev The limit values are checked by the gateway itself when the vote sets them.
    function _setGatewayConsumers(GatewayConsumerLimits[] memory consumers, address bus) private {
        // The bus is the consumer of the oracle path, and LIP-38 requires its limits
        if (consumers.length == 0 || consumers[0].consumer != bus) revert BusLimitsMissing();

        for (uint256 i = 0; i < consumers.length; ++i) {
            address consumer = _nonZero(consumers[i].consumer, "gatewayConsumer");
            for (uint256 j = 0; j < i; ++j) {
                if (consumers[j].consumer == consumer) revert DuplicateGatewayConsumer(consumer);
            }
            _gatewayConsumers.push(consumers[i]);
        }
    }

    function _replaced(string memory field, address oldValue, address newValue) private pure {
        if (oldValue == newValue) revert NotReplaced(field, oldValue);
    }

    function _nonZero(address value, string memory field) private pure returns (address) {
        if (value == address(0)) revert ZeroAddress(field);
        return value;
    }
}
