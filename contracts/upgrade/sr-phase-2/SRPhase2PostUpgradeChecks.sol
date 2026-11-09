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
    ACTIVE_REBALANCING_ENABLED,
    ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS,
    ACTIVE_REBALANCING_MODULE_EXCESS_BP,
    ACTIVE_REBALANCING_OPERATOR_EXCESS_BP,
    ACTIVE_REBALANCING_RATE_LIMIT,
    EXIT_ITERATION_CHUNK,
    GatewayConsumerLimits,
    IOracleDaemonConfig,
    IOracleReportSanityChecker,
    IStakingRouter,
    ITriggerableWithdrawalsGateway,
    IValidatorsExitBusOracle,
    IWithdrawalsManagerProxy,
    IWithdrawalVault,
    OracleDaemonConfigValues
} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2PostUpgradeChecks
/// @notice State the SR phase 2 (LIP-38) upgrade must leave after its last action.
contract SRPhase2PostUpgradeChecks is SRPhase2UpgradeChecksBase {
    error InvalidConsumerLimits(address consumer);
    error InvalidPartialWithdrawalsAllowed(uint256 moduleId);
    error InvalidOracleDaemonConfigValue(string key);

    function validate(SRPhase2UpgradeConfig config) external view {
        address agent = config.AGENT();
        address locatorAddr = config.LOCATOR();
        address oldGateway = config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        address newGateway = config.NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        address bus = config.TRIGGERABLE_WITHDRAWALS_BUS();
        address circuitBreaker = config.CIRCUIT_BREAKER();
        address resealManager = config.RESEAL_MANAGER();
        address vebo = config.VALIDATORS_EXIT_BUS_ORACLE();

        // --- Locator ---
        IOssifiableProxy locatorProxy = IOssifiableProxy(locatorAddr);
        _assertAddress(
            "locator-implementation", locatorProxy.proxy__getImplementation(), config.NEW_LOCATOR_IMPLEMENTATION()
        );
        _assertAddress("locator-admin", locatorProxy.proxy__getAdmin(), config.LOCATOR_ADMIN());

        ILidoLocator locator = ILidoLocator(locatorAddr);
        _assertAddress("locator-gateway", locator.triggerableWithdrawalsGateway(), newGateway);
        _assertAddress("locator-bus", locator.triggerableWithdrawalsBus(), bus);
        _assertUnchangedLocatorMembers(config, locator);

        // --- Proxies that got a new implementation ---
        _assertAddress(
            "staking-router-implementation",
            IOssifiableProxy(config.STAKING_ROUTER()).proxy__getImplementation(),
            config.NEW_STAKING_ROUTER_IMPL()
        );
        _assertUint(
            "staking-router-version",
            IStakingRouter(config.STAKING_ROUTER()).getContractVersion(),
            STAKING_ROUTER_CONTRACT_VERSION
        );
        _assertAddress(
            "withdrawal-vault-implementation",
            IWithdrawalsManagerProxy(config.WITHDRAWAL_VAULT()).implementation(),
            config.NEW_WITHDRAWAL_VAULT_IMPL()
        );
        _assertAddress(
            "withdrawal-vault-tw-gateway",
            IWithdrawalVault(config.WITHDRAWAL_VAULT()).TRIGGERABLE_WITHDRAWALS_GATEWAY(),
            newGateway
        );
        _assertAddress(
            "vebo-implementation",
            IOssifiableProxy(vebo).proxy__getImplementation(),
            config.NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL()
        );
        _assertUint("vebo-version", IValidatorsExitBusOracle(vebo).getContractVersion(), VEBO_CONTRACT_VERSION);
        _assertUint(
            "vebo-consensus-version",
            IValidatorsExitBusOracle(vebo).getConsensusVersion(),
            config.VALIDATORS_EXIT_BUS_ORACLE_CONSENSUS_VERSION()
        );

        // --- StakingRouter: partial withdrawals are allowed for CMv2 and for no other module ---
        uint256 cmv2ModuleId = config.CMV2_STAKING_MODULE_ID();
        uint256[] memory moduleIds = IStakingRouter(config.STAKING_ROUTER()).getStakingModuleIds();
        for (uint256 i = 0; i < moduleIds.length; ++i) {
            bool allowed =
                IStakingRouter(config.STAKING_ROUTER()).getStakingModuleStateConfig(moduleIds[i]).partialWithdrawalsAllowed;
            if (allowed != (moduleIds[i] == cmv2ModuleId)) revert InvalidPartialWithdrawalsAllowed(moduleIds[i]);
        }

        // --- StakingRouter roles removed with the exit hooks ---
        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        _assertUint(
            "sr-exit-triggered-members", stakingRouter.getRoleMemberCount(REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE), 0
        );
        _assertUint(
            "sr-exiting-status-members", stakingRouter.getRoleMemberCount(REPORT_VALIDATOR_EXITING_STATUS_ROLE), 0
        );

        // --- VEBO: the exit request hash delivery role is revoked ---
        // No pre-check: a wrong or second holder leaves a member here. The Easy Track factories need no check:
        // removing an unknown factory reverts, and the Aragon Voting removes them in the transaction that
        // submits this proposal.
        _assertUint(
            "vebo-report-hash-members",
            IAccessControlEnumerable(vebo).getRoleMemberCount(SUBMIT_REPORT_HASH_ROLE),
            0
        );

        // --- OracleReportSanityChecker: one VEBO report fits into the bus PWR quota ---
        // No pre-check of the role: a second holder leaves a member here.
        address sanityChecker = config.ORACLE_REPORT_SANITY_CHECKER();
        _assertUint(
            "sanity-exit-limit",
            IOracleReportSanityChecker(sanityChecker).getOracleReportLimits().maxBalanceExitRequestedPerReportInEth,
            config.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH()
        );
        _assertUint(
            "sanity-exit-limit-members",
            IAccessControlEnumerable(sanityChecker).getRoleMemberCount(MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE),
            0
        );

        // --- OracleDaemonConfig: the new keys hold the configured values ---
        // No pre-check of the keys: setting a present key reverts. The role keeps any other live holder.
        IOracleDaemonConfig daemonConfig = IOracleDaemonConfig(config.ORACLE_DAEMON_CONFIG());
        OracleDaemonConfigValues memory daemonConfigValues = config.getOracleDaemonConfigValues();
        _assertDaemonConfigValue(daemonConfig, EXIT_ITERATION_CHUNK, daemonConfigValues.exitIterationChunk);
        _assertDaemonConfigValue(daemonConfig, ACTIVE_REBALANCING_ENABLED, daemonConfigValues.activeRebalancingEnabled);
        _assertDaemonConfigValue(daemonConfig, ACTIVE_REBALANCING_RATE_LIMIT, daemonConfigValues.activeRebalancingRateLimit);
        _assertDaemonConfigValue(
            daemonConfig, ACTIVE_REBALANCING_OPERATOR_EXCESS_BP, daemonConfigValues.activeRebalancingOperatorExcessBp
        );
        _assertDaemonConfigValue(
            daemonConfig, ACTIVE_REBALANCING_MODULE_EXCESS_BP, daemonConfigValues.activeRebalancingModuleExcessBp
        );
        _assertDaemonConfigValue(
            daemonConfig, ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS, daemonConfigValues.activeRebalancingGracePeriodEpochs
        );
        IAccessControlEnumerable daemonConfigAcl = IAccessControlEnumerable(address(daemonConfig));
        if (daemonConfigAcl.hasRole(CONFIG_MANAGER_ROLE, agent)) revert InvalidFlag("daemon-config-agent", agent);
        address evmScriptExecutor = config.EASY_TRACK_EVM_SCRIPT_EXECUTOR();
        if (!daemonConfigAcl.hasRole(CONFIG_MANAGER_ROLE, evmScriptExecutor)) {
            revert InvalidFlag("daemon-config-executor", evmScriptExecutor);
        }

        // --- New gateway ---
        IAccessControlEnumerable gatewayAcl = IAccessControlEnumerable(newGateway);
        _assertSingleRoleHolder("new-gateway-admin", gatewayAcl, DEFAULT_ADMIN_ROLE, agent);
        _assertTwoRoleHolders("new-gateway-pause", gatewayAcl, PAUSE_ROLE, circuitBreaker, resealManager);
        _assertSingleRoleHolder("new-gateway-resume", gatewayAcl, RESUME_ROLE, resealManager);
        _assertSingleRoleHolder("new-gateway-limit-manager", gatewayAcl, TW_EXIT_LIMIT_MANAGER_ROLE, agent);
        _assertAddress(
            "new-gateway-pauser",
            ICircuitBreaker(circuitBreaker).getPauser(newGateway),
            config.CIRCUIT_BREAKER_COMMITTEE()
        );
        _assertAddress("old-gateway-pauser-cleared", ICircuitBreaker(circuitBreaker).getPauser(oldGateway), address(0));

        // Every consumer got exactly the configured limits, and its quota is still full
        GatewayConsumerLimits[] memory consumers = config.getGatewayConsumers();
        for (uint256 i = 0; i < consumers.length; ++i) {
            (
                ITriggerableWithdrawalsGateway.LimitInfo memory pwrLimit,
                ITriggerableWithdrawalsGateway.LimitInfo memory fwrLimit
            ) = ITriggerableWithdrawalsGateway(newGateway).getConsumerLimitsFullInfo(consumers[i].consumer);
            if (!_isFullLimit(pwrLimit, consumers[i].pwrLimit) || !_isFullLimit(fwrLimit, consumers[i].fwrLimit)) {
                revert InvalidConsumerLimits(consumers[i].consumer);
            }
        }

        // --- Dual Governance: the new gateway replaced the old one as a tiebreaker sealable withdrawal blocker ---
        _assertTiebreakerBlocker("tiebreaker-old-gateway", config.DUAL_GOVERNANCE(), oldGateway, false);
        _assertTiebreakerBlocker("tiebreaker-new-gateway", config.DUAL_GOVERNANCE(), newGateway, true);

        // --- Bus ---
        IAccessControlEnumerable busAcl = IAccessControlEnumerable(bus);
        _assertSingleRoleHolder("bus-publisher", busAcl, ADD_WITHDRAWAL_INTENTS_ROLE, vebo);
        // Only a DAO vote that clears the queue may hold this role, and only within that vote
        _assertUint("bus-clear-members", busAcl.getRoleMemberCount(CLEAR_WITHDRAWAL_INTENTS_ROLE), 0);
    }

    function _assertDaemonConfigValue(
        IOracleDaemonConfig daemonConfig,
        string memory key,
        bytes memory expected
    ) private view {
        if (keccak256(daemonConfig.get(key)) != keccak256(expected)) revert InvalidOracleDaemonConfigValue(key);
    }

    function _assertTwoRoleHolders(
        bytes32 field,
        IAccessControlEnumerable acl,
        bytes32 role,
        address first,
        address second
    ) private view {
        _assertUint(field, acl.getRoleMemberCount(role), 2);
        if (!acl.hasRole(role, first)) revert InvalidFlag(field, first);
        if (!acl.hasRole(role, second)) revert InvalidFlag(field, second);
    }

    function _isFullLimit(
        ITriggerableWithdrawalsGateway.LimitInfo memory actual,
        ITriggerableWithdrawalsGateway.LimitConfig memory expected
    ) private pure returns (bool) {
        return
            actual.maxLimit == expected.maxLimit &&
            actual.limitPerFrame == expected.limitPerFrame &&
            actual.frameDurationInSec == expected.frameDurationInSec &&
            actual.currentLimit == expected.maxLimit;
    }
}
