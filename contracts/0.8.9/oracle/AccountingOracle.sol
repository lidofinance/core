// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import { ILidoLocator } from "../../common/interfaces/ILidoLocator.sol";
import { UnstructuredStorage } from "../lib/UnstructuredStorage.sol";

import { BaseOracle, IConsensusContract } from "./BaseOracle.sol";


interface ILido {
    function handleOracleReport(
        // Oracle timings
        uint256 _currentReportTimestamp,
        uint256 _timeElapsedSeconds,
        // CL values
        uint256 _clValidators,
        uint256 _clBalance,
        // EL values
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        // Decision about withdrawals processing
        uint256[] calldata _withdrawalFinalizationBatches,
        uint256 _simulatedShareRate
    ) external;
}


interface ILegacyOracle {
    // only called before the migration

    function getBeaconSpec() external view returns (
        uint64 epochsPerFrame,
        uint64 slotsPerEpoch,
        uint64 secondsPerSlot,
        uint64 genesisTime
    );

    function getLastCompletedEpochId() external view returns (uint256);

    // only called after the migration

    function handleConsensusLayerReport(
        uint256 refSlot,
        uint256 clBalance,
        uint256 clValidators
    ) external;
}

interface IOracleReportSanityChecker {
    function checkExitedValidatorsRatePerDay(uint256 _exitedValidatorsCount) external view;
    function checkExtraDataItemsCountPerTransaction(uint256 _extraDataListItemsCount) external view;
    function checkNodeOperatorsPerExtraDataItemCount(uint256 _itemIndex, uint256 _nodeOperatorsCount) external view;
}

interface IStakingRouter {
    function updateExitedValidatorsCountByStakingModule(
        uint256[] calldata moduleIds,
        uint256[] calldata exitedValidatorsCounts
    ) external returns (uint256);

    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 stakingModuleId,
        bytes calldata nodeOperatorIds,
        bytes calldata exitedValidatorsCounts
    ) external;

    function onValidatorsCountsByNodeOperatorReportingFinished() external;
}


interface IWithdrawalQueue {
    function onOracleReport(bool isBunkerMode, uint256 prevReportTimestamp, uint256 currentReportTimestamp) external;
}


