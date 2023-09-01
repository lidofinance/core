// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import { Math } from "../lib/Math.sol";
import { AccessControlEnumerable } from "../utils/access/AccessControlEnumerable.sol";


/// @notice A contract that gets consensus reports (i.e. hashes) pushed to and processes them
/// asynchronously.
///
/// HashConsensus doesn't expect any specific behavior from a report processor, and guarantees
/// the following:
///
/// 1. HashConsensus won't submit reports via `IReportAsyncProcessor.submitConsensusReport` or ask
///    to discard reports via `IReportAsyncProcessor.discardConsensusReport` for any slot up to (and
///    including) the slot returned from `IReportAsyncProcessor.getLastProcessingRefSlot`.
///
/// 2. HashConsensus won't accept member reports (and thus won't include such reports in calculating
///    the consensus) that have `consensusVersion` argument of the `HashConsensus.submitReport` call
///    holding a diff. value than the one returned from `IReportAsyncProcessor.getConsensusVersion()`
///    at the moment of the `HashConsensus.submitReport` call.
///
interface IReportAsyncProcessor {
    /// @notice Submits a consensus report for processing.
    ///
    /// Note that submitting the report doesn't require the processor to start processing it right
    /// away, this can happen later (see `getLastProcessingRefSlot`). Until processing is started,
    /// HashConsensus is free to reach consensus on another report for the same reporting frame an
    /// submit it using this same function, or to lose the consensus on the submitted report,
    /// notifying the processor via `discardConsensusReport`.
    ///
    function submitConsensusReport(bytes32 report, uint256 refSlot, uint256 deadline) external;

    /// @notice Notifies that the report for the given ref. slot is not a conensus report anymore
    /// and should be discarded. This can happen when a member changes their report, is removed
    /// from the set, or when the quorum value gets increased.
    ///
    /// Only called when, for the given reference slot:
    ///
    ///   1. there previously was a consensus report; AND
    ///   1. processing of the consensus report hasn't started yet; AND
    ///   2. report processing deadline is not expired yet; AND
    ///   3. there's no consensus report now (otherwise, `submitConsensusReport` is called instead).
    ///
    /// Can be called even when there's no submitted non-discarded consensus report for the current
    /// reference slot, i.e. can be called multiple times in succession.
    ///
    function discardConsensusReport(uint256 refSlot) external;

    /// @notice Returns the last reference slot for which processing of the report was started.
    ///
    /// HashConsensus won't submit reports for any slot less than or equal to this slot.
    ///
    function getLastProcessingRefSlot() external view returns (uint256);

    /// @notice Returns the current consensus version.
    ///
    /// Consensus version must change every time consensus rules change, meaning that
    /// an oracle looking at the same reference slot would calculate a different hash.
    ///
    /// HashConsensus won't accept member reports any consensus version different form the
    /// one returned from this function.
    ///
    function getConsensusVersion() external view returns (uint256);
}


