// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";
import {PausableUntil} from "../utils/PausableUntil.sol";
import {WithdrawalCredentials} from "../../common/lib/WithdrawalCredentials.sol";
import {WithdrawalIntent, MAX_PWR_AMOUNT_GWEI} from "../../common/interfaces/WithdrawalIntent.sol";
import {ITriggerableWithdrawalsBus} from "../../common/interfaces/ITriggerableWithdrawalsBus.sol";

import {BaseOracle} from "./BaseOracle.sol";

/// @notice New interface for staking modules (CSM, CuratedV2)
/// @dev Returns only pubkeys
interface IUnifiedStakingModule {
    /// @dev It also works for legacy staking modules (NOR, SDVT) where `getSigningKeys` returns different
    ///      tuple `(bytes memory pubkeys, bytes memory signatures, bool[] memory used)`.
    ///      The trick: `abi.decode(returndata, (bytes))` will decode only the first tuple element.
    ///      This is safe as long as the first returned value really is `bytes pubkeys` in that position.
    function getSigningKeys(
        uint256 nodeOperatorId,
        uint256 startIndex,
        uint256 keysCount
    ) external view returns (bytes memory);
}

interface IStakingRouter {
    struct ModuleStateConfig {
        address moduleAddress;
        uint16 moduleFee;
        uint16 treasuryFee;
        uint16 stakeShareLimit;
        uint16 priorityExitShareThreshold;
        uint8 status;
        uint8 withdrawalCredentialsType;
        bool partialWithdrawalsAllowed;
    }

    function getStakingModuleStateConfig(uint256 _stakingModuleId)
        external
        view
        returns (ModuleStateConfig memory stateConfig);

    function getStakingModulesCount() external view returns (uint256);
}

interface ILidoLocator {
    function triggerableWithdrawalsBus() external view returns (address);
    function oracleReportSanityChecker() external view returns (address);
    function stakingRouter() external view returns (address);
}

interface IOracleReportSanityChecker {
    function checkExitBusOracleReport(uint256 _maxBalanceExitRequestedPerReportInEth) external view;
    function getMaxEffectiveBalanceWeightWCType01() external view returns (uint256);
    function getMaxEffectiveBalanceWeightWCType02() external view returns (uint256);
}

/**
 * @title WithdrawalsOracle
 * @notice Decodes oracle report records into withdrawal request intents (EIP-7002 partial and full
 * withdrawals) and appends them to the TriggerableWithdrawalsBus queue.
 */
