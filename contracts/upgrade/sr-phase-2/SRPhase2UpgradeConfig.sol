// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {GatewayConsumerLimits, OracleDaemonConfigValues, SRPhase2UpgradeParameters} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2UpgradeConfig
/// @notice Immutable address book for the SR phase 2 (LIP-38) upgrade, validated once at deployment.
/// @dev The gateway consumer limits are an array and the OracleDaemonConfig values are `bytes`; neither can be
///      `immutable`, so they live in storage. Nothing changes them after deployment.
contract SRPhase2UpgradeConfig {
    error ZeroAddress(string field);
    error ZeroValue(string field);
    error InvalidChainId(uint256 chainId);
    error NotReplaced(string field, address value);
    error BusLimitsMissing();
    error InvalidGatewayConsumersCount(uint256 count);
    error DuplicateGatewayConsumer(address consumer);
    error DuplicateEasyTrackFactory(address factory);
    error SanityLimitMismatch(uint256 limitInEth, uint256 busPwrMaxLimit);

    /// @notice The bus and three staking module ejectors; the vote script has one explicit item per consumer
    uint256 public constant GATEWAY_CONSUMERS_COUNT = 4;

    uint256 internal constant GWEI_PER_ETH = 1e9;

    uint256 public immutable CHAIN_ID;

    address public immutable VOTING;
    address public immutable AGENT;
    address public immutable DUAL_GOVERNANCE;

    address public immutable LOCATOR;
    address public immutable LOCATOR_ADMIN;
    address public immutable OLD_LOCATOR_IMPLEMENTATION;
    address public immutable NEW_LOCATOR_IMPLEMENTATION;

    address public immutable VALIDATORS_EXIT_BUS_ORACLE;
    address public immutable NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL;
    /// @notice The consensus version of the new report format, set by `finalizeUpgrade_v4`
    uint256 public immutable VALIDATORS_EXIT_BUS_ORACLE_CONSENSUS_VERSION;
    /// @notice The record cap the new implementation must carry in its immutable
    uint256 public immutable VALIDATORS_EXIT_BUS_ORACLE_MAX_REQUESTS_PER_REPORT;
    address public immutable ORACLE_DAEMON_CONFIG;
    address public immutable ORACLE_REPORT_SANITY_CHECKER;
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

    address public immutable EASY_TRACK;
    address public immutable EASY_TRACK_EVM_SCRIPT_EXECUTOR;
    address public immutable CURATED_SUBMIT_EXIT_REQUEST_HASHES_FACTORY;
    address public immutable SDVT_SUBMIT_EXIT_REQUEST_HASHES_FACTORY;

    /// @notice The sanity limit the vote sets, in whole ETH
    uint256 public immutable MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH;

    /// @notice The only staking module with partial withdrawals allowed after the vote
    uint256 public immutable CMV2_STAKING_MODULE_ID;

    GatewayConsumerLimits[] internal _gatewayConsumers;
    OracleDaemonConfigValues internal _oracleDaemonConfigValues;

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
        NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL =
            _nonZero(params.newValidatorsExitBusOracleImpl, "newValidatorsExitBusOracleImpl");
        VALIDATORS_EXIT_BUS_ORACLE_CONSENSUS_VERSION =
            _nonZeroUint(params.validatorsExitBusOracleConsensusVersion, "validatorsExitBusOracleConsensusVersion");
        VALIDATORS_EXIT_BUS_ORACLE_MAX_REQUESTS_PER_REPORT = _nonZeroUint(
            params.validatorsExitBusOracleMaxRequestsPerReport,
            "validatorsExitBusOracleMaxRequestsPerReport"
        );
        ORACLE_DAEMON_CONFIG = _nonZero(params.oracleDaemonConfig, "oracleDaemonConfig");
        ORACLE_REPORT_SANITY_CHECKER = _nonZero(params.oracleReportSanityChecker, "oracleReportSanityChecker");
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

        EASY_TRACK = _nonZero(params.easyTrack, "easyTrack");
        EASY_TRACK_EVM_SCRIPT_EXECUTOR = _nonZero(params.easyTrackEvmScriptExecutor, "easyTrackEvmScriptExecutor");
        CURATED_SUBMIT_EXIT_REQUEST_HASHES_FACTORY =
            _nonZero(params.curatedSubmitExitRequestHashesFactory, "curatedSubmitExitRequestHashesFactory");
        SDVT_SUBMIT_EXIT_REQUEST_HASHES_FACTORY =
            _nonZero(params.sdvtSubmitExitRequestHashesFactory, "sdvtSubmitExitRequestHashesFactory");
        // Removing one factory twice would revert the Aragon vote on enactment
        if (params.curatedSubmitExitRequestHashesFactory == params.sdvtSubmitExitRequestHashesFactory) {
            revert DuplicateEasyTrackFactory(params.curatedSubmitExitRequestHashesFactory);
        }

        _setGatewayConsumers(params.gatewayConsumers, params.triggerableWithdrawalsBus);
        _checkSanityLimit(params.maxBalanceExitRequestedPerReportInEth, params.gatewayConsumers[0].pwrLimit.maxLimit);
        MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH = params.maxBalanceExitRequestedPerReportInEth;
        CMV2_STAKING_MODULE_ID = _nonZeroUint(params.cmv2StakingModuleId, "cmv2StakingModuleId");
        _oracleDaemonConfigValues = params.oracleDaemonConfigValues;

        // A parameters file that repeats an address on both sides would make the vote a no-op
        // and the template's pre/post checks contradictory, so reject it here.
        _replaced("locatorImplementation", params.oldLocatorImplementation, params.newLocatorImplementation);
        _replaced(
            "triggerableWithdrawalsGateway",
            params.oldTriggerableWithdrawalsGateway,
            params.newTriggerableWithdrawalsGateway
        );
    }

    /// @notice Limits the vote sets on the new gateway: the bus, then the CSM, CSM 0x02 and CMv2 ejectors.
    function getGatewayConsumers() external view returns (GatewayConsumerLimits[] memory) {
        return _gatewayConsumers;
    }

    /// @notice Values of the keys the vote adds to the OracleDaemonConfig; the config itself rejects an empty one.
    function getOracleDaemonConfigValues() external view returns (OracleDaemonConfigValues memory) {
        return _oracleDaemonConfigValues;
    }

    /// @dev The limit values are checked by the gateway itself when the vote sets them.
    function _setGatewayConsumers(GatewayConsumerLimits[] memory consumers, address bus) private {
        if (consumers.length != GATEWAY_CONSUMERS_COUNT) revert InvalidGatewayConsumersCount(consumers.length);
        // The bus is the consumer of the oracle path, and LIP-38 requires its limits
        if (consumers[0].consumer != bus) revert BusLimitsMissing();

        for (uint256 i = 0; i < consumers.length; ++i) {
            address consumer = _nonZero(consumers[i].consumer, "gatewayConsumer");
            for (uint256 j = 0; j < i; ++j) {
                if (consumers[j].consumer == consumer) revert DuplicateGatewayConsumer(consumer);
            }
            _gatewayConsumers.push(consumers[i]);
        }
    }

    /// @dev LIP-38 sizes the bus PWR quota (in gwei) as the most one VEBO report can carry, so it equals the sanity
    ///      limit. The checker keeps the limit in whole ETH in a uint16. Zero would reject every report with exit
    ///      requests.
    function _checkSanityLimit(uint256 limitInEth, uint256 busPwrMaxLimit) private pure {
        if (limitInEth == 0 || limitInEth > type(uint16).max || limitInEth * GWEI_PER_ETH != busPwrMaxLimit) {
            revert SanityLimitMismatch(limitInEth, busPwrMaxLimit);
        }
    }

    function _replaced(string memory field, address oldValue, address newValue) private pure {
        if (oldValue == newValue) revert NotReplaced(field, oldValue);
    }

    function _nonZero(address value, string memory field) private pure returns (address) {
        if (value == address(0)) revert ZeroAddress(field);
        return value;
    }

    function _nonZeroUint(uint256 value, string memory field) private pure returns (uint256) {
        if (value == 0) revert ZeroValue(field);
        return value;
    }
}
