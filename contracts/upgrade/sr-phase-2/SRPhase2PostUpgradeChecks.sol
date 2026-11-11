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
    IOracleReportSanityChecker,
    IStakingRouter,
    ITriggerableWithdrawalsGateway,
    IWithdrawalsOracle,
    IWithdrawalsManagerProxy,
    IWithdrawalVault
} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2PostUpgradeChecks
/// @notice State the SR phase 2 (LIP-38) upgrade must leave after its last action.
contract SRPhase2PostUpgradeChecks is SRPhase2UpgradeChecksBase {
    error InvalidConsumerLimits(address consumer);

    /// @param totalRequestsProcessedBefore `getTotalRequestsProcessed()` of the WithdrawalsOracle read by the
    ///        template before the vote actions: `finalizeUpgrade_v4` moves the counter to a new storage slot
    function validate(SRPhase2UpgradeConfig config, uint256 totalRequestsProcessedBefore) external view {
        address agent = config.AGENT();
        address locatorAddr = config.LOCATOR();
        address oldGateway = config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        address newGateway = config.NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        address bus = config.TRIGGERABLE_WITHDRAWALS_BUS();
        address circuitBreaker = config.CIRCUIT_BREAKER();
        address resealManager = config.RESEAL_MANAGER();
        address withdrawalsOracle = config.WITHDRAWALS_ORACLE();

        // --- Locator ---
        IOssifiableProxy locatorProxy = IOssifiableProxy(locatorAddr);
        _assertAddress(
            "locator-implementation", locatorProxy.proxy__getImplementation(), config.NEW_LOCATOR_IMPLEMENTATION()
        );
        _assertAddress("locator-admin", locatorProxy.proxy__getAdmin(), config.LOCATOR_ADMIN());

        ILidoLocator locator = ILidoLocator(locatorAddr);
        _assertAddress("locator-gateway", locator.triggerableWithdrawalsGateway(), newGateway);
        _assertAddress("locator-bus", locator.triggerableWithdrawalsBus(), bus);
        _assertAddress("locator-withdrawals-oracle", locator.withdrawalsOracle(), withdrawalsOracle);
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
            "wo-implementation",
            IOssifiableProxy(withdrawalsOracle).proxy__getImplementation(),
            config.NEW_WITHDRAWALS_ORACLE_IMPL()
        );
        _assertUint(
            "wo-version",
            IWithdrawalsOracle(withdrawalsOracle).getContractVersion(),
            WITHDRAWALS_ORACLE_CONTRACT_VERSION
        );
        _assertUint(
            "wo-consensus-version",
            IWithdrawalsOracle(withdrawalsOracle).getConsensusVersion(),
            config.WITHDRAWALS_ORACLE_CONSENSUS_VERSION()
        );
        _assertUint(
            "wo-total-requests",
            IWithdrawalsOracle(withdrawalsOracle).getTotalRequestsProcessed(),
            totalRequestsProcessedBefore
        );

        // --- StakingRouter roles removed with the exit hooks ---
        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        _assertUint(
            "sr-exit-triggered-members", stakingRouter.getRoleMemberCount(REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE), 0
        );
        _assertUint(
            "sr-exiting-status-members", stakingRouter.getRoleMemberCount(REPORT_VALIDATOR_EXITING_STATUS_ROLE), 0
        );

        // --- WithdrawalsOracle: the exit request hash delivery role is revoked ---
        // No pre-check: a wrong or second holder leaves a member here. The Easy Track factories need no check:
        // removing an unknown factory reverts, and the Aragon Voting removes them in the transaction that
        // submits this proposal.
        _assertUint(
            "wo-report-hash-members",
            IAccessControlEnumerable(withdrawalsOracle).getRoleMemberCount(SUBMIT_REPORT_HASH_ROLE),
            0
        );

        // --- OracleReportSanityChecker: one WithdrawalsOracle report fits into the bus PWR quota ---
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
        _assertSingleRoleHolder("bus-publisher", busAcl, ADD_WITHDRAWAL_INTENTS_ROLE, withdrawalsOracle);
        // Only a DAO vote that clears the queue may hold this role, and only within that vote
        _assertUint("bus-clear-members", busAcl.getRoleMemberCount(CLEAR_WITHDRAWAL_INTENTS_ROLE), 0);
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