/// @notice A contract managing oracle members committee and allowing the members to reach
/// consensus on a hash for each reporting frame.
///
/// Time is divided in frames of equal length, each having reference slot and processing
/// deadline. Report data must be gathered by looking at the world state at the moment of
/// the frame's reference slot (including any state changes made in that slot), and must
/// be processed before the frame's processing deadline.
///
/// Frame length is defined in Ethereum consensus layer epochs. Reference slot for each
/// frame is set to the last slot of the epoch preceding the frame's first epoch. The
/// processing deadline is set to the last slot of the last epoch of the frame.
///
/// This means that all state changes a report processing could entail are guaranteed to be
/// observed while gathering data for the next frame's report. This is an important property
/// given that oracle reports sometimes have to contain diffs instead of the full state which
/// might be impractical or even impossible to transmit and process.
///
contract HashConsensus is AccessControlEnumerable {
    using SafeCast for uint256;

    error InvalidChainConfig();
    error NumericOverflow();
    error AdminCannotBeZero();
    error ReportProcessorCannotBeZero();
    error DuplicateMember();
    error AddressCannotBeZero();
    error InitialEpochIsYetToArrive();
    error InitialEpochAlreadyArrived();
    error InitialEpochRefSlotCannotBeEarlierThanProcessingSlot();
    error EpochsPerFrameCannotBeZero();
    error NonMember();
    error UnexpectedConsensusVersion(uint256 expected, uint256 received);
    error QuorumTooSmall(uint256 minQuorum, uint256 receivedQuorum);
    error InvalidSlot();
    error DuplicateReport();
    error EmptyReport();
    error StaleReport();
    error NonFastLaneMemberCannotReportWithinFastLaneInterval();
    error NewProcessorCannotBeTheSame();
    error ConsensusReportAlreadyProcessing();
    error FastLanePeriodCannotBeLongerThanFrame();

    event FrameConfigSet(uint256 newInitialEpoch, uint256 newEpochsPerFrame);
    event FastLaneConfigSet(uint256 fastLaneLengthSlots);
    event MemberAdded(address indexed addr, uint256 newTotalMembers, uint256 newQuorum);
    event MemberRemoved(address indexed addr, uint256 newTotalMembers, uint256 newQuorum);
    event QuorumSet(uint256 newQuorum, uint256 totalMembers, uint256 prevQuorum);
    event ReportReceived(uint256 indexed refSlot, address indexed member, bytes32 report);
    event ConsensusReached(uint256 indexed refSlot, bytes32 report, uint256 support);
    event ConsensusLost(uint256 indexed refSlot);
    event ReportProcessorSet(address indexed processor, address indexed prevProcessor);

    struct FrameConfig {
        uint64 initialEpoch;
        uint64 epochsPerFrame;
        uint64 fastLaneLengthSlots;
    }

    /// @dev Oracle reporting is divided into frames, each lasting the same number of slots.
    ///
    /// The start slot of the next frame is always the next slot after the end slot of the previous
    /// frame.
    ///
    /// Each frame also has a reference slot: if the oracle report contains any data derived from
    /// onchain data, the onchain data should be sampled at the reference slot.
    ///
    struct ConsensusFrame {
        // frame index; increments by 1 with each frame but resets to zero on frame size change
        uint256 index;
        // the slot at which to read the state around which consensus is being reached;
        // if the slot contains a block, the state should include all changes from that block
        uint256 refSlot;
        // the last slot at which a report can be reported and processed
        uint256 reportProcessingDeadlineSlot;
    }

    struct ReportingState {
        // the last reference slot any report was received for
        uint64 lastReportRefSlot;
        // the last reference slot a consensus was reached for
        uint64 lastConsensusRefSlot;
        // the last consensus variant index
        uint64 lastConsensusVariantIndex;
    }

    struct MemberState {
        // the last reference slot a report from this member was received for
        uint64 lastReportRefSlot;
        // the variant index of the last report from this member
        uint64 lastReportVariantIndex;
    }

    struct ReportVariant {
        // the reported hash
        bytes32 hash;
        // how many unique members from the current set reported this hash in the current frame
        uint64 support;
    }

    /// @notice An ACL role granting the permission to modify members list members and
    /// change the quorum by calling addMember, removeMember, and setQuorum functions.
    bytes32 public constant MANAGE_MEMBERS_AND_QUORUM_ROLE =
        keccak256("MANAGE_MEMBERS_AND_QUORUM_ROLE");

    /// @notice An ACL role granting the permission to disable the consensus by calling
    /// the disableConsensus function. Enabling the consensus back requires the possession
    /// of the MANAGE_QUORUM_ROLE.
    bytes32 public constant DISABLE_CONSENSUS_ROLE = keccak256("DISABLE_CONSENSUS_ROLE");

    /// @notice An ACL role granting the permission to change reporting interval duration
    /// and fast lane reporting interval length by calling setFrameConfig.
    bytes32 public constant MANAGE_FRAME_CONFIG_ROLE = keccak256("MANAGE_FRAME_CONFIG_ROLE");

    /// @notice An ACL role granting the permission to change fast lane reporting interval
    /// length by calling setFastLaneLengthSlots.
    bytes32 public constant MANAGE_FAST_LANE_CONFIG_ROLE = keccak256("MANAGE_FAST_LANE_CONFIG_ROLE");

    /// @notice An ACL role granting the permission to change еру report processor
    /// contract by calling setReportProcessor.
    bytes32 public constant MANAGE_REPORT_PROCESSOR_ROLE = keccak256("MANAGE_REPORT_PROCESSOR_ROLE");

    /// Chain specification
    uint64 internal immutable SLOTS_PER_EPOCH;
    uint64 internal immutable SECONDS_PER_SLOT;
    uint64 internal immutable GENESIS_TIME;

    /// @dev A quorum value that effectively disables the oracle.
    uint256 internal constant UNREACHABLE_QUORUM = type(uint256).max;
    bytes32 internal constant ZERO_HASH = bytes32(0);

    /// @dev An offset from the processing deadline slot of the previous frame (i.e. the last slot
    /// at which a report for the prev. frame can be submitted and its processing started) to the
    /// reference slot of the next frame (equal to the last slot of the previous frame).
    /// frame[i].reportProcessingDeadlineSlot := frame[i + 1].refSlot - DEADLINE_SLOT_OFFSET
    uint256 internal constant DEADLINE_SLOT_OFFSET = 0;

    /// @dev Reporting frame configuration
    FrameConfig internal _frameConfig;

    /// @dev Oracle committee members states array
    MemberState[] internal _memberStates;

    /// @dev Oracle committee members' addresses array
    address[] internal _memberAddresses;

    /// @dev Mapping from an oracle committee member address to the 1-based index in the
    /// members array
    mapping(address => uint256) internal _memberIndices1b;

    /// @dev A structure containing the last reference slot any report was received for, the last
    /// reference slot consensus report was achieved for, and the last consensus variant index
    ReportingState internal _reportingState;

    /// @dev Oracle committee members quorum value, must be larger than totalMembers // 2
    uint256 internal _quorum;

    /// @dev Mapping from a report variant index to the ReportVariant structure
    mapping(uint256 => ReportVariant) internal _reportVariants;

    /// @dev The number of report variants
    uint256 internal _reportVariantsLength;

    /// @dev The address of the report processor contract
    address internal _reportProcessor;

    ///
    /// Initialization
    ///

    constructor(
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime,
        uint256 epochsPerFrame,
        uint256 fastLaneLengthSlots,
        address admin,
        address reportProcessor
    ) {
        if (slotsPerEpoch == 0) revert InvalidChainConfig();
        if (secondsPerSlot == 0) revert InvalidChainConfig();

        SLOTS_PER_EPOCH = slotsPerEpoch.toUint64();
        SECONDS_PER_SLOT = secondsPerSlot.toUint64();
        GENESIS_TIME = genesisTime.toUint64();

        if (admin == address(0)) revert AdminCannotBeZero();
        if (reportProcessor == address(0)) revert ReportProcessorCannotBeZero();

        _setupRole(DEFAULT_ADMIN_ROLE, admin);

        uint256 farFutureEpoch = _computeEpochAtTimestamp(type(uint64).max);
        _setFrameConfig(farFutureEpoch, epochsPerFrame, fastLaneLengthSlots, FrameConfig(0, 0, 0));

        _reportProcessor = reportProcessor;
    }

    ///
    /// Time
    ///

    /// @notice Returns the immutable chain parameters required to calculate epoch and slot
    /// given a timestamp.
    ///
    function getChainConfig() external view returns (
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime
    ) {
        return (SLOTS_PER_EPOCH, SECONDS_PER_SLOT, GENESIS_TIME);
    }

    /// @notice Returns the time-related configuration.
    ///
    /// @return initialEpoch Epoch of the frame with zero index.
    /// @return epochsPerFrame Length of a frame in epochs.
    /// @return fastLaneLengthSlots Length of the fast lane interval in slots; see `getIsFastLaneMember`.
    ///
    function getFrameConfig() external view returns (
        uint256 initialEpoch,
        uint256 epochsPerFrame,
        uint256 fastLaneLengthSlots
    ) {
        FrameConfig memory config = _frameConfig;
        return (config.initialEpoch, config.epochsPerFrame, config.fastLaneLengthSlots);
    }

    /// @notice Returns the current reporting frame.
    ///
    /// @return refSlot The frame's reference slot: if the data the consensus is being reached upon
    ///         includes or depends on any onchain state, this state should be queried at the
    ///         reference slot. If the slot contains a block, the state should include all changes
    ///         from that block.
    ///
    /// @return reportProcessingDeadlineSlot The last slot at which the report can be processed by
    ///         the report processor contract.
    ///
    function getCurrentFrame() external view returns (
        uint256 refSlot,
        uint256 reportProcessingDeadlineSlot
    ) {
        ConsensusFrame memory frame = _getCurrentFrame();
        return (frame.refSlot, frame.reportProcessingDeadlineSlot);
    }

    /// @notice Returns the earliest possible reference slot, i.e. the reference slot of the
    /// reporting frame with zero index.
    ///
    function getInitialRefSlot() external view returns (uint256) {
        return _getInitialFrame().refSlot;
    }

    /// @notice Sets a new initial epoch given that the current initial epoch is in the future.
    ///
    /// @param initialEpoch The new initial epoch.
    ///
    function updateInitialEpoch(uint256 initialEpoch) external onlyRole(DEFAULT_ADMIN_ROLE) {
        FrameConfig memory prevConfig = _frameConfig;

        if (_computeEpochAtTimestamp(_getTime()) >= prevConfig.initialEpoch) {
            revert InitialEpochAlreadyArrived();
        }

        _setFrameConfig(
            initialEpoch,
            prevConfig.epochsPerFrame,
            prevConfig.fastLaneLengthSlots,
            prevConfig
        );

        if (_getInitialFrame().refSlot < _getLastProcessingRefSlot()) {
            revert InitialEpochRefSlotCannotBeEarlierThanProcessingSlot();
        }
    }

    /// @notice Updates the time-related configuration.
    ///
    /// @param epochsPerFrame Length of a frame in epochs.
    /// @param fastLaneLengthSlots Length of the fast lane interval in slots; see `getIsFastLaneMember`.
    ///
    function setFrameConfig(uint256 epochsPerFrame, uint256 fastLaneLengthSlots)
        external onlyRole(MANAGE_FRAME_CONFIG_ROLE)
    {
        // Updates epochsPerFrame in a way that either keeps the current reference slot the same
        // or increases it by at least the minimum of old and new frame sizes.
        uint256 timestamp = _getTime();
        uint256 currentFrameStartEpoch = _computeFrameStartEpoch(timestamp, _frameConfig);
        _setFrameConfig(currentFrameStartEpoch, epochsPerFrame, fastLaneLengthSlots, _frameConfig);
    }

    ///
    /// Members
    ///

    /// @notice Returns whether the given address is currently a member of the consensus.
    ///
    function getIsMember(address addr) external view returns (bool) {
        return _isMember(addr);
    }

    /// @notice Returns whether the given address is a fast lane member for the current reporting
    /// frame.
    ///
    /// Fast lane members is a subset of all members that changes each reporting frame. These
    /// members can, and are expected to, submit a report during the first part of the frame called
    /// the "fast lane interval" and defined via `setFrameConfig` or `setFastLaneLengthSlots`. Under
    /// regular circumstances, all other members are only allowed to submit a report after the fast
    /// lane interval passes.
    ///
    /// The fast lane subset consists of `quorum` members; selection is implemented as a sliding
    /// window of the `quorum` width over member indices (mod total members). The window advances
    /// by one index each reporting frame.
    ///
    /// This is done to encourage each member from the full set to participate in reporting on a
    /// regular basis, and identify any malfunctioning members.
    ///
    /// With the fast lane mechanism active, it's sufficient for the monitoring to check that
    /// consensus is consistently reached during the fast lane part of each frame to conclude that
    /// all members are active and share the same consensus rules.
    ///
    /// However, there is no guarantee that, at any given time, it holds true that only the current
    /// fast lane members can or were able to report during the currently-configured fast lane
    /// interval of the current frame. In particular, this assumption can be violated in any frame
    /// during which the members set, initial epoch, or the quorum number was changed, or the fast
    /// lane interval length was increased. Thus, the fast lane mechanism should not be used for any
    /// purpose other than monitoring of the members liveness, and monitoring tools should take into
    /// consideration the potential irregularities within frames with any configuration changes.
    ///
    function getIsFastLaneMember(address addr) external view returns (bool) {
        uint256 index1b = _memberIndices1b[addr];
        unchecked {
            return index1b > 0 && _isFastLaneMember(index1b - 1, _getCurrentFrame().index);
        }
    }

    /// @notice Returns all current members, together with the last reference slot each member
    /// submitted a report for.
    ///
    function getMembers() external view returns (
        address[] memory addresses,
        uint256[] memory lastReportedRefSlots
    ) {
        return _getMembers(false);
    }

    /// @notice Returns the subset of the oracle committee members (consisting of `quorum` items)
    /// that changes each frame.
    ///
    /// See `getIsFastLaneMember`.
    ///
    function getFastLaneMembers() external view returns (
        address[] memory addresses,
        uint256[] memory lastReportedRefSlots
    ) {
        return _getMembers(true);
    }

    /// @notice Sets the duration of the fast lane interval of the reporting frame.
    ///
    /// See `getIsFastLaneMember`.
    ///
    /// @param fastLaneLengthSlots The length of the fast lane reporting interval in slots. Setting
    ///        it to zero disables the fast lane subset, allowing any oracle to report starting from
    ///        the first slot of a frame and until the frame's reporting deadline.
    ///
    function setFastLaneLengthSlots(uint256 fastLaneLengthSlots)
        external onlyRole(MANAGE_FAST_LANE_CONFIG_ROLE)
    {
        _setFastLaneLengthSlots(fastLaneLengthSlots);
    }

    function addMember(address addr, uint256 quorum)
        external
        onlyRole(MANAGE_MEMBERS_AND_QUORUM_ROLE)
    {
        _addMember(addr, quorum);
    }

    function removeMember(address addr, uint256 quorum)
        external
        onlyRole(MANAGE_MEMBERS_AND_QUORUM_ROLE)
    {
        _removeMember(addr, quorum);
    }

    function getQuorum() external view returns (uint256) {
        return _quorum;
    }

    function setQuorum(uint256 quorum) external {
        // access control is performed inside the next call
        _setQuorumAndCheckConsensus(quorum, _memberStates.length);
    }

    /// @notice Disables the oracle by setting the quorum to an unreachable value.
    ///
    function disableConsensus() external {
        // access control is performed inside the next call
        _setQuorumAndCheckConsensus(UNREACHABLE_QUORUM, _memberStates.length);
    }

    ///
    /// Report processor
    ///

    function getReportProcessor() external view returns (address) {
        return _reportProcessor;
    }

    function setReportProcessor(address newProcessor)
        external
        onlyRole(MANAGE_REPORT_PROCESSOR_ROLE)
    {
        _setReportProcessor(newProcessor);
    }

    ///
    /// Consensus
    ///

    /// @notice Returns info about the current frame and consensus state in that frame.
    ///
    /// @return refSlot Reference slot of the current reporting frame.
    ///
    /// @return consensusReport Consensus report for the current frame, if any.
    ///         Zero bytes otherwise.
    ///
    /// @return isReportProcessing If consensus report for the current frame is already
    ///         being processed. Consensus can be changed before the processing starts.
    ///
    function getConsensusState() external view returns (
        uint256 refSlot,
        bytes32 consensusReport,
        bool isReportProcessing
    ) {
        refSlot = _getCurrentFrame().refSlot;
        (consensusReport,,) = _getConsensusReport(refSlot, _quorum);
        isReportProcessing = _getLastProcessingRefSlot() == refSlot;
    }

    /// @notice Returns report variants and their support for the current reference slot.
    ///
    function getReportVariants() external view returns (
        bytes32[] memory variants,
        uint256[] memory support
    ) {
        if (_reportingState.lastReportRefSlot != _getCurrentFrame().refSlot) {
            return (variants, support);
        }

        uint256 variantsLength = _reportVariantsLength;
        variants = new bytes32[](variantsLength);
        support = new uint256[](variantsLength);

        for (uint256 i = 0; i < variantsLength; ++i) {
            ReportVariant memory variant = _reportVariants[i];
            variants[i] = variant.hash;
            support[i] = variant.support;
        }
    }

    struct MemberConsensusState {
        /// @notice Current frame's reference slot.
        uint256 currentFrameRefSlot;

        /// @notice Consensus report for the current frame, if any. Zero bytes otherwise.
        bytes32 currentFrameConsensusReport;

        /// @notice Whether the provided address is a member of the oracle committee.
        bool isMember;

        /// @notice Whether the oracle committee member is in the fast lane members subset
        /// of the current reporting frame. See `getIsFastLaneMember`.
        bool isFastLane;

        /// @notice Whether the oracle committee member is allowed to submit a report at
        /// the moment of the call.
        bool canReport;

        /// @notice The last reference slot for which the member submitted a report.
        uint256 lastMemberReportRefSlot;

        /// @notice The hash reported by the member for the current frame, if any.
        /// Zero bytes otherwise.
        bytes32 currentFrameMemberReport;
    }

    /// @notice Returns the extended information related to an oracle committee member with the
    /// given address and the current consensus state. Provides all the information needed for
    /// an oracle daemon to decide if it needs to submit a report.
    ///
    /// @param addr The member address.
    /// @return result See the docs for `MemberConsensusState`.
    ///
    function getConsensusStateForMember(address addr)
        external view returns (MemberConsensusState memory result)
    {
        ConsensusFrame memory frame = _getCurrentFrame();
        result.currentFrameRefSlot = frame.refSlot;
        (result.currentFrameConsensusReport,,) = _getConsensusReport(frame.refSlot, _quorum);

        uint256 index = _memberIndices1b[addr];
        result.isMember = index != 0;

        if (index != 0) {
            unchecked { --index; } // convert to 0-based
            MemberState memory memberState = _memberStates[index];

            result.lastMemberReportRefSlot = memberState.lastReportRefSlot;
            result.currentFrameMemberReport =
                result.lastMemberReportRefSlot == frame.refSlot
                    ? _reportVariants[memberState.lastReportVariantIndex].hash
                    : ZERO_HASH;

            uint256 slot = _computeSlotAtTimestamp(_getTime());

            result.canReport = slot <= frame.reportProcessingDeadlineSlot &&
                frame.refSlot > _getLastProcessingRefSlot();

            result.isFastLane = _isFastLaneMember(index, frame.index);

            if (!result.isFastLane && result.canReport) {
                result.canReport = slot > frame.refSlot + _frameConfig.fastLaneLengthSlots;
            }
        }
    }

    /// @notice Used by oracle members to submit hash of the data calculated for the given
    /// reference slot.
    ///
    /// @param slot The reference slot the data was calculated for. Reverts if doesn't match
    ///        the current reference slot.
    ///
    /// @param report Hash of the data calculated for the given reference slot.
    ///
    /// @param consensusVersion Version of the oracle consensus rules. Reverts if doesn't
    ///        match the version returned by the currently set consensus report processor,
    ///        or zero if no report processor is set.
    ///
    function submitReport(uint256 slot, bytes32 report, uint256 consensusVersion) external {
        _submitReport(slot, report, consensusVersion);
    }

    ///
    /// Implementation: time
    ///

    function _setFrameConfig(
        uint256 initialEpoch,
        uint256 epochsPerFrame,
        uint256 fastLaneLengthSlots,
        FrameConfig memory prevConfig
    ) internal {
        if (epochsPerFrame == 0) revert EpochsPerFrameCannotBeZero();

        if (fastLaneLengthSlots > epochsPerFrame * SLOTS_PER_EPOCH) {
            revert FastLanePeriodCannotBeLongerThanFrame();
        }

        _frameConfig = FrameConfig(
            initialEpoch.toUint64(),
            epochsPerFrame.toUint64(),
            fastLaneLengthSlots.toUint64()
        );

        if (initialEpoch != prevConfig.initialEpoch || epochsPerFrame != prevConfig.epochsPerFrame) {
            emit FrameConfigSet(initialEpoch, epochsPerFrame);
        }

        if (fastLaneLengthSlots != prevConfig.fastLaneLengthSlots) {
            emit FastLaneConfigSet(fastLaneLengthSlots);
        }
    }

    function _getCurrentFrame() internal view returns (ConsensusFrame memory) {
        return _getFrameAtTimestamp(_getTime(), _frameConfig);
    }

    function _getInitialFrame() internal view returns (ConsensusFrame memory) {
        return _getFrameAtIndex(0, _frameConfig);
    }

    function _getFrameAtTimestamp(uint256 timestamp, FrameConfig memory config)
        internal view returns (ConsensusFrame memory)
    {
        return _getFrameAtIndex(_computeFrameIndex(timestamp, config), config);
    }

    function _getFrameAtIndex(uint256 frameIndex, FrameConfig memory config)
        internal view returns (ConsensusFrame memory)
    {
        uint256 frameStartEpoch = _computeStartEpochOfFrameWithIndex(frameIndex, config);
        uint256 frameStartSlot = _computeStartSlotAtEpoch(frameStartEpoch);
        uint256 nextFrameStartSlot = frameStartSlot + config.epochsPerFrame * SLOTS_PER_EPOCH;

        return ConsensusFrame({
            index: frameIndex,
            refSlot: uint64(frameStartSlot - 1),
            reportProcessingDeadlineSlot: uint64(nextFrameStartSlot - 1 - DEADLINE_SLOT_OFFSET)
        });
    }

    function _computeFrameStartEpoch(uint256 timestamp, FrameConfig memory config)
        internal view returns (uint256)
    {
        return _computeStartEpochOfFrameWithIndex(_computeFrameIndex(timestamp, config), config);
    }

    function _computeStartEpochOfFrameWithIndex(uint256 frameIndex, FrameConfig memory config)
        internal pure returns (uint256)
    {
        return config.initialEpoch + frameIndex * config.epochsPerFrame;
    }

    function _computeFrameIndex(uint256 timestamp, FrameConfig memory config)
        internal view returns (uint256)
    {
        uint256 epoch = _computeEpochAtTimestamp(timestamp);
        if (epoch < config.initialEpoch) {
            revert InitialEpochIsYetToArrive();
        }
        return (epoch - config.initialEpoch) / config.epochsPerFrame;
    }

    function _computeTimestampAtSlot(uint256 slot) internal view returns (uint256) {
        // See: github.com/ethereum/consensus-specs/blob/dev/specs/bellatrix/beacon-chain.md#compute_timestamp_at_slot
        return GENESIS_TIME + slot * SECONDS_PER_SLOT;
    }

    function _computeSlotAtTimestamp(uint256 timestamp) internal view returns (uint256) {
        return (timestamp - GENESIS_TIME) / SECONDS_PER_SLOT;
    }

    function _computeEpochAtSlot(uint256 slot) internal view returns (uint256) {
        // See: github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_epoch_at_slot
        return slot / SLOTS_PER_EPOCH;
    }

    function _computeEpochAtTimestamp(uint256 timestamp) internal view returns (uint256) {
        return _computeEpochAtSlot(_computeSlotAtTimestamp(timestamp));
    }

    function _computeStartSlotAtEpoch(uint256 epoch) internal view returns (uint256) {
        // See: github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_start_slot_at_epoch
        return epoch * SLOTS_PER_EPOCH;
    }

    function _getTime() internal virtual view returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    ///
    /// Implementation: members
    ///

    function _isMember(address addr) internal view returns (bool) {
        return _memberIndices1b[addr] != 0;
    }

    function _getMemberIndex(address addr) internal view returns (uint256) {
        uint256 index1b = _memberIndices1b[addr];
        if (index1b == 0) {
            revert NonMember();
        }
        unchecked {
            return uint256(index1b - 1);
        }
    }

    function _addMember(address addr, uint256 quorum) internal {
        if (_isMember(addr)) revert DuplicateMember();
        if (addr == address(0)) revert AddressCannotBeZero();

        _memberStates.push(MemberState(0, 0));
        _memberAddresses.push(addr);

        uint256 newTotalMembers = _memberStates.length;
        _memberIndices1b[addr] = newTotalMembers;

        emit MemberAdded(addr, newTotalMembers, quorum);

        _setQuorumAndCheckConsensus(quorum, newTotalMembers);
    }

    function _removeMember(address addr, uint256 quorum) internal {
        uint256 index = _getMemberIndex(addr);
        uint256 newTotalMembers = _memberStates.length - 1;

        assert(index <= newTotalMembers);
        MemberState memory memberState = _memberStates[index];

        if (index != newTotalMembers) {
            address addrToMove = _memberAddresses[newTotalMembers];
            _memberAddresses[index] = addrToMove;
            _memberStates[index] = _memberStates[newTotalMembers];
            _memberIndices1b[addrToMove] = index + 1;
        }

        _memberStates.pop();
        _memberAddresses.pop();
        _memberIndices1b[addr] = 0;

        emit MemberRemoved(addr, newTotalMembers, quorum);

        if (memberState.lastReportRefSlot > 0) {
            // member reported at least once
            ConsensusFrame memory frame = _getCurrentFrame();

            if (memberState.lastReportRefSlot == frame.refSlot &&
                _getLastProcessingRefSlot() < frame.refSlot
            ) {
                // member reported for the current ref. slot and the consensus report
                // is not processing yet => need to cancel the member's report
                --_reportVariants[memberState.lastReportVariantIndex].support;
            }
        }

        _setQuorumAndCheckConsensus(quorum, newTotalMembers);
    }

    function _setFastLaneLengthSlots(uint256 fastLaneLengthSlots) internal {
        FrameConfig memory frameConfig = _frameConfig;
        if (fastLaneLengthSlots > frameConfig.epochsPerFrame * SLOTS_PER_EPOCH) {
            revert FastLanePeriodCannotBeLongerThanFrame();
        }
        if (fastLaneLengthSlots != frameConfig.fastLaneLengthSlots) {
            _frameConfig.fastLaneLengthSlots = fastLaneLengthSlots.toUint64();
            emit FastLaneConfigSet(fastLaneLengthSlots);
        }
    }

    /// @dev Returns start and past-end incides (mod totalMembers) of the fast lane members subset.
    ///
    function _getFastLaneSubset(uint256 frameIndex, uint256 totalMembers)
        internal view returns (uint256 startIndex, uint256 pastEndIndex)
    {
        uint256 quorum = _quorum;
        if (quorum >= totalMembers) {
            startIndex = 0;
            pastEndIndex = totalMembers;
        } else {
            startIndex = frameIndex % totalMembers;
            pastEndIndex = startIndex + quorum;
        }
    }

    /// @dev Tests whether the member with the given `index` is in the fast lane subset for the
    /// given reporting `frameIndex`.
    ///
    function _isFastLaneMember(uint256 index, uint256 frameIndex) internal view returns (bool) {
        uint256 totalMembers = _memberStates.length;
        (uint256 flLeft, uint256 flPastRight) = _getFastLaneSubset(frameIndex, totalMembers);
        unchecked {
            return (
                flPastRight != 0 &&
                Math.pointInClosedIntervalModN(index, flLeft, flPastRight - 1, totalMembers)
            );
        }
    }

    function _getMembers(bool fastLane) internal view returns (
        address[] memory addresses,
        uint256[] memory lastReportedRefSlots
    ) {
        uint256 totalMembers = _memberStates.length;
        uint256 left;
        uint256 right;

        if (fastLane) {
            (left, right) = _getFastLaneSubset(_getCurrentFrame().index, totalMembers);
        } else {
            right = totalMembers;
        }

        addresses = new address[](right - left);
        lastReportedRefSlots = new uint256[](addresses.length);

        for (uint256 i = left; i < right; ++i) {
            uint256 iModTotal = i % totalMembers;
            MemberState memory memberState = _memberStates[iModTotal];
            uint256 k = i - left;
            addresses[k] = _memberAddresses[iModTotal];
            lastReportedRefSlots[k] = memberState.lastReportRefSlot;
        }
    }

    ///
    /// Implementation: consensus
    ///

    function _submitReport(uint256 slot, bytes32 report, uint256 consensusVersion) internal {
        if (slot == 0) revert InvalidSlot();
        if (slot > type(uint64).max) revert NumericOverflow();
        if (report == ZERO_HASH) revert EmptyReport();

        uint256 memberIndex = _getMemberIndex(_msgSender());
        MemberState memory memberState = _memberStates[memberIndex];

        uint256 expectedConsensusVersion = _getConsensusVersion();
        if (consensusVersion != expectedConsensusVersion) {
            revert UnexpectedConsensusVersion(expectedConsensusVersion, consensusVersion);
        }

        uint256 timestamp = _getTime();
        uint256 currentSlot = _computeSlotAtTimestamp(timestamp);
        FrameConfig memory config = _frameConfig;
        ConsensusFrame memory frame = _getFrameAtTimestamp(timestamp, config);

        if (slot != frame.refSlot) revert InvalidSlot();
        if (currentSlot > frame.reportProcessingDeadlineSlot) revert StaleReport();

        if (currentSlot <= frame.refSlot + config.fastLaneLengthSlots &&
            !_isFastLaneMember(memberIndex, frame.index)
        ) {
            revert NonFastLaneMemberCannotReportWithinFastLaneInterval();
        }

        if (slot <= _getLastProcessingRefSlot()) {
            // consensus for the ref. slot was already reached and consensus report is processing
            if (slot == memberState.lastReportRefSlot) {
                // member sends a report for the same slot => let them know via a revert
                revert ConsensusReportAlreadyProcessing();
            } else {
                // member hasn't sent a report for this slot => normal operation, do nothing
                return;
            }
        }

        uint256 variantsLength;

        if (_reportingState.lastReportRefSlot != slot) {
            // first report for a new slot => clear report variants
            _reportingState.lastReportRefSlot = uint64(slot);
            variantsLength = 0;
        } else {
            variantsLength = _reportVariantsLength;
        }

        uint64 varIndex = 0;
        bool prevConsensusLost = false;

        while (varIndex < variantsLength && _reportVariants[varIndex].hash != report) {
            ++varIndex;
        }

        if (slot == memberState.lastReportRefSlot) {
            uint64 prevVarIndex = memberState.lastReportVariantIndex;
            assert(prevVarIndex < variantsLength);
            if (varIndex == prevVarIndex) {
                revert DuplicateReport();
            } else {
                uint256 support = --_reportVariants[prevVarIndex].support;
                if (support == _quorum - 1) {
                    prevConsensusLost = true;
                }
            }
        }

        uint256 support;

        if (varIndex < variantsLength) {
            support = ++_reportVariants[varIndex].support;
        } else {
            support = 1;
            _reportVariants[varIndex] = ReportVariant({hash: report, support: 1});
            _reportVariantsLength = ++variantsLength;
        }

        _memberStates[memberIndex] = MemberState({
            lastReportRefSlot: uint64(slot),
            lastReportVariantIndex: varIndex
        });

        emit ReportReceived(slot, _msgSender(), report);

        if (support >= _quorum) {
            _consensusReached(frame, report, varIndex, support);
        } else if (prevConsensusLost) {
            _consensusNotReached(frame);
        }
    }

    function _consensusReached(
        ConsensusFrame memory frame,
        bytes32 report,
        uint256 variantIndex,
        uint256 support
    ) internal {
        if (_reportingState.lastConsensusRefSlot != frame.refSlot ||
            _reportingState.lastConsensusVariantIndex != variantIndex
        ) {
            _reportingState.lastConsensusRefSlot = uint64(frame.refSlot);
            _reportingState.lastConsensusVariantIndex = uint64(variantIndex);
            emit ConsensusReached(frame.refSlot, report, support);
            _submitReportForProcessing(frame, report);
        }
    }

    function _consensusNotReached(ConsensusFrame memory frame) internal {
        if (_reportingState.lastConsensusRefSlot == frame.refSlot) {
            _reportingState.lastConsensusRefSlot = 0;
            emit ConsensusLost(frame.refSlot);
            _cancelReportProcessing(frame);
        }
    }

    function _setQuorumAndCheckConsensus(uint256 quorum, uint256 totalMembers) internal {
        if (quorum <= totalMembers / 2) {
            revert QuorumTooSmall(totalMembers / 2 + 1, quorum);
        }

        // we're explicitly allowing quorum values greater than the number of members to
        // allow effectively disabling the oracle in case something unpredictable happens

        uint256 prevQuorum = _quorum;
        if (quorum != prevQuorum) {
            _checkRole(
                quorum == UNREACHABLE_QUORUM ? DISABLE_CONSENSUS_ROLE : MANAGE_MEMBERS_AND_QUORUM_ROLE,
                _msgSender()
            );
            _quorum = quorum;
            emit QuorumSet(quorum, totalMembers, prevQuorum);
        }

        if (_computeEpochAtTimestamp(_getTime()) >= _frameConfig.initialEpoch) {
            _checkConsensus(quorum);
        }
    }

    function _checkConsensus(uint256 quorum) internal {
        uint256 timestamp = _getTime();
        ConsensusFrame memory frame = _getFrameAtTimestamp(timestamp, _frameConfig);

        if (_computeSlotAtTimestamp(timestamp) > frame.reportProcessingDeadlineSlot) {
            // a report for the current ref. slot cannot be processed anymore
            return;
        }

        if (_getLastProcessingRefSlot() >= frame.refSlot) {
            // a consensus report for the current ref. slot is already being processed
            return;
        }

        (bytes32 consensusReport, int256 consensusVariantIndex, uint256 support) =
            _getConsensusReport(frame.refSlot, quorum);

        if (consensusVariantIndex >= 0) {
            _consensusReached(frame, consensusReport, uint256(consensusVariantIndex), support);
        } else {
            _consensusNotReached(frame);
        }
    }

    function _getConsensusReport(uint256 currentRefSlot, uint256 quorum)
        internal view returns (bytes32 report, int256 variantIndex, uint256 support)
    {
        if (_reportingState.lastReportRefSlot != currentRefSlot) {
            // there were no reports for the current ref. slot
            return (ZERO_HASH, -1, 0);
        }

        uint256 variantsLength = _reportVariantsLength;
        variantIndex = -1;
        report = ZERO_HASH;
        support = 0;

        for (uint256 i = 0; i < variantsLength; ++i) {
            uint256 iSupport = _reportVariants[i].support;
            if (iSupport >= quorum) {
                variantIndex = int256(i);
                report = _reportVariants[i].hash;
                support = iSupport;
                break;
            }
        }

        return (report, variantIndex, support);
    }

    ///
    /// Implementation: report processing
    ///

    function _setReportProcessor(address newProcessor) internal {
        address prevProcessor = _reportProcessor;
        if (newProcessor == address(0)) revert ReportProcessorCannotBeZero();
        if (newProcessor == prevProcessor) revert NewProcessorCannotBeTheSame();

        _reportProcessor = newProcessor;
        emit ReportProcessorSet(newProcessor, prevProcessor);

        ConsensusFrame memory frame = _getCurrentFrame();
        uint256 lastConsensusRefSlot = _reportingState.lastConsensusRefSlot;

        uint256 processingRefSlotPrev = IReportAsyncProcessor(prevProcessor).getLastProcessingRefSlot();
        uint256 processingRefSlotNext = IReportAsyncProcessor(newProcessor).getLastProcessingRefSlot();

        if (
            processingRefSlotPrev < frame.refSlot &&
            processingRefSlotNext < frame.refSlot &&
            lastConsensusRefSlot == frame.refSlot
        ) {
            bytes32 report = _reportVariants[_reportingState.lastConsensusVariantIndex].hash;
            _submitReportForProcessing(frame, report);
        }
    }

    function _getLastProcessingRefSlot() internal view returns (uint256) {
        return IReportAsyncProcessor(_reportProcessor).getLastProcessingRefSlot();
    }

    function _submitReportForProcessing(ConsensusFrame memory frame, bytes32 report) internal {
        IReportAsyncProcessor(_reportProcessor).submitConsensusReport(
            report,
            frame.refSlot,
            _computeTimestampAtSlot(frame.reportProcessingDeadlineSlot)
        );
    }

    function _cancelReportProcessing(ConsensusFrame memory frame) internal {
        IReportAsyncProcessor(_reportProcessor).discardConsensusReport(frame.refSlot);
    }

    function _getConsensusVersion() internal view returns (uint256) {
        return IReportAsyncProcessor(_reportProcessor).getConsensusVersion();
    }
}
