// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";

import "../../common/interfaces/ILidoLocator.sol";

import "../utils/Versioned.sol";


interface IAccountingOracle {
    function getConsensusContract() external view returns (address);
}


interface IHashConsensus {
    function getChainConfig() external view returns (
        uint256 slotsPerEpoch,
        uint256 secondsPerSlot,
        uint256 genesisTime
    );

    function getFrameConfig() external view returns (
        uint256 initialEpoch,
        uint256 epochsPerFrame
    );

    function getCurrentFrame() external view returns (
        uint256 refSlot,
        uint256 reportProcessingDeadlineSlot
    );
}


/**
 * @title DEPRECATED legacy oracle contract stub kept for compatibility purposes only.
 * Should not be used in new code.
 *
 * Previously, the oracle contract was located at this address. Currently, the oracle lives
 * at a different address, and this contract is kept for the compatibility, supporting a
 * limited subset of view functions and events.
 *
 * See docs.lido.fi for more info.
 */
contract LegacyOracle is Versioned, AragonApp {

    struct ChainSpec {
        uint64 epochsPerFrame;
        uint64 slotsPerEpoch;
        uint64 secondsPerSlot;
        uint64 genesisTime;
    }

    /// @notice DEPRECATED, kept for compatibility purposes only. The new Rebase event emitted
    /// from the main Lido contract should be used instead.
    ///
    /// This event is still emitted after oracle committee reaches consensus on a report, but
    /// only for compatibility purposes. The values in this event are not enough to calculate
    /// APR or TVL anymore due to withdrawals, execution layer rewards, and consensus layer
    /// rewards skimming.
    event Completed(
        uint256 epochId,
        uint128 beaconBalance,
        uint128 beaconValidators
    );

    /// @notice DEPRECATED, kept for compatibility purposes only. The new Rebase event emitted
    /// from the main Lido contract should be used instead.
    ///
    /// This event is still emitted after each rebase but only for compatibility purposes.
    /// The values in this event are not enough to correctly calculate the rebase APR since
    /// a rebase can result from shares burning without changing total ETH held by the
    /// protocol.
    event PostTotalShares(
        uint256 postTotalPooledEther,
        uint256 preTotalPooledEther,
        uint256 timeElapsed,
        uint256 totalShares
    );

    /// Address of the Lido contract
    bytes32 internal constant LIDO_POSITION =
        0xf6978a4f7e200f6d3a24d82d44c48bddabce399a3b8ec42a480ea8a2d5fe6ec5; // keccak256("lido.LidoOracle.lido")

    /// Address of the new accounting oracle contract
    bytes32 internal constant ACCOUNTING_ORACLE_POSITION =
        0xea0b659bb027a76ad14e51fad85cb5d4cedf3fd9dc4531be67b31d6d8725e9c6; // keccak256("lido.LidoOracle.accountingOracle");

    /// Storage for the Ethereum chain specification
    bytes32 internal constant BEACON_SPEC_POSITION =
        0x805e82d53a51be3dfde7cfed901f1f96f5dad18e874708b082adb8841e8ca909; // keccak256("lido.LidoOracle.beaconSpec")

    /// Version of the initialized contract data (DEPRECATED)
    bytes32 internal constant CONTRACT_VERSION_POSITION_DEPRECATED =
        0x75be19a3f314d89bd1f84d30a6c84e2f1cd7afc7b6ca21876564c265113bb7e4; // keccak256("lido.LidoOracle.contractVersion")

    /// Historic data about 2 last completed reports and their times
    bytes32 internal constant POST_COMPLETED_TOTAL_POOLED_ETHER_POSITION =
        0xaa8433b13d2b111d4f84f6f374bc7acbe20794944308876aa250fa9a73dc7f53; // keccak256("lido.LidoOracle.postCompletedTotalPooledEther")
    bytes32 internal constant PRE_COMPLETED_TOTAL_POOLED_ETHER_POSITION =
        0x1043177539af09a67d747435df3ff1155a64cd93a347daaac9132a591442d43e; // keccak256("lido.LidoOracle.preCompletedTotalPooledEther")
    bytes32 internal constant LAST_COMPLETED_EPOCH_ID_POSITION =
        0xdad15c0beecd15610092d84427258e369d2582df22869138b4c5265f049f574c; // keccak256("lido.LidoOracle.lastCompletedEpochId")
    bytes32 internal constant TIME_ELAPSED_POSITION =
        0x8fe323f4ecd3bf0497252a90142003855cc5125cee76a5b5ba5d508c7ec28c3a; // keccak256("lido.LidoOracle.timeElapsed")

    /**
     * @notice Returns the Lido contract address.
     */
    function getLido() public view returns (address) {
        return LIDO_POSITION.getStorageAddress();
    }

    /**
     * @notice Returns the accounting (new) oracle contract address.
     */
    function getAccountingOracle() public view returns (address) {
        return ACCOUNTING_ORACLE_POSITION.getStorageAddress();
    }

    ///
    /// Compatibility interface (DEPRECATED)
    ///

    /**
     * @notice Returns the initialized version of this contract starting from 0.
     */
    function getVersion() external view returns (uint256) {
        return getContractVersion();
    }

    /**
     * @notice DEPRECATED, kept for compatibility purposes only.
     *
     * Returns the Ethereum chain specification.
     */
    function getBeaconSpec()
        external
        view
        returns (
            uint64 epochsPerFrame,
            uint64 slotsPerEpoch,
            uint64 secondsPerSlot,
            uint64 genesisTime
        )
    {
        (, uint256 epochsPerFrame_) = _getAccountingConsensusContract().getFrameConfig();
        epochsPerFrame = uint64(epochsPerFrame_);

        ChainSpec memory spec = _getChainSpec();
        slotsPerEpoch = spec.slotsPerEpoch;
        secondsPerSlot = spec.secondsPerSlot;
        genesisTime = spec.genesisTime;
    }

    /**
     * @notice DEPRECATED, kept for compatibility purposes only.
     *
     * Returns the epoch calculated from current timestamp
     */
    function getCurrentEpochId() external view returns (uint256) {
        ChainSpec memory spec = _getChainSpec();
        // solhint-disable-line not-rely-on-time
        return (_getTime() - spec.genesisTime) / (spec.slotsPerEpoch * spec.secondsPerSlot);
    }

    /**
     * @notice DEPRECATED, kept for compatibility purposes only.
     *
     * Returns the first epoch of the current reporting frame as well as its start and end
     * times in seconds.
     */
    function getCurrentFrame()
        external
        view
        returns (
            uint256 frameEpochId,
            uint256 frameStartTime,
            uint256 frameEndTime
        )
    {
        return _getCurrentFrameFromAccountingOracle();
    }

    /**
     * @notice DEPRECATED, kept for compatibility purposes only.
     *
     * Returns the starting epoch of the last frame in which an oracle report was received
     * and applied.
     */
    function getLastCompletedEpochId() external view returns (uint256) {
        return LAST_COMPLETED_EPOCH_ID_POSITION.getStorageUint256();
    }

    /**
     * @notice DEPRECATED, kept for compatibility purposes only.
     *
     * The change of the protocol TVL that the last rebase resulted in. Notice that, during
     * a rebase, stETH shares can be minted to distribute protocol fees and burnt to apply
     * cover for losses incurred by slashed or unresponsive validators. A rebase might be
     * triggered without changing the protocol TVL. Thus, it's impossible to correctly
     * calculate APR from the numbers returned by this function.
     *
     * See docs.lido.fi for the correct way of onchain and offchain APR calculation.
     */
    function getLastCompletedReportDelta()
        external
        view
        returns (
            uint256 postTotalPooledEther,
            uint256 preTotalPooledEther,
            uint256 timeElapsed
        )
    {
        postTotalPooledEther = POST_COMPLETED_TOTAL_POOLED_ETHER_POSITION.getStorageUint256();
        preTotalPooledEther = PRE_COMPLETED_TOTAL_POOLED_ETHER_POSITION.getStorageUint256();
        timeElapsed = TIME_ELAPSED_POSITION.getStorageUint256();
    }

    ///
    /// Internal interface & implementation.
    ///

    /**
     * @notice Called by Lido on each rebase.
     */
    function handlePostTokenRebase(
        uint256 /* reportTimestamp */,
        uint256 timeElapsed,
        uint256 /* preTotalShares */,
        uint256 preTotalEther,
        uint256 postTotalShares,
        uint256 postTotalEther,
        uint256 /* totalSharesMintedAsFees */
    )
        external
    {
        require(msg.sender == getLido(), "SENDER_NOT_ALLOWED");

        PRE_COMPLETED_TOTAL_POOLED_ETHER_POSITION.setStorageUint256(preTotalEther);
        POST_COMPLETED_TOTAL_POOLED_ETHER_POSITION.setStorageUint256(postTotalEther);
        TIME_ELAPSED_POSITION.setStorageUint256(timeElapsed);

        emit PostTotalShares(postTotalEther, preTotalEther, timeElapsed, postTotalShares);
    }

    /**
     * @notice Called by the new accounting oracle on each report.
     */
    function handleConsensusLayerReport(uint256 _refSlot, uint256 _clBalance, uint256 _clValidators)
        external
    {
        require(msg.sender == getAccountingOracle(), "SENDER_NOT_ALLOWED");

        // new accounting oracle's ref. slot is the last slot of the epoch preceding the one the frame starts at
        uint256 epochId = (_refSlot + 1) / _getChainSpec().slotsPerEpoch;
        LAST_COMPLETED_EPOCH_ID_POSITION.setStorageUint256(epochId);

        emit Completed(epochId, uint128(_clBalance), uint128(_clValidators));
    }

    /**
     * @notice Initializes the contract (the compat-only deprecated version 4) from scratch.
     * @param _lidoLocator Address of the Lido Locator contract.
     * @param _accountingOracleConsensusContract Address of consensus contract of the new accounting oracle contract.
     */
    function initialize(
        address _lidoLocator,
        address _accountingOracleConsensusContract
    ) external onlyInit {
        // Initializations for v0 --> v3
        _checkContractVersion(0);
        // deprecated version slot must be empty
        require(CONTRACT_VERSION_POSITION_DEPRECATED.getStorageUint256() == 0, "WRONG_BASE_VERSION");
        require(_lidoLocator != address(0), "ZERO_LOCATOR_ADDRESS");
        ILidoLocator locator = ILidoLocator(_lidoLocator);

        LIDO_POSITION.setStorageAddress(locator.lido());

        // Initializations for v3 --> v4
        _initialize_v4(locator.accountingOracle());

        // Cannot get consensus contract from new oracle because at this point new oracle is
        // not initialized with consensus contract address yet
        _setChainSpec(_getAccountingOracleChainSpec(_accountingOracleConsensusContract));

        // Needed to finish the Aragon part of initialization (otherwise auth() modifiers will fail)
        initialized();
    }

    /**
     * @notice A function to finalize upgrade v3 -> v4 (the compat-only deprecated impl).
     * Can be called only once.
     */
    function finalizeUpgrade_v4(address _accountingOracle) external {
        // deprecated version slot must be set to v3
        require(CONTRACT_VERSION_POSITION_DEPRECATED.getStorageUint256() == 3, "WRONG_BASE_VERSION");
        // current version slot must not be initialized yet
        _checkContractVersion(0);

        IHashConsensus consensus = IHashConsensus(IAccountingOracle(_accountingOracle).getConsensusContract());

        _initialize_v4(_accountingOracle);

        ChainSpec memory spec = _getChainSpec();
        ChainSpec memory newSpec = _getAccountingOracleChainSpec(consensus);

        require(
            spec.slotsPerEpoch == newSpec.slotsPerEpoch &&
            spec.secondsPerSlot == newSpec.secondsPerSlot &&
            spec.genesisTime == newSpec.genesisTime,
            "UNEXPECTED_CHAIN_SPEC"
        );
    }

    function _initialize_v4(address _accountingOracle) internal {
        require(_accountingOracle != address(0), "ZERO_ACCOUNTING_ORACLE_ADDRESS");
        ACCOUNTING_ORACLE_POSITION.setStorageAddress(_accountingOracle);
        // write current version slot
        _setContractVersion(4);
        // reset deprecated version slot
        CONTRACT_VERSION_POSITION_DEPRECATED.setStorageUint256(0);
    }

    function _getTime() internal view returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    function _getChainSpec()
        internal
        view
        returns (ChainSpec memory chainSpec)
    {
        uint256 data = BEACON_SPEC_POSITION.getStorageUint256();
        chainSpec.epochsPerFrame = uint64(data >> 192);
        chainSpec.slotsPerEpoch = uint64(data >> 128);
        chainSpec.secondsPerSlot = uint64(data >> 64);
        chainSpec.genesisTime = uint64(data);
        return chainSpec;
    }

    function _setChainSpec(ChainSpec memory _chainSpec) internal {
        require(_chainSpec.slotsPerEpoch > 0, "BAD_SLOTS_PER_EPOCH");
        require(_chainSpec.secondsPerSlot > 0, "BAD_SECONDS_PER_SLOT");
        require(_chainSpec.genesisTime > 0, "BAD_GENESIS_TIME");
        require(_chainSpec.epochsPerFrame > 0, "BAD_EPOCHS_PER_FRAME");

        uint256 data = (
            uint256(_chainSpec.epochsPerFrame) << 192 |
            uint256(_chainSpec.slotsPerEpoch) << 128 |
            uint256(_chainSpec.secondsPerSlot) << 64 |
            uint256(_chainSpec.genesisTime)
        );

        BEACON_SPEC_POSITION.setStorageUint256(data);
    }

    function _getAccountingOracleChainSpec(address _accountingOracleConsensusContract)
        internal
        view
        returns (ChainSpec memory spec)
    {
        IHashConsensus consensus = IHashConsensus(_accountingOracleConsensusContract);
        (uint256 slotsPerEpoch, uint256 secondsPerSlot, uint256 genesisTime) = consensus.getChainConfig();
        (, uint256 epochsPerFrame_) = consensus.getFrameConfig();

        spec.epochsPerFrame = uint64(epochsPerFrame_);
        spec.slotsPerEpoch = uint64(slotsPerEpoch);
        spec.secondsPerSlot = uint64(secondsPerSlot);
        spec.genesisTime = uint64(genesisTime);
    }

    function _getCurrentFrameFromAccountingOracle()
        internal
        view
        returns (
            uint256 frameEpochId,
            uint256 frameStartTime,
            uint256 frameEndTime
        )
    {
        ChainSpec memory spec = _getChainSpec();
        IHashConsensus consensus = _getAccountingConsensusContract();
        uint256 refSlot;
        (refSlot,) =  consensus.getCurrentFrame();

        // new accounting oracle's ref. slot is the last slot of the epoch preceding the one the frame starts at
        frameStartTime = spec.genesisTime + (refSlot + 1) * spec.secondsPerSlot;
        // new accounting oracle's frame ends at the timestamp of the frame's last slot; old oracle's frame
        // ended a second before the timestamp of the first slot of the next frame
        frameEndTime = frameStartTime + spec.secondsPerSlot * spec.slotsPerEpoch * spec.epochsPerFrame - 1;
        frameEpochId = (refSlot + 1) / spec.slotsPerEpoch;
    }

    function _getAccountingConsensusContract() internal view returns (IHashConsensus) {
        return IHashConsensus(IAccountingOracle(getAccountingOracle()).getConsensusContract());
    }
}