contract WithdrawalsOracle is BaseOracle, PausableUntil {
    using UnstructuredStorage for bytes32;
    using SafeCast for uint256;

    error AdminCannotBeZero();
    error SenderNotAllowed();
    error UnexpectedRequestsDataLength();

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when report data has wrong length
     */
    error InvalidRequestsDataLength();

    /**
     * @notice Thrown when module id equal to zero
     */
    error InvalidModuleId();

    /**
     * @notice Thrown when retrieved pubkey length is invalid
     */
    error InvalidRetrievedKeyLength();

    /**
     * @notice Thrown when a report contains more records than MAX_REQUESTS_PER_REPORT
     * @param requestsCount Number of records in the report
     * @param maxRequestsPerReport Maximum number of records allowed per report
     */
    error TooManyRequestsInReport(uint256 requestsCount, uint256 maxRequestsPerReport);

    /**
     * @notice Thrown when a partial withdrawal is requested for a module that does not allow it
     * @param moduleId Staking module ID
     */
    error PartialWithdrawalsNotAllowed(uint256 moduleId);

    /**
     * @notice Thrown when a partial withdrawal amount exceeds MAX_PWR_AMOUNT_GWEI
     * @param index Index of the record in the report
     * @param amount Requested amount in gwei
     */
    error WithdrawalAmountTooLarge(uint256 index, uint256 amount);

    error InvalidMaxEBWeight();
    error UnexpectedWCType();

    /**
     * @notice Emitted for every withdrawal request intent added to the TriggerableWithdrawalsBus queue
     * @param moduleId Staking module ID
     * @param nodeOperatorId Node operator ID
     * @param pubkey Validator public key
     * @param amountGwei Withdrawal amount in gwei: `0` is a full withdrawal, `> 0` is a partial one
     */
    event WithdrawalRequested(
        uint256 indexed moduleId,
        uint256 indexed nodeOperatorId,
        bytes pubkey,
        uint256 amountGwei
    );

    /// @dev Staking module data cached while iterating over report records
    struct ModuleCache {
        uint256 moduleId;
        address moduleAddress;
        bool partialWithdrawalsAllowed;
        uint256 fwrWeightEth; // sanity weight of one FWR: max effective balance for the module's WC type
    }

    /// @notice An ACL role granting the permission to submit the data for a committee report.
    bytes32 public constant SUBMIT_DATA_ROLE = keccak256("SUBMIT_DATA_ROLE");
    /// @notice An ACL role granting the permission to pause accepting report data
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    /// @notice An ACL role granting the permission to resume accepting report data
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");

    /// @dev [DEPRECATED] Storage slot: DataProcessingState dataProcessingState
    /// Per-report processing counters; a report is processed in a single transaction. Cleared in v4.
    bytes32 internal constant DEPRECATED_DATA_PROCESSING_STATE_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.dataProcessingState");

    /// @dev Storage slot: uint256 totalRequestsProcessed
    bytes32 internal constant TOTAL_REQUESTS_PROCESSED_POSITION =
        keccak256("lido.WithdrawalsOracle.totalRequestsProcessed");

    /// @dev [DEPRECATED] Storage slot: uint256 totalRequestsProcessed
    /// The counter before v4. Moved to `TOTAL_REQUESTS_PROCESSED_POSITION` and cleared in v4.
    bytes32 internal constant DEPRECATED_TOTAL_REQUESTS_PROCESSED_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.totalRequestsProcessed");

    /// @dev [DEPRECATED] Storage slot: mapping(uint256 => RequestedValidator) lastRequestedValidatorIndices
    /// This mapping was previously used for storing last requested validator indexes per (moduleId, nodeOpId) key.
    /// This code was removed from the contract, but slots can still contain data.

    /// @dev [DEPRECATED] Storage slot: uint256 at keccak256("lido.ValidatorsExitBus.maxExitRequestLimit")
    /// Exit request limit by validators count (v2), replaced by the exit balance limit in v3. Cleared in v3.

    /// @dev [DEPRECATED] Storage slot: LimitData exitBalanceLimitEth
    /// Exit balance rate limit (in ETH) for the exit requests hash-delivery path. Cleared in v4.
    bytes32 internal constant DEPRECATED_EXIT_BALANCE_LIMIT_POSITION =
        keccak256("lido.ValidatorsExitBus.exitBalanceLimitEth");

    /// @dev [DEPRECATED] Storage slot: uint256 maxValidatorsPerReport
    /// Maximum number of exit requests per report. Cleared in v4.
    bytes32 internal constant DEPRECATED_MAX_VALIDATORS_PER_REPORT_POSITION =
        keccak256("lido.ValidatorsExitBus.maxValidatorsPerReport");

    /// @dev [DEPRECATED] Storage slot: mapping(bytes32 => RequestStatus) at keccak256("lido.ValidatorsExitBus.requestStatus")
    /// This mapping was previously used for storing the delivery timestamp and contract version per exit requests hash.
    /// This code was removed from the contract, but slots can still contain data.

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 24;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    ILidoLocator internal immutable LOCATOR;

    /// @notice Maximum number of records in a single report
    uint256 public immutable MAX_REQUESTS_PER_REPORT;

    ///
    /// Initialization & admin functions
    ///

    constructor(
        uint256 secondsPerSlot,
        uint256 genesisTime,
        address lidoLocator,
        uint256 maxRequestsPerReport
    ) BaseOracle(secondsPerSlot, genesisTime) {
        if (maxRequestsPerReport == 0) revert ZeroArgument("maxRequestsPerReport");
        LOCATOR = ILidoLocator(lidoLocator);
        MAX_REQUESTS_PER_REPORT = maxRequestsPerReport;
    }

    function initialize(
        address admin,
        address consensusContract,
        uint256 consensusVersion,
        uint256 lastProcessingRefSlot
    ) external {
        if (admin == address(0)) revert AdminCannotBeZero();
        _setupRole(DEFAULT_ADMIN_ROLE, admin);

        _pauseFor(PAUSE_INFINITELY);
        _initialize(consensusContract, consensusVersion, lastProcessingRefSlot);
        _updateContractVersion(2);
        _updateContractVersion(3);
        _updateContractVersion(4);
    }

    /**
     * @notice A function to finalize upgrade to v4. Can be called only once
     * @dev Switches the report to the withdrawal requests format, so the consensus version is updated as well.
     *
     * For more details see https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-38.md
     * @param consensusVersion New consensus version
     */
    function finalizeUpgrade_v4(uint256 consensusVersion) external {
        _updateContractVersion(4);
        _setConsensusVersion(consensusVersion);
        _migrateTotalRequestsProcessed();
        _clearDeprecatedSlots();
    }

    /// @notice Resume accepting report data
    ///
    /// @dev Reverts with `PausedExpected()` if contract is already resumed
    /// @dev Reverts with `AccessControl:...` reason if sender has no `RESUME_ROLE`
    ///
    function resume() external whenPaused onlyRole(RESUME_ROLE) {
        _resume();
    }

    /// @notice Pause accepting report data for the given duration.
    ///
    /// @param _duration Pause duration, seconds (use `PAUSE_INFINITELY` for unlimited).
    /// @dev Reverts with `ResumedExpected()` if contract is already paused.
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`.
    /// @dev Reverts with `ZeroPauseDuration()` if zero duration is passed.
    ///
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /// @notice Pause accepting report data.
    /// @param _pauseUntilInclusive The last second to pause until.
    /// @dev Reverts with `ResumeSinceInPast()` if the timestamp is in the past.
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`.
    /// @dev Reverts with `ResumedExpected()` if contract is already paused.
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    ///
    /// Data provider interface
    ///

    struct ReportData {
        ///
        /// Oracle consensus info
        ///

        /// @dev Version of the oracle consensus rules. Current version expected
        /// by the oracle can be obtained by calling getConsensusVersion().
        uint256 consensusVersion;
        /// @dev Reference slot for which the report was calculated. If the slot
        /// contains a block, the state being reported should include all state
        /// changes resulting from that block. The epoch containing the slot
        /// should be finalized prior to calculating the report.
        uint256 refSlot;
        ///
        /// Requests data
        ///

        /// @dev Total number of withdrawal requests in this report. Must not be greater
        /// than MAX_REQUESTS_PER_REPORT.
        uint256 requestsCount;
        /// @dev Packed withdrawal requests, see the data format below.
        bytes data;
    }

    /// @notice Format of the report `data` field.
    ///
    /// Each withdrawal request is described by the following 24-byte record:
    ///
    /// MSB <------------------------------------------------ LSB
    /// |  3 bytes   |  5 bytes   |  8 bytes   |  8 bytes        |
    /// |  moduleId  |  nodeOpId  |  keyIndex  |  amount (gwei)  |
    ///
    ///  `amount == 0` is a full withdrawal request (FWR), `amount > 0` is a partial
    /// withdrawal request (PWR). The validator pubkey is read from the staking module by `keyIndex`.
    /// All records are tightly packed into a byte array without any separator or padding.
    /// Records are not sorted: their order is the execution priority and is kept in the
    /// TriggerableWithdrawalsBus queue.

    /// @notice Submits report data for processing.
    ///
    /// @param data The data. See the `ReportData` structure's docs for details.
    /// @param contractVersion Expected version of the oracle contract.
    ///
    /// Reverts if:
    /// - The caller is not a member of the oracle committee and doesn't possess the
    ///   SUBMIT_DATA_ROLE.
    /// - The provided contract version is different from the current one.
    /// - The provided consensus version is different from the expected one.
    /// - The provided reference slot differs from the current consensus frame's one.
    /// - The processing deadline for the current consensus frame is missed.
    /// - The keccak256 hash of the ABI-encoded data is different from the last hash
    ///   provided by the hash consensus contract.
    /// - The provided data doesn't meet safety checks.
    /// - The report contains more than MAX_REQUESTS_PER_REPORT records.
    /// - A partial withdrawal targets a module without `partialWithdrawalsAllowed`.
    /// - A partial withdrawal amount exceeds MAX_PWR_AMOUNT_GWEI.
    /// - The report's total exit balance exceeds the OracleReportSanityChecker limit.
    ///
    function submitReportData(ReportData calldata data, uint256 contractVersion) external whenResumed {
        _checkMsgSenderIsAllowedToSubmitData();
        _checkContractVersion(contractVersion);
        // it's a waste of gas to copy the whole calldata into mem but seems there's no way around
        bytes32 reportDataHash = keccak256(abi.encode(data));
        _checkConsensusData(data.refSlot, data.consensusVersion, reportDataHash);
        _startProcessing();
        _handleConsensusReportData(data);
    }

    struct ProcessingState {
        /// @notice Reference slot for the current reporting frame.
        uint256 currentFrameRefSlot;
        /// @notice The last time at which a report data can be submitted for the current
        /// reporting frame.
        uint256 processingDeadlineTime;
        /// @notice Hash of the report data. Zero bytes if consensus on the hash hasn't
        /// been reached yet for the current reporting frame.
        bytes32 dataHash;
        /// @notice Whether any report data for the current reporting frame has been
        /// already submitted.
        bool dataSubmitted;
    }

    /// @notice Returns data processing state for the current reporting frame.
    /// @return result See the docs for the `ProcessingState` struct.
    ///
    function getProcessingState() external view returns (ProcessingState memory result) {
        ConsensusReport memory report = _storageConsensusReport().value;
        result.currentFrameRefSlot = _getCurrentRefSlot();

        if (report.hash == bytes32(0) || result.currentFrameRefSlot != report.refSlot) {
            return result;
        }

        result.processingDeadlineTime = report.processingDeadlineTime;
        result.dataHash = report.hash;
        result.dataSubmitted = report.refSlot == LAST_PROCESSING_REF_SLOT_POSITION.getStorageUint256();
    }

    /// @notice Returns the total number of withdrawal requests (full and partial) ever processed
    /// across all received reports. Before v4 it counted validator exit requests only.
    ///
    function getTotalRequestsProcessed() external view returns (uint256) {
        return TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256();
    }

    function MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_01() public view returns (uint16) {
        (uint16 maxEBWeightType1, ) = _getMaxEffectiveBalanceWeights();
        return maxEBWeightType1;
    }

    function MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_02() public view returns (uint16) {
        (, uint16 maxEBWeightType2) = _getMaxEffectiveBalanceWeights();
        return maxEBWeightType2;
    }

    ///
    /// Implementation & helpers
    ///

    function _handleConsensusReport(
        ConsensusReport memory /* report */,
        uint256 /* prevSubmittedRefSlot */,
        uint256 /* prevProcessingRefSlot */
    ) internal override {
        // a report is processed in a single transaction, so the previous one is never left incomplete
    }

    function _checkMsgSenderIsAllowedToSubmitData() internal view {
        address sender = _msgSender();
        if (!hasRole(SUBMIT_DATA_ROLE, sender) && !_isConsensusMember(sender)) {
            revert SenderNotAllowed();
        }
    }

    function _handleConsensusReportData(ReportData calldata data) internal {
        if (data.data.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }

        if (data.data.length / PACKED_REQUEST_LENGTH != data.requestsCount) {
            revert UnexpectedRequestsDataLength();
        }

        if (data.requestsCount > MAX_REQUESTS_PER_REPORT) {
            revert TooManyRequestsInReport(data.requestsCount, MAX_REQUESTS_PER_REPORT);
        }

        (WithdrawalIntent[] memory intents, uint256 totalExitBalanceEth) = _processWithdrawalRequests(data.data);

        IOracleReportSanityChecker(LOCATOR.oracleReportSanityChecker()).checkExitBusOracleReport(
            totalExitBalanceEth
        );

        if (data.requestsCount == 0) {
            return;
        }

        _addWithdrawalIntents(intents);

        TOTAL_REQUESTS_PROCESSED_POSITION.setStorageUint256(
            TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256() + data.requestsCount
        );
    }

    /**
     * @notice Decodes report records into withdrawal request intents and computes the report's
     *         total exit balance for the sanity check
     * @dev Records are processed in the report order, which is the execution priority, so no sorting is checked.
     *      Emits `WithdrawalRequested` for every record.
     * @param data Packed report records, see the data format above
     * @return intents Withdrawal request intents to append to the TriggerableWithdrawalsBus queue, in report order
     * @return totalExitBalanceEth Total exit balance in ETH: a PWR is weighed at its amount (rounded up to ETH
     *         for the whole report), an FWR at the max effective balance for the module's WC type
     */
    function _processWithdrawalRequests(bytes calldata data)
        internal
        returns (WithdrawalIntent[] memory intents, uint256 totalExitBalanceEth)
    {
        uint256 requestsCount = data.length / PACKED_REQUEST_LENGTH;
        intents = new WithdrawalIntent[](requestsCount);

        (uint16 maxEBWeightType1, uint16 maxEBWeightType2) = _getMaxEffectiveBalanceWeights();
        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());
        // Cache modules data to avoid repeated external calls for the same module
        ModuleCache[] memory modules = new ModuleCache[](stakingRouter.getStakingModulesCount());
        uint256 totalPwrGwei;

        for (uint256 i = 0; i < requestsCount; ++i) {
            (uint256 moduleId, uint256 nodeOpId, uint256 keyIndex, uint256 amount) = _decodeRequest(data, i);

            if (moduleId == 0) {
                revert InvalidModuleId();
            }

            ModuleCache memory module =
                _getCachedModule(modules, stakingRouter, moduleId, maxEBWeightType1, maxEBWeightType2);

            bytes memory pubkey = _getKey(module.moduleAddress, nodeOpId, keyIndex);

            if (amount > 0) {
                if (!module.partialWithdrawalsAllowed) revert PartialWithdrawalsNotAllowed(moduleId);
                if (amount > MAX_PWR_AMOUNT_GWEI) revert WithdrawalAmountTooLarge(i, amount);
                totalPwrGwei += amount;
            } else {
                totalExitBalanceEth += module.fwrWeightEth;
            }

            intents[i] = WithdrawalIntent({amount: uint64(amount), pubkey: pubkey});

            emit WithdrawalRequested(moduleId, nodeOpId, pubkey, amount);
        }

        // PWR amounts are summed in gwei and converted to ETH once, rounding up
        totalExitBalanceEth += (totalPwrGwei + 1e9 - 1) / 1e9;
    }

    /**
     * @notice Decodes the record at `index` from the packed report data
     * @param data Packed report records
     * @param index Index of the record
     */
    function _decodeRequest(bytes calldata data, uint256 index)
        internal
        pure
        returns (uint256 moduleId, uint256 nodeOpId, uint256 keyIndex, uint256 amount)
    {
        uint256 record;
        assembly {
            // the record takes the 24 most significant bytes of the loaded 32-byte word
            record := shr(64, calldataload(add(data.offset, mul(index, PACKED_REQUEST_LENGTH))))
        }

        //                                  record (192 bits)
        // MSB <-------------------------------------------------------------------------- LSB
        // | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: keyIndex | 64 bits: amount (gwei) |
        moduleId = record >> 168;
        nodeOpId = uint40(record >> 128);
        keyIndex = uint64(record >> 64);
        amount = uint64(record);
    }

    /**
     * @notice Reads the staking module data needed to process its records
     * @param stakingRouter StakingRouter to read the module config from
     * @param moduleId Staking module ID
     * @param maxEBWeightType1 Max effective balance weight in ETH for 0x01 withdrawal credentials
     * @param maxEBWeightType2 Max effective balance weight in ETH for 0x02 withdrawal credentials
     */
    function _getModuleCache(
        IStakingRouter stakingRouter,
        uint256 moduleId,
        uint16 maxEBWeightType1,
        uint16 maxEBWeightType2
    ) internal view returns (ModuleCache memory module) {
        IStakingRouter.ModuleStateConfig memory config = stakingRouter.getStakingModuleStateConfig(moduleId);

        module.moduleId = moduleId;
        module.moduleAddress = config.moduleAddress;
        module.partialWithdrawalsAllowed = config.partialWithdrawalsAllowed;
        module.fwrWeightEth = _getModuleMaxEBWeight(config.withdrawalCredentialsType, maxEBWeightType1, maxEBWeightType2);
    }

    /**
     * @notice Returns the module data from the cache, reading it from the StakingRouter on the first use
     * @dev Modules are cached from the start of the array, so the first empty cell (zero `moduleId`) ends the search
     * @param modules Cached modules
     * @param stakingRouter StakingRouter to read the module config from
     * @param moduleId Staking module ID
     * @param maxEBWeightType1 Max effective balance weight in ETH for 0x01 withdrawal credentials
     * @param maxEBWeightType2 Max effective balance weight in ETH for 0x02 withdrawal credentials
     */
    function _getCachedModule(
        ModuleCache[] memory modules,
        IStakingRouter stakingRouter,
        uint256 moduleId,
        uint16 maxEBWeightType1,
        uint16 maxEBWeightType2
    ) internal view returns (ModuleCache memory) {
        uint256 i;
        for (; i < modules.length && modules[i].moduleId != 0; ++i) {
            if (modules[i].moduleId == moduleId) return modules[i];
        }
        modules[i] = _getModuleCache(stakingRouter, moduleId, maxEBWeightType1, maxEBWeightType2);
        return modules[i];
    }

    /**
     * @notice Returns the validator pubkey registered in the staking module
     * @param moduleAddress Staking module address
     * @param nodeOpId Node operator ID
     * @param keyIndex Index of the node operator's key in the module
     * @return pubkey Validator public key (48 bytes)
     */
    function _getKey(
        address moduleAddress,
        uint256 nodeOpId,
        uint256 keyIndex
    ) internal view returns (bytes memory pubkey) {
        pubkey = IUnifiedStakingModule(moduleAddress)
            .getSigningKeys(
                nodeOpId,
                keyIndex, // startIndex
                1 // keysCount: get only 1 key
            );

        if (pubkey.length != PUBLIC_KEY_LENGTH) {
            revert InvalidRetrievedKeyLength();
        }
    }

    function _getMaxEffectiveBalanceWeights() internal view returns (uint16 maxEBWeightType1, uint16 maxEBWeightType2) {
        IOracleReportSanityChecker sanityChecker = IOracleReportSanityChecker(LOCATOR.oracleReportSanityChecker());

        uint256 maxEBWeightType1Raw = sanityChecker.getMaxEffectiveBalanceWeightWCType01();
        uint256 maxEBWeightType2Raw = sanityChecker.getMaxEffectiveBalanceWeightWCType02();
        if (
            maxEBWeightType1Raw == 0 || maxEBWeightType2Raw == 0 || maxEBWeightType1Raw > type(uint16).max
                || maxEBWeightType2Raw > type(uint16).max
        ) {
            revert InvalidMaxEBWeight();
        }

        maxEBWeightType1 = maxEBWeightType1Raw.toUint16();
        maxEBWeightType2 = maxEBWeightType2Raw.toUint16();
    }

    function _getModuleMaxEBWeight(
        uint256 wcType,
        uint16 maxEBWeightType1,
        uint16 maxEBWeightType2
    ) internal pure returns (uint16) {
        if (WithdrawalCredentials.isType1(wcType)) {
            return maxEBWeightType1;
        } else if (WithdrawalCredentials.isType2(wcType)) {
            return maxEBWeightType2;
        }
        revert UnexpectedWCType();
    }

    /**
     * @notice Appends withdrawal request intents to the TriggerableWithdrawalsBus queue
     * @param intents Withdrawal request intents, in report order
     */
    function _addWithdrawalIntents(WithdrawalIntent[] memory intents) internal {
        ITriggerableWithdrawalsBus(LOCATOR.triggerableWithdrawalsBus()).addWithdrawalIntents(intents);
    }

    ///
    /// Storage helpers
    ///

    /// @dev Moves the counter to the new slot and clears the old one
    function _migrateTotalRequestsProcessed() internal {
        TOTAL_REQUESTS_PROCESSED_POSITION.setStorageUint256(
            DEPRECATED_TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256()
        );
        DEPRECATED_TOTAL_REQUESTS_PROCESSED_POSITION.setStorageUint256(0);
    }

    /// @dev LimitData and DataProcessingState each pack into a single slot, so zeroing the slot clears the whole struct
    function _clearDeprecatedSlots() internal {
        DEPRECATED_EXIT_BALANCE_LIMIT_POSITION.setStorageUint256(0);
        DEPRECATED_MAX_VALIDATORS_PER_REPORT_POSITION.setStorageUint256(0);
        DEPRECATED_DATA_PROCESSING_STATE_POSITION.setStorageUint256(0);
    }
}
