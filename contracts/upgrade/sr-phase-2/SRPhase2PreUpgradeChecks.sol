// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {SRPhase2UpgradeChecksBase} from "./SRPhase2UpgradeChecksBase.sol";
import {SRPhase2UpgradeConfig} from "./SRPhase2UpgradeConfig.sol";
import {
    GatewayConsumerLimits,
    ILidoLocatorWithVerifier,
    IStakingRouter,
    ITriggerableWithdrawalsBus,
    ITriggerableWithdrawalsGateway,
    IValidatorsExitBusOracle,
    IWithdrawalsManagerProxy,
    IWithdrawalVault
} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2PreUpgradeChecks
/// @notice State the SR phase 2 (LIP-38) upgrade expects before its first action.
contract SRPhase2PreUpgradeChecks is SRPhase2UpgradeChecksBase {
    error LocatorChangedBeyondUpgrade();
    error ConsumerLimitsAlreadySet(address consumer);

    function validate(SRPhase2UpgradeConfig config) external view {
        address agent = config.AGENT();
        address locatorAddr = config.LOCATOR();
        address oldGateway = config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        address newGateway = config.NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        address bus = config.TRIGGERABLE_WITHDRAWALS_BUS();
        address verifier = config.VALIDATOR_EXIT_DELAY_VERIFIER();

        if (block.chainid != config.CHAIN_ID()) revert InvalidChainId(block.chainid, config.CHAIN_ID());

        // --- Locator ---
        IOssifiableProxy locatorProxy = IOssifiableProxy(locatorAddr);
        _assertAddress(
            "locator-implementation", locatorProxy.proxy__getImplementation(), config.OLD_LOCATOR_IMPLEMENTATION()
        );
        _assertAddress("locator-admin", locatorProxy.proxy__getAdmin(), config.LOCATOR_ADMIN());

        ILidoLocator locator = ILidoLocator(locatorAddr);
        _assertAddress("locator-gateway", locator.triggerableWithdrawalsGateway(), oldGateway);
        _assertAddress("locator-verifier", ILidoLocatorWithVerifier(locatorAddr).validatorExitDelayVerifier(), verifier);
        _assertUnchangedLocatorMembers(config, locator);

        // The candidate implementation differs from the live one only in the members this upgrade replaces.
        ILidoLocator candidate = ILidoLocator(config.NEW_LOCATOR_IMPLEMENTATION());
        _assertAddress("candidate-gateway", candidate.triggerableWithdrawalsGateway(), newGateway);
        _assertAddress("candidate-bus", candidate.triggerableWithdrawalsBus(), bus);
        if (_locatorHashOfUnchangedMembers(locator) != _locatorHashOfUnchangedMembers(candidate)) {
            revert LocatorChangedBeyondUpgrade();
        }

        // --- Proxies that get a new implementation ---
        _assertNotYetUpgraded(
            "staking-router",
            IOssifiableProxy(config.STAKING_ROUTER()).proxy__getImplementation(),
            config.NEW_STAKING_ROUTER_IMPL()
        );
        _assertUint(
            "staking-router-version",
            IStakingRouter(config.STAKING_ROUTER()).getContractVersion(),
            STAKING_ROUTER_CONTRACT_VERSION
        );
        _assertNotYetUpgraded(
            "withdrawal-vault",
            IWithdrawalsManagerProxy(config.WITHDRAWAL_VAULT()).implementation(),
            config.NEW_WITHDRAWAL_VAULT_IMPL()
        );
        _assertAddress("withdrawal-vault-admin", IWithdrawalsManagerProxy(config.WITHDRAWAL_VAULT()).proxy_getAdmin(), agent);
        // The vault holds both gateways in immutables: only the triggerable withdrawals one may change.
        _assertAddress(
            "new-wv-impl-tw-gateway",
            IWithdrawalVault(config.NEW_WITHDRAWAL_VAULT_IMPL()).TRIGGERABLE_WITHDRAWALS_GATEWAY(),
            newGateway
        );
        _assertAddress(
            "new-wv-impl-cons-gateway",
            IWithdrawalVault(config.NEW_WITHDRAWAL_VAULT_IMPL()).CONSOLIDATION_GATEWAY(),
            locator.consolidationGateway()
        );

        // The VEBO candidate keeps the chain spec of the live oracle and carries the configured record cap
        IValidatorsExitBusOracle vebo = IValidatorsExitBusOracle(config.VALIDATORS_EXIT_BUS_ORACLE());
        IValidatorsExitBusOracle candidateVebo = IValidatorsExitBusOracle(config.NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL());
        _assertNotYetUpgraded(
            "vebo", IOssifiableProxy(address(vebo)).proxy__getImplementation(), address(candidateVebo)
        );
        _assertAddress("vebo-admin", IOssifiableProxy(address(vebo)).proxy__getAdmin(), agent);
        _assertUint("vebo-version", vebo.getContractVersion(), VEBO_PREVIOUS_CONTRACT_VERSION);
        _assertUint("vebo-candidate-seconds-per-slot", candidateVebo.SECONDS_PER_SLOT(), vebo.SECONDS_PER_SLOT());
        _assertUint("vebo-candidate-genesis-time", candidateVebo.GENESIS_TIME(), vebo.GENESIS_TIME());
        _assertUint(
            "vebo-candidate-max-requests",
            candidateVebo.MAX_REQUESTS_PER_REPORT(),
            config.VALIDATORS_EXIT_BUS_ORACLE_MAX_REQUESTS_PER_REPORT()
        );

        // --- StakingRouter roles removed with the exit hooks ---
        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        _assertSingleRoleHolder("sr-exit-triggered-role", stakingRouter, REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE, oldGateway);
        _assertSingleRoleHolder("sr-exiting-status-role", stakingRouter, REPORT_VALIDATOR_EXITING_STATUS_ROLE, verifier);

        // --- Old gateway: the limit manager and the CircuitBreaker pauser move to the new one ---
        _assertSingleRoleHolder(
            "old-gateway-limit-manager", IAccessControlEnumerable(oldGateway), TW_EXIT_LIMIT_MANAGER_ROLE, agent
        );
        _assertAddress(
            "old-gateway-pauser",
            ICircuitBreaker(config.CIRCUIT_BREAKER()).getPauser(oldGateway),
            config.CIRCUIT_BREAKER_COMMITTEE()
        );

        // --- New gateway: deployed with the Agent as its admin and no other role granted yet ---
        ITriggerableWithdrawalsGateway gateway = ITriggerableWithdrawalsGateway(newGateway);
        _assertAddress("new-gateway-locator", gateway.LOCATOR(), locatorAddr);
        if (gateway.isPaused()) revert InvalidFlag("new-gateway-paused", newGateway);

        IAccessControlEnumerable gatewayAcl = IAccessControlEnumerable(newGateway);
        _assertSingleRoleHolder("new-gateway-admin", gatewayAcl, DEFAULT_ADMIN_ROLE, agent);
        _assertUint("new-gateway-pause-members", gatewayAcl.getRoleMemberCount(PAUSE_ROLE), 0);
        _assertUint("new-gateway-resume-members", gatewayAcl.getRoleMemberCount(RESUME_ROLE), 0);
        _assertUint("new-gateway-limit-members", gatewayAcl.getRoleMemberCount(TW_EXIT_LIMIT_MANAGER_ROLE), 0);
        _assertAddress("new-gateway-pauser", ICircuitBreaker(config.CIRCUIT_BREAKER()).getPauser(newGateway), address(0));

        // No consumer has limits yet, so each one the vote configures starts with a full quota
        GatewayConsumerLimits[] memory consumers = config.getGatewayConsumers();
        for (uint256 i = 0; i < consumers.length; ++i) {
            (
                ITriggerableWithdrawalsGateway.LimitInfo memory pwrLimit,
                ITriggerableWithdrawalsGateway.LimitInfo memory fwrLimit
            ) = gateway.getConsumerLimitsFullInfo(consumers[i].consumer);
            if (pwrLimit.maxLimit != 0 || fwrLimit.maxLimit != 0) {
                revert ConsumerLimitsAlreadySet(consumers[i].consumer);
            }
        }

        // --- Dual Governance: the old gateway is a tiebreaker sealable withdrawal blocker, the new one is not ---
        _assertTiebreakerBlocker("tiebreaker-old-gateway", config.DUAL_GOVERNANCE(), oldGateway, true);
        _assertTiebreakerBlocker("tiebreaker-new-gateway", config.DUAL_GOVERNANCE(), newGateway, false);

        // --- Bus: initialized behind a proxy owned by the Agent, empty, no publisher yet ---
        _assertAddress("bus-proxy-admin", IOssifiableProxy(bus).proxy__getAdmin(), agent);
        _assertAddress("bus-locator", ITriggerableWithdrawalsBus(bus).LOCATOR(), locatorAddr);
        _assertUint("bus-queue", ITriggerableWithdrawalsBus(bus).unprocessedIntentsCount(), 0);

        IAccessControlEnumerable busAcl = IAccessControlEnumerable(bus);
        _assertSingleRoleHolder("bus-admin", busAcl, DEFAULT_ADMIN_ROLE, agent);
        _assertUint("bus-publisher-members", busAcl.getRoleMemberCount(ADD_WITHDRAWAL_INTENTS_ROLE), 0);
        _assertUint("bus-clear-members", busAcl.getRoleMemberCount(CLEAR_WITHDRAWAL_INTENTS_ROLE), 0);
    }

    /// @dev Every locator member except the gateway, the bus and the verifier this upgrade replaces.
    function _locatorHashOfUnchangedMembers(ILidoLocator locator) private view returns (bytes32 hash) {
        hash = _hashAddress(hash, locator.accountingOracle());
        hash = _hashAddress(hash, locator.depositSecurityModule());
        hash = _hashAddress(hash, locator.elRewardsVault());
        hash = _hashAddress(hash, locator.lido());
        hash = _hashAddress(hash, locator.oracleReportSanityChecker());
        hash = _hashAddress(hash, locator.burner());
        hash = _hashAddress(hash, locator.stakingRouter());
        hash = _hashAddress(hash, locator.treasury());
        hash = _hashAddress(hash, locator.validatorsExitBusOracle());
        hash = _hashAddress(hash, locator.withdrawalQueue());
        hash = _hashAddress(hash, locator.withdrawalVault());
        hash = _hashAddress(hash, locator.postTokenRebaseReceiver());
        hash = _hashAddress(hash, locator.oracleDaemonConfig());
        hash = _hashAddress(hash, locator.accounting());
        hash = _hashAddress(hash, locator.predepositGuarantee());
        hash = _hashAddress(hash, locator.wstETH());
        hash = _hashAddress(hash, locator.vaultHub());
        hash = _hashAddress(hash, locator.vaultFactory());
        hash = _hashAddress(hash, locator.lazyOracle());
        hash = _hashAddress(hash, locator.operatorGrid());
        hash = _hashAddress(hash, locator.topUpGateway());
        hash = _hashAddress(hash, locator.consolidationGateway());
    }

    function _assertNotYetUpgraded(bytes32 field, address current, address newImpl) private pure {
        if (current == newImpl) revert InvalidFlag(field, current);
    }

    function _hashAddress(bytes32 previousHash, address value) private pure returns (bytes32) {
        return keccak256(abi.encode(previousHash, value));
    }
}