contract AccountingOracle is BaseOracle {
    using UnstructuredStorage for bytes32;
    using SafeCast for uint256;

    error LidoLocatorCannotBeZero();
    error AdminCannotBeZero();
    error LegacyOracleCannotBeZero();
    error LidoCannotBeZero();
    error IncorrectOracleMigration(uint256 code);
    error SenderNotAllowed();
    error InvalidExitedValidatorsData();
    error UnsupportedExtraDataFormat(uint256 format);
    error UnsupportedExtraDataType(uint256 itemIndex, uint256 dataType);
    error DeprecatedExtraDataType(uint256 itemIndex, uint256 dataType);
    error CannotSubmitExtraDataBeforeMainData();
    error ExtraDataAlreadyProcessed();
    error UnexpectedExtraDataHash(bytes32 consensusHash, bytes32 receivedHash);
    error UnexpectedExtraDataFormat(uint256 expectedFormat, uint256 receivedFormat);
    error ExtraDataItemsCountCannotBeZeroForNonEmptyData();
    error ExtraDataHashCannotBeZeroForNonEmptyData();
    error UnexpectedExtraDataItemsCount(uint256 expectedCount, uint256 receivedCount);
    error UnexpectedExtraDataIndex(uint256 expectedIndex, uint256 receivedIndex);
    error InvalidExtraDataItem(uint256 itemIndex);
    error InvalidExtraDataSortOrder(uint256 itemIndex);

    event ExtraDataSubmitted(uint256 indexed refSlot, uint256 itemsProcessed, uint256 itemsCount);

    event WarnExtraDataIncompleteProcessing(
        uint256 indexed refSlot,
        uint256 processedItemsCount,
        uint256 itemsCount
    );

    struct ExtraDataProcessingState {
        uint64 refSlot;
        uint16 dataFormat;
        bool submitted;
        uint64 itemsCount;
        uint64 itemsProcessed;
        uint256 lastSortingKey;
        bytes32 dataHash;
    }

    /// @notice An ACL role granting the permission to submit the data for a committee report.
    bytes32 public constant SUBMIT_DATA_ROLE = keccak256("SUBMIT_DATA_ROLE");

    /// @dev Storage slot: ExtraDataProcessingState state
    bytes32 internal constant EXTRA_DATA_PROCESSING_STATE_POSITION =
        keccak256("lido.AccountingOracle.extraDataProcessingState");

    bytes32 internal constant ZERO_BYTES32 = bytes32(0);

    address public immutable LIDO;
    ILidoLocator public immutable LOCATOR;
    address public immutable LEGACY_ORACLE;

    ///
    /// Initialization & admin functions
    ///

    constructor(
        address lidoLocator,
        address lido,
        address legacyOracle,
        uint256 secondsPerSlot,
        uint256 genesisTime
    )
        BaseOracle(secondsPerSlot, genesisTime)
    {
        if (lidoLocator == address(0)) revert LidoLocatorCannotBeZero();
        if (legacyOracle == address(0)) revert LegacyOracleCannotBeZero();
        if (lido == address(0)) revert LidoCannotBeZero();
        LOCATOR = ILidoLocator(lidoLocator);
        LIDO = lido;
        LEGACY_ORACLE = legacyOracle;
    }

    function initialize(
        address admin,
        address consensusContract,
        uint256 consensusVersion
    ) external {
        if (admin == address(0)) revert AdminCannotBeZero();

        uint256 lastProcessingRefSlot = _checkOracleMigration(LEGACY_ORACLE, consensusContract);
        _initialize(admin, consensusContract, consensusVersion, lastProcessingRefSlot);

        _updateContractVersion(2);
    }

    function initializeWithoutMigration(
        address admin,
        address consensusContract,
        uint256 consensusVersion,
        uint256 lastProcessingRefSlot
    ) external {
        if (admin == address(0)) revert AdminCannotBeZero();

        _initialize(admin, consensusContract, consensusVersion, lastProcessingRefSlot);

        _updateContractVersion(2);
    }

    function finalizeUpgrade_v2(uint256 consensusVersion) external {
        _updateContractVersion(2);
        _setConsensusVersion(consensusVersion);
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
        /// CL values
        ///

        /// @dev The number of validators on consensus layer that were ever deposited
        /// via Lido as observed at the reference slot.
        uint256 numValidators;

        /// @dev Cumulative balance of all Lido validators on the consensus layer
        /// as observed at the reference slot.
        uint256 clBalanceGwei;

        /// @dev Ids of staking modules that have more exited validators than the number
        /// stored in the respective staking module contract as observed at the reference
        /// slot.
        uint256[] stakingModuleIdsWithNewlyExitedValidators;

        /// @dev Number of ever exited validators for each of the staking modules from
        /// the stakingModuleIdsWithNewlyExitedValidators array as observed at the
        /// reference slot.
        uint256[] numExitedValidatorsByStakingModule;

        ///
        /// EL values
        ///

        /// @dev The ETH balance of the Lido withdrawal vault as observed at the reference slot.
        uint256 withdrawalVaultBalance;

        /// @dev The ETH balance of the Lido execution layer rewards vault as observed
        /// at the reference slot.
        uint256 elRewardsVaultBalance;

        /// @dev The shares amount requested to burn through Burner as observed
        /// at the reference slot. The value can be obtained in the following way:
        /// `(coverSharesToBurn, nonCoverSharesToBurn) = IBurner(burner).getSharesRequestedToBurn()
        /// sharesRequestedToBurn = coverSharesToBurn + nonCoverSharesToBurn`
        uint256 sharesRequestedToBurn;

        ///
        /// Decision
        ///

        /// @dev The ascendingly-sorted array of withdrawal request IDs obtained by calling
        /// WithdrawalQueue.calculateFinalizationBatches. Empty array means that no withdrawal
        /// requests should be finalized.
        uint256[] withdrawalFinalizationBatches;

        /// @dev The share/ETH rate with the 10^27 precision (i.e. the price of one stETH share
        /// in ETH where one ETH is denominated as 10^27) that would be effective as the result of
        /// applying this oracle report at the reference slot, with withdrawalFinalizationBatches
        /// set to empty array and simulatedShareRate set to 0.
        uint256 simulatedShareRate;

        /// @dev Whether, based on the state observed at the reference slot, the protocol should
        /// be in the bunker mode.
        bool isBunkerMode;

        ///
        /// Extra data — the oracle information that allows asynchronous processing in
        /// chunks, after the main data is processed. The oracle doesn't enforce that extra data
        /// attached to some data report is processed in full before the processing deadline expires
        /// or a new data report starts being processed, but enforces that no processing of extra
        /// data for a report is possible after its processing deadline passes or a new data report
        /// arrives.
        ///
        /// Extra data is an array of items, each item being encoded as follows:
        ///
        ///    3 bytes    2 bytes      X bytes
        /// | itemIndex | itemType | itemPayload |
        ///
        /// itemIndex is a 0-based index into the extra data array;
        /// itemType is the type of extra data item;
        /// itemPayload is the item's data which interpretation depends on the item's type.
        ///
        /// Items should be sorted ascendingly by the (itemType, ...itemSortingKey) compound key
        /// where `itemSortingKey` calculation depends on the item's type (see below).
        ///
        /// ----------------------------------------------------------------------------------------
        ///
        /// itemType=0 (EXTRA_DATA_TYPE_STUCK_VALIDATORS): stuck validators by node operators.
        /// itemPayload format:
        ///
        /// | 3 bytes  |   8 bytes    |  nodeOpsCount * 8 bytes  |  nodeOpsCount * 16 bytes  |
        /// | moduleId | nodeOpsCount |      nodeOperatorIds     |   stuckValidatorsCounts   |
        ///
        /// moduleId is the staking module for which exited keys counts are being reported.
        ///
        /// nodeOperatorIds contains an array of ids of node operators that have total stuck
        /// validators counts changed compared to the staking module smart contract storage as
        /// observed at the reference slot. Each id is a 8-byte uint, ids are packed tightly.
        ///
        /// nodeOpsCount contains the number of node operator ids contained in the nodeOperatorIds
        /// array. Thus, nodeOpsCount = byteLength(nodeOperatorIds) / 8.
        ///
        /// stuckValidatorsCounts contains an array of stuck validators total counts, as observed at
        /// the reference slot, for the node operators from the nodeOperatorIds array, in the same
        /// order. Each count is a 16-byte uint, counts are packed tightly. Thus,
        /// byteLength(stuckValidatorsCounts) = nodeOpsCount * 16.
        ///
        /// nodeOpsCount must not be greater than maxNodeOperatorsPerExtraDataItem specified
        /// in OracleReportSanityChecker contract. If a staking module has more node operators
        /// with total stuck validators counts changed compared to the staking module smart contract
        /// storage (as observed at the reference slot), reporting for that module should be split
        /// into multiple items.
        ///
        /// Item sorting key is a compound key consisting of the module id and the first reported
        /// node operator's id:
        ///
        /// itemSortingKey = (moduleId, nodeOperatorIds[0:8])
        ///
        /// ----------------------------------------------------------------------------------------
        ///
        /// itemType=1 (EXTRA_DATA_TYPE_EXITED_VALIDATORS): exited validators by node operators.
        ///
        /// The payload format is exactly the same as for itemType=EXTRA_DATA_TYPE_STUCK_VALIDATORS,
        /// except that, instead of stuck validators counts, exited validators counts are reported.
        /// The `itemSortingKey` is calculated identically.
        ///
        /// ----------------------------------------------------------------------------------------
        ///
        /// The oracle daemon should report exited/stuck validators counts ONLY for those
        /// (moduleId, nodeOperatorId) pairs that contain outdated counts in the staking
        /// module smart contract as observed at the reference slot.
        ///
        /// Extra data array can be passed in different formats, see below.
        ///

        /// @dev Format of the extra data.
        ///
        /// Currently, only the EXTRA_DATA_FORMAT_EMPTY=0 and EXTRA_DATA_FORMAT_LIST=1
        /// formats are supported. See the constant defining a specific data format for
        /// more info.
        ///
        uint256 extraDataFormat;

        /// @dev Hash of the extra data. See the constant defining a specific extra data
        /// format for the info on how to calculate the hash.
        ///
        bytes32 extraDataHash;

        /// @dev Number of the extra data items.
        ///
        /// Must be set to zero if the oracle report contains no extra data.
        ///
        uint256 extraDataItemsCount;
    }

    uint256 public constant EXTRA_DATA_TYPE_STUCK_VALIDATORS = 1;
    uint256 public constant EXTRA_DATA_TYPE_EXITED_VALIDATORS = 2;

    /// @notice The extra data format used to signify that the oracle report contains no extra data.
    ///
    /// The `extraDataHash` in `ReportData` must be set to a `ZERO_BYTES32`
    ///
    uint256 public constant EXTRA_DATA_FORMAT_EMPTY = 0;

    /// @notice The list format for the extra data array. Used when the oracle reports contains extra data.
    ///
    /// When extra data is included in a report, it may be split across one or more transactions.
    /// Each transaction contains:
    ///   1) A 32-byte keccak256 hash of the next transaction's data (or `ZERO_BYTES32` if none),
    ///   2) A chunk of report items (an array of items).
    ///
    /// |                   32 bytes                       |     X bytes      |
    /// |  Next transaction's data hash or `ZERO_BYTES32`  |  array of items  |
    ///
    /// The `extraDataHash` in `ReportData` is calculated as shown in the example below:
    ///
    /// ReportData.extraDataHash := hash0
    /// hash0 := keccak256(| hash1 | extraData[0], ... extraData[n] |)
    /// hash1 := keccak256(| hash2 | extraData[n + 1], ... extraData[m] |)
    /// ...
    /// hashK := keccak256(| ZERO_BYTES32 | extraData[x + 1], ... extraData[extraDataItemsCount] |)
    ///
    uint256 public constant EXTRA_DATA_FORMAT_LIST = 1;

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
    ///
    function submitReportData(ReportData calldata data, uint256 contractVersion) external {
        _checkMsgSenderIsAllowedToSubmitData();
        _checkContractVersion(contractVersion);
        _checkConsensusData(data.refSlot, data.consensusVersion, keccak256(abi.encode(data)));
        uint256 prevRefSlot = _startProcessing();
        _handleConsensusReportData(data, prevRefSlot);
    }

    /// @notice Triggers the processing required when no extra data is present in the report,
    /// i.e. when extra data format equals EXTRA_DATA_FORMAT_EMPTY.
    ///
    function submitReportExtraDataEmpty() external {
        _submitReportExtraDataEmpty();
    }

    /// @notice Submits report extra data in the EXTRA_DATA_FORMAT_LIST format for processing.
    ///
    /// @param data  The extra data chunk. See docs for the `EXTRA_DATA_FORMAT_LIST`
    ///              constant for details.
    ///
    function submitReportExtraDataList(bytes calldata data) external {
        _submitReportExtraDataList(data);
    }

    struct ProcessingState {
        /// @notice Reference slot for the current reporting frame.
        uint256 currentFrameRefSlot;
        /// @notice The last time at which a data can be submitted for the current reporting frame.
        uint256 processingDeadlineTime;
        /// @notice Hash of the main report data. Zero bytes if consensus on the hash hasn't been
        /// reached yet for the current reporting frame.
        bytes32 mainDataHash;
        /// @notice Whether the main report data for the current reporting frame has already been
        /// submitted.
        bool mainDataSubmitted;
        /// @notice Hash of the extra report data. Should be ignored unless `mainDataSubmitted`
        /// is true.
        bytes32 extraDataHash;
        /// @notice Format of the extra report data for the current reporting frame. Should be
        /// ignored unless `mainDataSubmitted` is true.
        uint256 extraDataFormat;
        /// @notice Whether any extra report data for the current reporting frame has been submitted.
        bool extraDataSubmitted;
        /// @notice Total number of extra report data items for the current reporting frame.
        /// Should be ignored unless `mainDataSubmitted` is true.
        uint256 extraDataItemsCount;
        /// @notice How many extra report data items are already submitted for the current
        /// reporting frame.
        uint256 extraDataItemsSubmitted;
    }

    /// @notice Returns data processing state for the current reporting frame.
    /// @return result See the docs for the `ProcessingState` struct.
    ///
    function getProcessingState() external view returns (ProcessingState memory result) {
        ConsensusReport memory report = _storageConsensusReport().value;
        result.currentFrameRefSlot = _getCurrentRefSlot();

        if (report.hash == ZERO_BYTES32 || result.currentFrameRefSlot != report.refSlot) {
            return result;
        }

        result.processingDeadlineTime = report.processingDeadlineTime;
        result.mainDataHash = report.hash;

        uint256 processingRefSlot = LAST_PROCESSING_REF_SLOT_POSITION.getStorageUint256();
        result.mainDataSubmitted = report.refSlot == processingRefSlot;
        if (!result.mainDataSubmitted) {
            return result;
        }

        ExtraDataProcessingState memory extraState = _storageExtraDataProcessingState().value;
        result.extraDataHash = extraState.dataHash;
        result.extraDataFormat = extraState.dataFormat;
        result.extraDataSubmitted = extraState.submitted;
        result.extraDataItemsCount = extraState.itemsCount;
        result.extraDataItemsSubmitted = extraState.itemsProcessed;
    }

    ///
    /// Implementation & helpers
    ///

    /// @dev Returns last processed reference slot of the legacy oracle.
    ///
    /// Old oracle didn't specify what slot use as a reference one, but actually
    /// used the first slot of the first frame's epoch. The new oracle uses the
    /// last slot of the previous frame's last epoch as a reference one.
    ///
    /// Oracle migration scheme:
    ///
    /// last old frame    <--------->
    /// old frames       |r  .   .   |
    /// new frames                  r|   .   .  r|   .   .  r|
    /// first new frame               <--------->
    /// events            0  1  2   3  4
    /// time ------------------------------------------------>
    ///
    /// 0. last reference slot of legacy oracle
    /// 1. last legacy oracle's consensus report arrives
    /// 2. new oracle is deployed and enabled, legacy oracle is disabled and upgraded to
    ///    the compatibility implementation
    /// 3. first reference slot of the new oracle
    /// 4. first new oracle's consensus report arrives
    ///
    function _checkOracleMigration(
        address legacyOracle,
        address consensusContract
    )
        internal view returns (uint256)
    {
        (uint256 initialEpoch,
            uint256 epochsPerFrame) = IConsensusContract(consensusContract).getFrameConfig();

        (uint256 slotsPerEpoch,
            uint256 secondsPerSlot,
            uint256 genesisTime) = IConsensusContract(consensusContract).getChainConfig();

        {
            // check chain spec to match the prev. one (a block is used to reduce stack allocation)
            (uint256 legacyEpochsPerFrame,
                uint256 legacySlotsPerEpoch,
                uint256 legacySecondsPerSlot,
                uint256 legacyGenesisTime) = ILegacyOracle(legacyOracle).getBeaconSpec();
            if (slotsPerEpoch != legacySlotsPerEpoch ||
                secondsPerSlot != legacySecondsPerSlot ||
                genesisTime != legacyGenesisTime
            ) {
                revert IncorrectOracleMigration(0);
            }
            if (epochsPerFrame != legacyEpochsPerFrame) {
                revert IncorrectOracleMigration(1);
            }
        }

        uint256 legacyProcessedEpoch = ILegacyOracle(legacyOracle).getLastCompletedEpochId();
        if (initialEpoch != legacyProcessedEpoch + epochsPerFrame) {
            revert IncorrectOracleMigration(2);
        }

        // last processing ref. slot of the new oracle should be set to the last processed
        // ref. slot of the legacy oracle, i.e. the first slot of the last processed epoch
        return legacyProcessedEpoch * slotsPerEpoch;
    }

    function _initialize(
        address admin,
        address consensusContract,
        uint256 consensusVersion,
        uint256 lastProcessingRefSlot
    ) internal {
        _setupRole(DEFAULT_ADMIN_ROLE, admin);

        BaseOracle._initialize(consensusContract, consensusVersion, lastProcessingRefSlot);
    }

    function _handleConsensusReport(
        ConsensusReport memory /* report */,
        uint256 /* prevSubmittedRefSlot */,
        uint256 prevProcessingRefSlot
    ) internal override {
        ExtraDataProcessingState memory state = _storageExtraDataProcessingState().value;
        if (state.refSlot == prevProcessingRefSlot && (
            !state.submitted || state.itemsProcessed < state.itemsCount
        )) {
            emit WarnExtraDataIncompleteProcessing(
                prevProcessingRefSlot,
                state.itemsProcessed,
                state.itemsCount
            );
        }
    }

    function _checkMsgSenderIsAllowedToSubmitData() internal view {
        address sender = _msgSender();
        if (!hasRole(SUBMIT_DATA_ROLE, sender) && !_isConsensusMember(sender)) {
            revert SenderNotAllowed();
        }
    }

    function _handleConsensusReportData(ReportData calldata data, uint256 prevRefSlot) internal {
        if (data.extraDataFormat == EXTRA_DATA_FORMAT_EMPTY) {
            if (data.extraDataHash != ZERO_BYTES32) {
                revert UnexpectedExtraDataHash(ZERO_BYTES32, data.extraDataHash);
            }
            if (data.extraDataItemsCount != 0) {
                revert UnexpectedExtraDataItemsCount(0, data.extraDataItemsCount);
            }
        } else {
            if (data.extraDataFormat != EXTRA_DATA_FORMAT_LIST) {
                revert UnsupportedExtraDataFormat(data.extraDataFormat);
            }
            if (data.extraDataItemsCount == 0) {
                revert ExtraDataItemsCountCannotBeZeroForNonEmptyData();
            }
            if (data.extraDataHash == ZERO_BYTES32) {
                revert ExtraDataHashCannotBeZeroForNonEmptyData();
            }
        }

        ILegacyOracle(LEGACY_ORACLE).handleConsensusLayerReport(
            data.refSlot,
            data.clBalanceGwei * 1e9,
            data.numValidators
        );

        uint256 slotsElapsed = data.refSlot - prevRefSlot;

        IStakingRouter stakingRouter = IStakingRouter(LOCATOR.stakingRouter());
        IWithdrawalQueue withdrawalQueue = IWithdrawalQueue(LOCATOR.withdrawalQueue());

        _processStakingRouterExitedValidatorsByModule(
            stakingRouter,
            data.stakingModuleIdsWithNewlyExitedValidators,
            data.numExitedValidatorsByStakingModule,
            slotsElapsed
        );

        withdrawalQueue.onOracleReport(
            data.isBunkerMode,
            GENESIS_TIME + prevRefSlot * SECONDS_PER_SLOT,
            GENESIS_TIME + data.refSlot * SECONDS_PER_SLOT
        );

        ILido(LIDO).handleOracleReport(
            GENESIS_TIME + data.refSlot * SECONDS_PER_SLOT,
            slotsElapsed * SECONDS_PER_SLOT,
            data.numValidators,
            data.clBalanceGwei * 1e9,
            data.withdrawalVaultBalance,
            data.elRewardsVaultBalance,
            data.sharesRequestedToBurn,
            data.withdrawalFinalizationBatches,
            data.simulatedShareRate
        );

        _storageExtraDataProcessingState().value = ExtraDataProcessingState({
            refSlot: data.refSlot.toUint64(),
            dataFormat: data.extraDataFormat.toUint16(),
            submitted: false,
            dataHash: data.extraDataHash,
            itemsCount: data.extraDataItemsCount.toUint16(),
            itemsProcessed: 0,
            lastSortingKey: 0
        });
    }

    function _processStakingRouterExitedValidatorsByModule(
        IStakingRouter stakingRouter,
        uint256[] calldata stakingModuleIds,
        uint256[] calldata numExitedValidatorsByStakingModule,
        uint256 slotsElapsed
    ) internal {
        if (stakingModuleIds.length != numExitedValidatorsByStakingModule.length) {
            revert InvalidExitedValidatorsData();
        }

        if (stakingModuleIds.length == 0) {
            return;
        }

        for (uint256 i = 1; i < stakingModuleIds.length;) {
            if (stakingModuleIds[i] <= stakingModuleIds[i - 1]) {
                revert InvalidExitedValidatorsData();
            }
            unchecked { ++i; }
        }

        for (uint256 i = 0; i < stakingModuleIds.length;) {
            if (numExitedValidatorsByStakingModule[i] == 0) {
                revert InvalidExitedValidatorsData();
            }
            unchecked { ++i; }
        }

        uint256 newlyExitedValidatorsCount = stakingRouter.updateExitedValidatorsCountByStakingModule(
            stakingModuleIds,
            numExitedValidatorsByStakingModule
        );

        uint256 exitedValidatorsRatePerDay =
            newlyExitedValidatorsCount * (1 days) /
            (SECONDS_PER_SLOT * slotsElapsed);

        IOracleReportSanityChecker(LOCATOR.oracleReportSanityChecker())
            .checkExitedValidatorsRatePerDay(exitedValidatorsRatePerDay);
    }

    function _submitReportExtraDataEmpty() internal {
        ExtraDataProcessingState memory procState = _storageExtraDataProcessingState().value;
        _checkCanSubmitExtraData(procState, EXTRA_DATA_FORMAT_EMPTY);
        if (procState.submitted) revert ExtraDataAlreadyProcessed();

        IStakingRouter(LOCATOR.stakingRouter()).onValidatorsCountsByNodeOperatorReportingFinished();
        _storageExtraDataProcessingState().value.submitted = true;
        emit ExtraDataSubmitted(procState.refSlot, 0, 0);
    }

    function _checkCanSubmitExtraData(ExtraDataProcessingState memory procState, uint256 format)
        internal view
    {
        _checkMsgSenderIsAllowedToSubmitData();

        ConsensusReport memory report = _storageConsensusReport().value;

        if (report.hash == ZERO_BYTES32 || procState.refSlot != report.refSlot) {
            revert CannotSubmitExtraDataBeforeMainData();
        }

        _checkProcessingDeadline();

        if (procState.dataFormat != format) {
            revert UnexpectedExtraDataFormat(procState.dataFormat, format);
        }
    }

    struct ExtraDataIterState {
        uint256 index;
        uint256 itemType;
        uint256 dataOffset;
        uint256 lastSortingKey;
        // config
        address stakingRouter;
    }

    function _submitReportExtraDataList(bytes calldata data) internal {
        ExtraDataProcessingState memory procState = _storageExtraDataProcessingState().value;
        _checkCanSubmitExtraData(procState, EXTRA_DATA_FORMAT_LIST);

        if (procState.itemsProcessed == procState.itemsCount) {
            revert ExtraDataAlreadyProcessed();
        }

        bytes32 dataHash = keccak256(data);
        if (dataHash != procState.dataHash) {
            revert UnexpectedExtraDataHash(procState.dataHash, dataHash);
        }

        // load the next hash value
        assembly {
            dataHash := calldataload(data.offset)
        }

        ExtraDataIterState memory iter = ExtraDataIterState({
            index: procState.itemsProcessed > 0 ? procState.itemsProcessed - 1 : 0,
            itemType: 0,
            dataOffset: 32, // skip the next hash bytes
            lastSortingKey: procState.lastSortingKey,
            stakingRouter: LOCATOR.stakingRouter()
        });

        _processExtraDataItems(data, iter);
        uint256 itemsProcessed = iter.index + 1;

        if (dataHash == ZERO_BYTES32) {
            if (itemsProcessed != procState.itemsCount) {
                revert UnexpectedExtraDataItemsCount(procState.itemsCount, itemsProcessed);
            }

            procState.submitted = true;
            procState.itemsProcessed = uint64(itemsProcessed);
            procState.lastSortingKey = iter.lastSortingKey;
            _storageExtraDataProcessingState().value = procState;

            IStakingRouter(iter.stakingRouter).onValidatorsCountsByNodeOperatorReportingFinished();
        } else {
            if (itemsProcessed >= procState.itemsCount) {
                revert UnexpectedExtraDataItemsCount(procState.itemsCount, itemsProcessed);
            }

            // save the next hash value
            procState.dataHash = dataHash;
            procState.itemsProcessed = uint64(itemsProcessed);
            procState.lastSortingKey = iter.lastSortingKey;
             _storageExtraDataProcessingState().value = procState;
        }

        emit ExtraDataSubmitted(procState.refSlot, procState.itemsProcessed, procState.itemsCount);
    }

    function _processExtraDataItems(bytes calldata data, ExtraDataIterState memory iter) internal {
        uint256 dataOffset = iter.dataOffset;
        uint256 maxNodeOperatorsPerItem = 0;
        uint256 maxNodeOperatorItemIndex = 0;
        uint256 itemsCount;
        uint256 index;
        uint256 itemType;

        while (dataOffset < data.length) {
            /// @solidity memory-safe-assembly
            assembly {
                // layout at the dataOffset:
                // |  3 bytes  | 2 bytes  |   X bytes   |
                // | itemIndex | itemType | itemPayload |
                let header := calldataload(add(data.offset, dataOffset))
                index := shr(232, header)
                itemType := and(shr(216, header), 0xffff)
                dataOffset := add(dataOffset, 5)
            }

            if (iter.lastSortingKey == 0) {
                if (index != 0) {
                    revert UnexpectedExtraDataIndex(0, index);
                }
            } else if (index != iter.index + 1) {
                revert UnexpectedExtraDataIndex(iter.index + 1, index);
            }

            iter.index = index;
            iter.itemType = itemType;
            iter.dataOffset = dataOffset;

            /// @dev The EXTRA_DATA_TYPE_STUCK_VALIDATORS item type was deprecated in the Triggerable Withdrawals update.
            ///      The mechanism for handling stuck validator keys is no longer supported and has been removed.
            if (itemType == EXTRA_DATA_TYPE_STUCK_VALIDATORS) {
                revert DeprecatedExtraDataType(index, itemType);
            }

            if (itemType != EXTRA_DATA_TYPE_EXITED_VALIDATORS) {
                revert UnsupportedExtraDataType(index, itemType);
            }

            uint256 nodeOpsProcessed = _processExtraDataItem(data, iter);

            if (nodeOpsProcessed > maxNodeOperatorsPerItem) {
                maxNodeOperatorsPerItem = nodeOpsProcessed;
                maxNodeOperatorItemIndex = index;
            }

            assert(iter.dataOffset > dataOffset);
            dataOffset = iter.dataOffset;
            unchecked {
                // overflow is not possible here
                ++itemsCount;
            }
        }

        assert(maxNodeOperatorsPerItem > 0);

        IOracleReportSanityChecker(LOCATOR.oracleReportSanityChecker())
            .checkExtraDataItemsCountPerTransaction(itemsCount);

        IOracleReportSanityChecker(LOCATOR.oracleReportSanityChecker())
            .checkNodeOperatorsPerExtraDataItemCount(maxNodeOperatorItemIndex, maxNodeOperatorsPerItem);
    }

    function _processExtraDataItem(bytes calldata data, ExtraDataIterState memory iter) internal returns (uint256) {
        uint256 dataOffset = iter.dataOffset;
        uint256 moduleId;
        uint256 nodeOpsCount;
        uint256 nodeOpId;
        bytes calldata nodeOpIds;
        bytes calldata valuesCounts;

        if (dataOffset + 35 > data.length) {
            // has to fit at least moduleId (3 bytes), nodeOpsCount (8 bytes),
            // and data for one node operator (8 + 16 bytes), total 35 bytes
            revert InvalidExtraDataItem(iter.index);
        }

        /// @solidity memory-safe-assembly
        assembly {
            // layout at the dataOffset:
            // | 3 bytes  |   8 bytes    |  nodeOpsCount * 8 bytes  |  nodeOpsCount * 16 bytes  |
            // | moduleId | nodeOpsCount |      nodeOperatorIds     |      validatorsCounts     |
            let header := calldataload(add(data.offset, dataOffset))
            moduleId := shr(232, header)
            nodeOpsCount := and(shr(168, header), 0xffffffffffffffff)
            nodeOpIds.offset := add(data.offset, add(dataOffset, 11))
            nodeOpIds.length := mul(nodeOpsCount, 8)
            // read the 1st node operator id for checking the sorting order later
            nodeOpId := shr(192, calldataload(nodeOpIds.offset))
            valuesCounts.offset := add(nodeOpIds.offset, nodeOpIds.length)
            valuesCounts.length := mul(nodeOpsCount, 16)
            dataOffset := sub(add(valuesCounts.offset, valuesCounts.length), data.offset)
        }

        if (moduleId == 0) {
            revert InvalidExtraDataItem(iter.index);
        }

        unchecked {
            // firstly, check the sorting order between the 1st item's element and the last one of the previous item

            // | 2 bytes  | 19 bytes | 3 bytes  | 8 bytes  |
            // | itemType | 00000000 | moduleId | nodeOpId |
            uint256 sortingKey = (iter.itemType << 240) | (moduleId << 64) | nodeOpId;
            if (sortingKey <= iter.lastSortingKey) {
                revert InvalidExtraDataSortOrder(iter.index);
            }

            // secondly, check the sorting order between the rest of the elements
            uint256 tmpNodeOpId;
            for (uint256 i = 1; i < nodeOpsCount;) {
                /// @solidity memory-safe-assembly
                assembly {
                    tmpNodeOpId := shr(192, calldataload(add(nodeOpIds.offset, mul(i, 8))))
                    i := add(i, 1)
                }
                if (tmpNodeOpId <= nodeOpId) {
                    revert InvalidExtraDataSortOrder(iter.index);
                }
                nodeOpId = tmpNodeOpId;
            }

            // update the last sorting key with the last item's element
            iter.lastSortingKey = ((sortingKey >> 64) << 64) | nodeOpId;
        }

        if (dataOffset > data.length || nodeOpsCount == 0) {
            revert InvalidExtraDataItem(iter.index);
        }

        IStakingRouter(iter.stakingRouter)
                .reportStakingModuleExitedValidatorsCountByNodeOperator(moduleId, nodeOpIds, valuesCounts);

        iter.dataOffset = dataOffset;
        return nodeOpsCount;
    }

    ///
    /// Storage helpers
    ///

    struct StorageExtraDataProcessingState {
        ExtraDataProcessingState value;
    }

    function _storageExtraDataProcessingState()
        internal pure returns (StorageExtraDataProcessingState storage r)
    {
        bytes32 position = EXTRA_DATA_PROCESSING_STATE_POSITION;
        assembly { r.slot := position }
    }
}
