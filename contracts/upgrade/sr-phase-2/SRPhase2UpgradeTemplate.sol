// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {IUpgradeTemplate} from "../interfaces/IUpgradeTemplate.sol";
import {SRPhase2UpgradeConfig} from "./SRPhase2UpgradeConfig.sol";
import {
    GatewayConsumerLimits,
    SRPhase2UpgradeParameters,
    IDualGovernanceTiebreaker,
    ILidoLocatorWithVerifier,
    IStakingRouter,
    ITriggerableWithdrawalsBus,
    ITriggerableWithdrawalsGateway,
    IWithdrawalsManagerProxy,
    IWithdrawalVault
} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2UpgradeTemplate
/// @notice Pre/post checks wrapping the SR phase 2 (LIP-38) upgrade vote.
/// @dev `startUpgrade` and `finishUpgrade` must run in the same transaction, so the whole vote
///      reverts if the observed state does not match what was deployed. The Dual Governance calls of the vote
///      run between them, so both checks cover the tiebreaker sealable withdrawal blockers too.
contract SRPhase2UpgradeTemplate is IUpgradeTemplate {
    event UpgradeStarted();
    event UpgradeFinished();

    error OnlyAgentCanUpgrade();
    error StartAndFinishMustBeInSameTx();
    error StartAlreadyCalledInThisTx();
    error Expired();
    error InvalidExpiry();
    error InvalidChainId(uint256 actual, uint256 expected);
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();
    error InvalidAddress(bytes32 field, address actual, address expected);
    error InvalidUint(bytes32 field, uint256 actual, uint256 expected);
    error InvalidFlag(bytes32 field, address subject);
    error LocatorChangedBeyondUpgrade();
    error ConsumerLimitsAlreadySet(address consumer);
    error InvalidConsumerLimits(address consumer);

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");
    bytes32 internal constant ADD_WITHDRAWAL_INTENTS_ROLE = keccak256("ADD_WITHDRAWAL_INTENTS_ROLE");
    bytes32 internal constant CLEAR_WITHDRAWAL_INTENTS_ROLE = keccak256("CLEAR_WITHDRAWAL_INTENTS_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE =
        keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXITING_STATUS_ROLE =
        keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");

    /// @dev The StakingRouter implementation is swapped without a reinitializer.
    uint256 internal constant STAKING_ROUTER_CONTRACT_VERSION = 4;

    uint256 internal constant UPGRADE_NOT_STARTED = 0;
    // keccak256("SRPhase2UpgradeTemplate.upgradeStartedFlag")
    bytes32 internal constant UPGRADE_STARTED_SLOT = 0x684cb8f14a7fe2a7e8907f7b820c3cc114907b56da53c8cbe2aa6b3695fbf581;

    address public immutable override CONFIG;
    uint256 public immutable EXPIRE_SINCE_INCLUSIVE;

    uint256 public upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public override isUpgradeFinished;

    constructor(SRPhase2UpgradeParameters memory params, uint256 expireSinceInclusive) {
        if (params.chainId != block.chainid) revert InvalidChainId(block.chainid, params.chainId);
        if (expireSinceInclusive <= block.timestamp) revert InvalidExpiry();

        CONFIG = address(new SRPhase2UpgradeConfig(params));
        EXPIRE_SINCE_INCLUSIVE = expireSinceInclusive;
    }

    function startUpgrade() external {
        SRPhase2UpgradeConfig config = SRPhase2UpgradeConfig(CONFIG);
        if (msg.sender != config.AGENT()) revert OnlyAgentCanUpgrade();
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (_isStartCalledInThisTx()) revert StartAlreadyCalledInThisTx();
        if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

        assembly {
            tstore(UPGRADE_STARTED_SLOT, 1)
        }
        upgradeBlockNumber = block.number;

        _validatePreUpgradeState(config);
        emit UpgradeStarted();
    }

    function finishUpgrade() external {
        SRPhase2UpgradeConfig config = SRPhase2UpgradeConfig(CONFIG);
        if (msg.sender != config.AGENT()) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

        isUpgradeFinished = true;
        _validatePostUpgradeState(config);
        emit UpgradeFinished();
    }

    function _validatePreUpgradeState(SRPhase2UpgradeConfig config) internal virtual {
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

        // --- StakingRouter roles removed with the exit hooks ---
        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        _assertSingleRoleHolder("sr-exit-triggered-role", stakingRouter, REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE, oldGateway);
        _assertSingleRoleHolder("sr-exiting-status-role", stakingRouter, REPORT_VALIDATOR_EXITING_STATUS_ROLE, verifier);

        // --- Old gateway: the limit manager is replayed onto the new one ---
        _assertSingleRoleHolder(
            "old-gateway-limit-manager", IAccessControlEnumerable(oldGateway), TW_EXIT_LIMIT_MANAGER_ROLE, agent
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

    function _validatePostUpgradeState(SRPhase2UpgradeConfig config) internal virtual {
        address agent = config.AGENT();
        address locatorAddr = config.LOCATOR();
        address oldGateway = config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        address newGateway = config.NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        address bus = config.TRIGGERABLE_WITHDRAWALS_BUS();
        address circuitBreaker = config.CIRCUIT_BREAKER();
        address resealManager = config.RESEAL_MANAGER();

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

        // --- StakingRouter roles removed with the exit hooks ---
        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        _assertUint(
            "sr-exit-triggered-members", stakingRouter.getRoleMemberCount(REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE), 0
        );
        _assertUint(
            "sr-exiting-status-members", stakingRouter.getRoleMemberCount(REPORT_VALIDATOR_EXITING_STATUS_ROLE), 0
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
        _assertSingleRoleHolder("bus-publisher", busAcl, ADD_WITHDRAWAL_INTENTS_ROLE, config.VALIDATORS_EXIT_BUS_ORACLE());
        // Only a DAO vote that clears the queue may hold this role, and only within that vote
        _assertUint("bus-clear-members", busAcl.getRoleMemberCount(CLEAR_WITHDRAWAL_INTENTS_ROLE), 0);
    }

    /// @dev Addresses the vote must leave untouched; checked identically before and after.
    function _assertUnchangedLocatorMembers(SRPhase2UpgradeConfig config, ILidoLocator locator) private view {
        _assertAddress("locator-staking-router", locator.stakingRouter(), config.STAKING_ROUTER());
        _assertAddress("locator-withdrawal-vault", locator.withdrawalVault(), config.WITHDRAWAL_VAULT());
        _assertAddress("locator-vebo", locator.validatorsExitBusOracle(), config.VALIDATORS_EXIT_BUS_ORACLE());
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

    function _assertSingleRoleHolder(
        bytes32 field,
        IAccessControlEnumerable acl,
        bytes32 role,
        address holder
    ) private view {
        _assertUint(field, acl.getRoleMemberCount(role), 1);
        if (!acl.hasRole(role, holder)) revert InvalidFlag(field, holder);
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

    function _assertTiebreakerBlocker(bytes32 field, address dualGovernance, address sealable, bool expected) private view {
        address[] memory blockers =
            IDualGovernanceTiebreaker(dualGovernance).getTiebreakerDetails().sealableWithdrawalBlockers;

        bool isBlocker = false;
        for (uint256 i = 0; i < blockers.length; ++i) {
            if (blockers[i] == sealable) {
                isBlocker = true;
                break;
            }
        }

        if (isBlocker != expected) revert InvalidFlag(field, sealable);
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

    function _assertNotYetUpgraded(bytes32 field, address current, address newImpl) private pure {
        if (current == newImpl) revert InvalidFlag(field, current);
    }

    function _hashAddress(bytes32 previousHash, address value) private pure returns (bytes32) {
        return keccak256(abi.encode(previousHash, value));
    }

    function _assertAddress(bytes32 field, address actual, address expected) private pure {
        if (actual != expected) revert InvalidAddress(field, actual, expected);
    }

    function _assertUint(bytes32 field, uint256 actual, uint256 expected) private pure {
        if (actual != expected) revert InvalidUint(field, actual, expected);
    }

    function _isStartCalledInThisTx() internal view returns (bool isStartCalledInThisTx) {
        assembly {
            isStartCalledInThisTx := tload(UPGRADE_STARTED_SLOT)
        }
    }
}
