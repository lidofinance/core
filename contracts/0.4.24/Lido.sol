// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.4.24;

import {AragonApp, UnstructuredStorage} from "@aragon/os/contracts/apps/AragonApp.sol";
import {SafeMath} from "@aragon/os/contracts/lib/math/SafeMath.sol";

import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";

import {StETHPermit} from "./StETHPermit.sol";
import {Versioned} from "./utils/Versioned.sol";
import {StakeLimitUtils, StakeLimitUnstructuredStorage, StakeLimitState} from "./lib/StakeLimitUtils.sol";
import {UnstructuredStorageExt} from "./utils/UnstructuredStorageExt.sol";
import {Math256} from "../common/lib/Math256.sol";

interface IStakingRouter {
    function getTotalFeeE4Precision() external view returns (uint16 totalFee);

    function TOTAL_BASIS_POINTS() external view returns (uint256);

    function getWithdrawalCredentials() external view returns (bytes32);

    function getStakingFeeAggregateDistributionE4Precision()
        external
        view
        returns (uint16 modulesFee, uint16 treasuryFee);

    function receiveDepositableEther() external payable;
}

interface IWithdrawalQueue {
    function unfinalizedStETH() external view returns (uint256);
    function isBunkerModeActive() external view returns (bool);
    function finalize(uint256 _lastIdToFinalize, uint256 _maxShareRate) external payable;
}

interface ILidoExecutionLayerRewardsVault {
    function withdrawRewards(uint256 _maxAmount) external returns (uint256 amount);
}

interface IWithdrawalVault {
    function withdrawWithdrawals(uint256 _amount) external;
}

interface IAccountingOracle {
    /// @dev returns a tuple instead of a structure to avoid allocating memory
    function getProcessingState()
        external
        view
        returns (
            uint256 currentFrameRefSlot,
            uint256 processingDeadlineTime,
            bytes32 mainDataHash,
            bool mainDataSubmitted,
            bytes32 extraDataHash,
            uint256 extraDataFormat,
            bool extraDataSubmitted,
            uint256 extraDataItemsCount,
            uint256 extraDataItemsSubmitted
        );
    function getLastProcessingRefSlot() external view returns (uint256);
    function getCurrentFrame() external view returns (uint256 refSlot, uint256 refSlotTimestamp);
}

/**
 * @title Liquid staking pool implementation
 *
 * Lido is an Ethereum liquid staking protocol solving the problem of frozen staked ether on the Consensus Layer
 * being unavailable for transfers and DeFi on the Execution Layer.
 *
 * Since balances of all token holders change when the amount of total pooled ether
 * changes, this token cannot fully implement ERC20 standard: it only emits `Transfer`
 * events upon explicit transfer between holders. In contrast, when the Lido oracle reports
 * rewards, no `Transfer` events are emitted: doing so would require an event for each token holder
 * and thus running an unbounded loop.
 *
 * ######### STRUCTURED STORAGE #########
 * NB: The order of inheritance must preserve the structured storage layout of the previous versions.
 *
 * @dev Lido is derived from `StETHPermit` that has a structured storage:
 * SLOT 0: mapping (address => uint256) private shares (`StETH`)
 * SLOT 1: mapping (address => mapping (address => uint256)) private allowances (`StETH`)
 * SLOT 2: mapping (address => uint256) internal noncesByAddress (`StETHPermit`)
 *
 * `Versioned` and `AragonApp` both don't have the pre-allocated structured storage.
 */
contract Lido is Versioned, StETHPermit, AragonApp {
    using SafeMath for uint256;
    using UnstructuredStorage for bytes32;
    using UnstructuredStorageExt for bytes32;
    using StakeLimitUnstructuredStorage for bytes32;
    using StakeLimitUtils for StakeLimitState.Data;

    /// ACL Roles
    bytes32 public constant PAUSE_ROLE = 0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d; // keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = 0x2fc10cc8ae19568712f7a176fb4978616a610650813c9d05326c34abb62749c7; // keccak256("RESUME_ROLE");
    bytes32 public constant STAKING_PAUSE_ROLE = 0x84ea57490227bc2be925c684e2a367071d69890b629590198f4125a018eb1de8; // keccak256("STAKING_PAUSE_ROLE")
    bytes32 public constant STAKING_CONTROL_ROLE = 0xa42eee1333c0758ba72be38e728b6dadb32ea767de5b4ddbaea1dae85b1b051f; // keccak256("STAKING_CONTROL_ROLE")
    bytes32 public constant BUFFER_RESERVE_MANAGER_ROLE =
        0x33969636f1fbf3d7d062d4de4a08e7bd3c46606ec28b3a4398d2665be559b921; // keccak256("BUFFER_RESERVE_MANAGER_ROLE")

    uint256 private constant DEPOSIT_SIZE = 32 ether;

    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    /// @dev storage slot position for the total and external shares (from StETH contract)
    /// Since version 3, high 128 bits are used for the external shares
    /// |----- 128 bit -----|------ 128 bit -------|
    /// |   external shares |     total shares     |
    /// keccak256("lido.StETH.totalAndExternalShares")
    bytes32 internal constant TOTAL_AND_EXTERNAL_SHARES_POSITION = TOTAL_SHARES_POSITION_LOW128;

    /// @dev storage slot position for the Lido protocol contracts locator
    /// Since version 3, high 96 bits are used for the max external ratio BP
    /// |----- 96 bit -----|------ 160 bit -------|
    /// |max external ratio| lido locator address |
    /// keccak256("lido.Lido.lidoLocatorAndMaxExternalRatio")
    bytes32 internal constant LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION =
        0xd92bc31601d11a10411d08f59b7146d8a5915af253cde25f8e66b67beb4be223;

    /// @dev amount of ether (on the current Ethereum side) buffered on this smart contract balance
    ///      and amount of ether depositedAmount since last report
    /// depositedEther lifecycle:
    ///   1) increased by `withdrawDepositableEther()` as CL deposits are performed;
    ///   2) resets on report processing via `processClStateUpdate()`
    /// |------ 128 bit -----|----- 128 bit ------|
    /// | depositedAmount ether    |   buffered ether   |
    /// keccak256("lido.Lido.bufferedEtherAndDepositedEther");
    // bytes32 internal constant BUFFERED_ETHER_AND_DEPOSITED_ETHER_POSITION =
    //     0x81a11fa1111afa59b50051f60ccf604a39d96acb484dc467ad8eadb4a63f0a5f;
    bytes32 internal constant BUFFERED_ETHER_AND_DEPOSITED_ETHER_POSITION =
        0xdb205d018b057469604c4e2a900fd6c14d63aa16e6ac9bc50e84780001cb2f90;

    /// @dev an internal counter accumulates the ETH depositedAmount after the reporting period/frame changes
    ///      and unique identifier for the last deposit's frame (in this case, it's current refSlot)
    /// keccak256("lido.Lido.depositedEtherFromLastRefSlotAndLastRefSlot")
    // bytes32 internal constant DEPOSITED_NEXT_REPORT_AND_LAST_DEPOSIT_NONCE_POSITION =
    //     0x8d3ed945c7718edcdb639b1235f2bbe3fa81f4a6cec7a436d8ea13fbc502d957;
    bytes32 internal constant DEPOSITED_ETHER_FROM_LAST_REFSLOT_AND_LAST_REFSLOT_POSITION =
        0x69c63ed80d1cd64fe4c57f231f0d9aa53a746bd67c8ab7a454a854b132b025ff;

    /// @dev CL validators balance and CL pending deposit balance
    /// |----- 128 bit ------------|------ 128 bit -------|
    /// | CL validators balance    |  CL pending balance  |
    /// keccak256("lido.Lido.clValidatorsBalanceAndClPendingBalance");
    bytes32 internal constant CL_VALIDATORS_BALANCE_AND_CL_PENDING_BALANCE_POSITION =
        0x096e465397f38e659238ccd5d5a2c434ced54a63fd8d694045bfb058ab9d8112;

    /// @dev number of initial seed deposits (incrementing counter), ex. depositedAmount validators
    /// keccak256("lido.Lido.seedDepositsCount");
    bytes32 internal constant SEED_DEPOSITS_COUNT_POSITION =
        0x3f0eaa2c0f16ff9775c078f3df30470d8c042317b24ad1defa240b1c3e10b238;

    /// @dev storage slot position of the staking rate limit structure
    /// keccak256("lido.Lido.stakeLimit");
    bytes32 internal constant STAKING_STATE_POSITION =
        0xa3678de4a579be090bed1177e0a24f77cc29d181ac22fd7688aca344d8938015;

    /// @dev storage slot position for the total amount of execution layer rewards received by Lido contract.
    /// keccak256("lido.Lido.totalELRewardsCollected");
    bytes32 internal constant TOTAL_EL_REWARDS_COLLECTED_POSITION =
        0xafe016039542d12eec0183bb0b1ffc2ca45b027126a494672fba4154ee77facb;

    /// @dev Storage slot for deposit reserve.
    /// Holds buffered ether that remains depositable even when withdrawals demand exists.
    /// Lifecycle:
    ///   1) can be decreased by `setDepositsReserveTarget()` when target is lowered;
    ///   2) consumed by `withdrawDepositableEther()` as CL deposits are performed;
    ///   3) synced to target on report processing via `_updateBufferedEtherAllocation()`
    /// keccak256("lido.Lido.depositsReserve")
    bytes32 internal constant DEPOSITS_RESERVE_POSITION =
        0xda4fbe3b9cbd98dfae5dff538bbff4ba61f38979d4d7419bcd006f3e6250ec13;

    /// @dev Storage slot for deposits reserve target.
    /// Stores governance-configured value that deposits reserve is restored to on each oracle report.
    /// Set via `setDepositsReserveTarget()`, gated by `BUFFER_RESERVE_MANAGER_ROLE`
    /// keccak256("lido.Lido.depositsReserveTarget")
    bytes32 internal constant DEPOSITS_RESERVE_TARGET_POSITION =
        0x3d3e9bd6e90e5d1f1c6839835bcbe5746a47c9a013d1eae6e80c248264c06a81;

    // Staking was paused (don't accept user's ether submits)
    event StakingPaused();
    // Staking was resumed (accept user's ether submits)
    event StakingResumed();
    // Staking limit was set (rate limits user's submits)
    event StakingLimitSet(uint256 maxStakeLimit, uint256 stakeLimitIncreasePerBlock);
    // Staking limit was removed
    event StakingLimitRemoved();

    // Emitted when CL balances are updated by the oracle
    event CLBalancesUpdated(uint256 indexed reportTimestamp, uint256 clValidatorsBalance, uint256 clPendingBalance);
    // Emitted when CL pending balance is updated during deposits to CL
    event DepositedEtherUpdated(uint256 depositedEther);

    // Emitted when depositedValidators value is changed
    event DepositedValidatorsChanged(uint256 depositedValidators);

    // Emitted when oracle accounting report processed
    // @dev `preCLBalance` is actually the principal CL balance: the sum of the previous report's
    //      CL validators balance, CL pending balance, and depositedAmount balance since the last report.
    //      The parameter name is kept for ABI backward compatibility.
    event ETHDistributed(
        uint256 indexed reportTimestamp,
        uint256 preCLBalance, // actually its preCLBalance + deposits due to compatibility reasons
        uint256 postCLBalance,
        uint256 withdrawalsWithdrawn,
        uint256 executionLayerRewardsWithdrawn,
        uint256 postBufferedEther
    );

    // Emitted when the token is rebased (an accounting oracle report is delivered)
    event TokenRebased(
        uint256 indexed reportTimestamp,
        uint256 timeElapsed,
        uint256 preTotalShares,
        uint256 preTotalEther,
        uint256 postTotalShares,
        uint256 postTotalEther,
        uint256 sharesMintedAsFees
    );

    // Lido locator set
    event LidoLocatorSet(address lidoLocator);

    // The amount of ETH withdrawn from LidoExecutionLayerRewardsVault to Lido
    event ELRewardsReceived(uint256 amount);

    // The amount of ETH withdrawn from WithdrawalVault to Lido
    event WithdrawalsReceived(uint256 amount);

    // Records a deposit made by a user
    event Submitted(address indexed sender, uint256 amount, address referral);

    // The `amount` of ether was sent to the deposit_contract.deposit function
    event Unbuffered(uint256 amount);

    // Internal share rate updated
    event InternalShareRateUpdated(
        uint256 indexed reportTimestamp,
        uint256 postInternalShares,
        uint256 postInternalEther,
        uint256 sharesMintedAsFees
    );

    // External shares minted for receiver
    event ExternalSharesMinted(address indexed receiver, uint256 amountOfShares);

    // External shares burned for account
    event ExternalSharesBurnt(uint256 amountOfShares);

    // Maximum ratio of external shares to total shares in basis points set
    event MaxExternalRatioBPSet(uint256 maxExternalRatioBP);

    // External ether transferred to buffer
    event ExternalEtherTransferredToBuffer(uint256 amount);

    // Bad debt internalized
    event ExternalBadDebtInternalized(uint256 amountOfShares);

    // Emitted when current deposits reserve is updated.
    // Can be emitted from `withdrawDepositableEther()`, `collectRewardsAndProcessWithdrawals()`,
    // and `setDepositsReserveTarget()` when target is lowered below current reserve.
    event DepositsReserveSet(uint256 depositsReserve);

    // Emitted when deposits reserve target is set via `setDepositsReserveTarget()`.
    // Emitted even if the new value equals the previous one
    event DepositsReserveTargetSet(uint256 depositsReserveTarget);

    /**
     * @notice Initializer function for scratch deploy of Lido contract
     *
     * @param _lidoLocator lido locator contract
     * @param _eip712StETH eip712 helper contract for StETH
     *
     * @dev NB: by default, staking and the whole Lido pool are in paused state
     * @dev The contract's balance must be non-zero to mint initial shares of stETH
     */
    function initialize(address _lidoLocator, address _eip712StETH) public payable onlyInit {
        _bootstrapInitialHolder(); // stone in the elevator

        _setLidoLocator(_lidoLocator);
        emit LidoLocatorSet(_lidoLocator);
        _initializeEIP712StETH(_eip712StETH);

        _setContractVersion(4);

        ILidoLocator locator = ILidoLocator(_lidoLocator);

        _approve(_withdrawalQueue(locator), _burner(locator), INFINITE_ALLOWANCE);
        initialized();
    }

    /**
     * @notice A function to finalize upgrade to v4 (from v3). Can be called only once
     */
    function finalizeUpgrade_v4() external {
        require(hasInitialized(), "NOT_INITIALIZED");

        /// @dev prevent migration if the last oracle report wasn't submitted, otherwise deposits
        ///      made after refSlot and before migration (i.e. report's tx) will be lost
        IAccountingOracle oracle = _accountingOracle();
        (,,, bool mainDataSubmitted,,,,,) = oracle.getProcessingState();
        require(mainDataSubmitted, "NO_REPORT");

        _checkContractVersion(3);
        _setContractVersion(4);
        _migrateStorage_v3_to_v4();
    }

    function _migrateStorage_v3_to_v4() internal {
        /// @dev storage slots used in v3
        // keccak256("lido.Lido.clBalanceAndClValidators")
        bytes32 CL_BALANCE_AND_CL_VALIDATORS_POSITION =
            0xc36804a03ec742b57b141e4e5d8d3bd1ddb08451fd0f9983af8aaab357a78e2f;
        // keccak256("lido.Lido.bufferedEtherAndDepositedValidators");
        bytes32 BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION =
            0xa84c096ee27e195f25d7b6c7c2a03229e49f1a2a5087e57ce7d7127707942fe3;

        (uint256 clValidatorsBalance, uint256 clValidators) =
            CL_BALANCE_AND_CL_VALIDATORS_POSITION.getLowAndHighUint128();
        (uint256 bufferedEther, uint256 depositedValidators) =
            BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.getLowAndHighUint128();

        /// @dev convert ex-transientBalance to amount submitted to the Deposit contract
        ///      after the last accounting oracle report
        uint256 depositedEther = (depositedValidators - clValidators) * DEPOSIT_SIZE;
        _setBufferedEtherAndDepositedEther(bufferedEther, depositedEther);
        /// @dev Since migration is only possible after a report and before the next frame begins,
        ///      the transient balance will apply to the current frame
        (uint256 refSlot,) = _getCurrentFrame(); // get current refslot
        _setDepositedEtherFromLastRefSlotAndLastRefSlot(depositedEther, refSlot);

        /// @dev no pending balance at the moment of upgrade
        _setClValidatorsBalanceAndClPendingBalance(clValidatorsBalance, 0);
        _setSeedDepositsCount(depositedValidators);

        // wipe out the slots
        CL_BALANCE_AND_CL_VALIDATORS_POSITION.setStorageUint256(0);
        BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.setStorageUint256(0);
    }

    /**
     * @notice Stop accepting new ether to the protocol
     *
     * @dev While accepting new ether is stopped, calls to the `submit` function,
     * as well as to the default payable function, will revert.
     */
    function pauseStaking() external {
        _auth(STAKING_PAUSE_ROLE);
        require(!isStakingPaused(), "ALREADY_PAUSED");

        _pauseStaking();
    }

    /**
     * @notice Resume accepting new ether to the protocol (if `pauseStaking` was called previously)
     * NB: Staking could be rate-limited by imposing a limit on the stake amount
     * at each moment in time, see `setStakingLimit()` and `removeStakingLimit()`
     *
     * @dev Preserves staking limit if it was set previously
     */
    function resumeStaking() external {
        _auth(STAKING_CONTROL_ROLE);
        require(hasInitialized(), "NOT_INITIALIZED");
        _whenNotStopped();
        require(isStakingPaused(), "ALREADY_RESUMED");

        _resumeStaking();
    }

    /**
     * @notice Set the staking rate limit
     *
     * ▲ Stake limit
     * │.....  .....   ........ ...            ....     ... Stake limit = max
     * │      .       .        .   .   .      .    . . .
     * │     .       .              . .  . . .      . .
     * │            .                .  . . .
     * │──────────────────────────────────────────────────> Time
     * │     ^      ^          ^   ^^^  ^ ^ ^     ^^^ ^     Stake events
     *
     * @dev Reverts if:
     * - `_maxStakeLimit` == 0
     * - `_maxStakeLimit` >= 2^95 (1/2 of uint96)
     * - `_maxStakeLimit` < `_stakeLimitIncreasePerBlock`
     * - `_maxStakeLimit` / `_stakeLimitIncreasePerBlock` >= 2^32 (only if `_stakeLimitIncreasePerBlock` != 0)
     *
     * @param _maxStakeLimit max stake limit value
     * @param _stakeLimitIncreasePerBlock stake limit increase per single block
     */
    function setStakingLimit(uint256 _maxStakeLimit, uint256 _stakeLimitIncreasePerBlock) external {
        _auth(STAKING_CONTROL_ROLE);

        require(_maxStakeLimit <= uint96(-1) / 2, "TOO_LARGE_MAX_STAKE_LIMIT");

        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct()
                .setStakingLimit(_maxStakeLimit, _stakeLimitIncreasePerBlock)
        );

        emit StakingLimitSet(_maxStakeLimit, _stakeLimitIncreasePerBlock);
    }

    /**
     * @notice Remove the staking rate limit
     */
    function removeStakingLimit() external {
        _auth(STAKING_CONTROL_ROLE);

        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().removeStakingLimit()
        );

        emit StakingLimitRemoved();
    }

    /**
     * @notice Check staking state: whether it's paused or not
     */
    function isStakingPaused() public view returns (bool) {
        return STAKING_STATE_POSITION.getStorageStakeLimitStruct().isStakingPaused();
    }

    /**
     * @return the maximum amount of ether that can be staked in the current block
     * @dev Special return values:
     * - 2^256 - 1 if staking is unlimited;
     * - 0 if staking is paused or if limit is exhausted.
     */
    function getCurrentStakeLimit() external view returns (uint256) {
        return _getCurrentStakeLimit(STAKING_STATE_POSITION.getStorageStakeLimitStruct());
    }

    /**
     * @notice Get the full info about current stake limit params and state
     * @dev Might be used for the advanced integration requests.
     * @return isStakingPaused_ staking pause state (equivalent to return of isStakingPaused())
     * @return isStakingLimitSet whether the stake limit is set
     * @return currentStakeLimit current stake limit (equivalent to return of getCurrentStakeLimit())
     * @return maxStakeLimit max stake limit
     * @return maxStakeLimitGrowthBlocks blocks needed to restore max stake limit from the fully exhausted state
     * @return prevStakeLimit previously reached stake limit
     * @return prevStakeBlockNumber previously seen block number
     */
    function getStakeLimitFullInfo()
        external
        view
        returns (
            bool isStakingPaused_,
            bool isStakingLimitSet,
            uint256 currentStakeLimit,
            uint256 maxStakeLimit,
            uint256 maxStakeLimitGrowthBlocks,
            uint256 prevStakeLimit,
            uint256 prevStakeBlockNumber
        )
    {
        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();

        isStakingPaused_ = stakeLimitData.isStakingPaused();
        isStakingLimitSet = stakeLimitData.isStakingLimitSet();

        currentStakeLimit = _getCurrentStakeLimit(stakeLimitData);

        maxStakeLimit = stakeLimitData.maxStakeLimit;
        maxStakeLimitGrowthBlocks = stakeLimitData.maxStakeLimitGrowthBlocks;
        prevStakeLimit = stakeLimitData.prevStakeLimit;
        prevStakeBlockNumber = stakeLimitData.prevStakeBlockNumber;
    }

    /**
     * @return the maximum allowed external shares ratio as basis points of total shares [0-10000]
     */
    function getMaxExternalRatioBP() external view returns (uint256) {
        return _getMaxExternalRatioBP();
    }

    /**
     * @notice Set the maximum allowed external shares ratio as basis points of total shares
     * @param _maxExternalRatioBP The maximum ratio in basis points [0-10000]
     */
    function setMaxExternalRatioBP(uint256 _maxExternalRatioBP) external {
        _auth(STAKING_CONTROL_ROLE);

        _setMaxExternalRatioBP(_maxExternalRatioBP);
    }

    /**
     * @notice Send funds to the pool and mint StETH to the `msg.sender` address
     * @dev Users are able to submit their funds by sending ether to the contract address
     * Unlike vanilla Ethereum Deposit contract, accepting only 32-Ether transactions, Lido
     * accepts payments of any size. Submitted ether is stored in the buffer until someone calls
     * deposit() and pushes it to the Ethereum Deposit contract.
     */
    // solhint-disable-next-line no-complex-fallback
    function() external payable {
        // protection against accidental submissions by calling non-existent function
        require(msg.data.length == 0, "NON_EMPTY_DATA");
        _submit(0);
    }

    /**
     * @notice Send funds to the pool with the optional `_referral` parameter and mint StETH to the `msg.sender` address
     * @param _referral optional referral address
     * @return Amount of StETH shares minted
     */
    function submit(address _referral) external payable returns (uint256) {
        return _submit(_referral);
    }

    /**
     * @notice A payable function for execution layer rewards. Can be called only by `ExecutionLayerRewardsVault`
     * @dev We need a dedicated function because funds received by the default payable function
     * are treated as a user deposit
     */
    function receiveELRewards() external payable {
        _auth(_elRewardsVault());

        TOTAL_EL_REWARDS_COLLECTED_POSITION.setStorageUint256(getTotalELRewardsCollected().add(msg.value));

        emit ELRewardsReceived(msg.value);
    }

    /**
     * @notice A payable function for withdrawals acquisition. Can be called only by `WithdrawalVault`
     * @dev We need a dedicated function because funds received by the default payable function
     * are treated as a user deposit
     */
    function receiveWithdrawals() external payable {
        _auth(_withdrawalVault());

        emit WithdrawalsReceived(msg.value);
    }

    /**
     * @notice Stop pool routine operations
     */
    function stop() external {
        _auth(PAUSE_ROLE);

        _stop();
        _pauseStaking();
    }

    /**
     * @notice Resume pool routine operations
     * @dev Staking is resumed after this call using the previously set limits (if any)
     */
    function resume() external {
        _auth(RESUME_ROLE);

        _resume();
        _resumeStaking();
    }

    /**
     * @return the amount of ether temporarily buffered on this contract balance
     * @dev Buffered balance is kept on the contract from the moment the funds are received from user
     * until the moment they are actually sent to the official Deposit contract or used to fulfill withdrawal requests
     */
    function getBufferedEther() external view returns (uint256) {
        return _getBufferedEther();
    }

    /**
     * @notice Buffered ether split into reserve buckets.
     * @param total Total buffered ether, equal to `getBufferedEther()`.
     * @param unreserved Buffer remainder after both reserves are filled. Available for additional CL deposits
     *        beyond the deposits reserve
     * @param depositsReserve Buffer portion available for CL deposits, protected from withdrawals demand.
     *        Resets on each oracle report, decreases via `withdrawDepositableEther()`
     * @param withdrawalsReserve Buffer portion allocated to unfinalized withdrawals. Not depositable to CL.
     *        Zero when all withdrawal requests are finalized
     */
    struct BufferedEtherAllocation {
        uint256 total;
        uint256 unreserved;
        uint256 depositsReserve;
        uint256 withdrawalsReserve;
    }

    /**
     * @notice Calculates buffered ether allocation across reserves
     * @dev Buffer is split by priority:
     *
     *      1. depositsReserve    - per-frame CL deposit allowance, filled first
     *      2. withdrawalsReserve - covers unfinalized withdrawal requests
     *      3. unreserved         - excess, available for additional CL deposits
     *
     *      ┌─────────── Total Buffered Ether ───────────┐
     *      ├────────────────────┬───────────────────────┼─────┬──────────────┐
     *      │●●●●●●●●●●●●●●●●●●●●│●●●●●●●●●●●●●●●●●●●●●●●●○○○○○│○○○○○○○○○○○○○○│
     *      ├────────────────────┼───────────────────────┼─────┼──────────────┤
     *      └─ Deposits Reserve ─┼─ Withdrawals Reserve ─┘     ├─ Unreserved ─┘
     *                           └───── Unfinalized stETH ─────┘
     *
     *      ● - covered by Buffered Ether
     *      ○ - not covered by Buffered Ether
     *
     *      depositsReserve    = min(total, stored deposits reserve)
     *      withdrawalsReserve = min(total - depositsReserve, unfinalizedStETH)
     *      unreserved         = total - depositsReserve - withdrawalsReserve
     */
    function _getBufferedEtherAllocation() internal view returns (BufferedEtherAllocation allocation) {
        uint256 remaining = _getBufferedEther();
        allocation.total = remaining;

        allocation.depositsReserve = Math256.min(remaining, DEPOSITS_RESERVE_POSITION.getStorageUint256());
        remaining -= allocation.depositsReserve;

        allocation.withdrawalsReserve = Math256.min(remaining, _withdrawalQueue().unfinalizedStETH());
        remaining -= allocation.withdrawalsReserve;

        allocation.unreserved = remaining;
    }

    /**
     * @notice Returns the currently effective deposits reserve — buffer portion available for CL deposits, protected
     *         from withdrawals demand
     * @dev Capped by current buffered ether. See `_getBufferedEtherAllocation()`
     */
    function getDepositsReserve() external view returns (uint256 depositsReserve) {
        return _getBufferedEtherAllocation().depositsReserve;
    }

    /**
     * @dev Stores new deposits reserve value and emits DepositsReserveSet event
     */
    function _setDepositsReserve(uint256 _newDepositsReserve) internal {
        DEPOSITS_RESERVE_POSITION.setStorageUint256(_newDepositsReserve);
        emit DepositsReserveSet(_newDepositsReserve);
    }

    /**
     * @notice Returns the currently effective withdrawals reserve
     * @dev This reserve is computed after deposits reserve is applied
     * @return Amount reserved to satisfy unfinalized withdrawals
     */
    function getWithdrawalsReserve() external view returns (uint256) {
        return _getBufferedEtherAllocation().withdrawalsReserve;
    }

    /**
     * @notice Returns configured target for deposits reserve
     * @return depositsReserveTarget Configured reserve target in wei
     */
    function getDepositsReserveTarget() public view returns (uint256) {
        return DEPOSITS_RESERVE_TARGET_POSITION.getStorageUint256();
    }

    /**
     * @notice Sets deposits reserve target
     * @dev Always updates target and emits DepositsReserveTargetSet
     *      If target is lowered below current reserve, reserve is reduced immediately
     *      If target is increased, reserve is not increased here and is synced on report processing via
     *      `_updateBufferedEtherAllocation()`
     * @param _newDepositsReserveTarget New target value in wei
     */
    function setDepositsReserveTarget(uint256 _newDepositsReserveTarget) external {
        _auth(BUFFER_RESERVE_MANAGER_ROLE);

        DEPOSITS_RESERVE_TARGET_POSITION.setStorageUint256(_newDepositsReserveTarget);
        emit DepositsReserveTargetSet(_newDepositsReserveTarget);

        uint256 currentDepositsReserve = DEPOSITS_RESERVE_POSITION.getStorageUint256();
        // Do not increase reserve mid-frame: this could reduce available ETH for withdrawals finalization
        // relative to the report reference slot assumptions. Increases are applied on oracle report processing.
        if (_newDepositsReserveTarget < currentDepositsReserve) {
            _setDepositsReserve(_newDepositsReserveTarget);
        }
    }

    /**
     * @return the amount of ether held by external sources to back external shares
     */
    function getExternalEther() external view returns (uint256) {
        return _getExternalEther(_getInternalEther());
    }

    /**
     * @return the total amount of shares backed by external ether sources
     */
    function getExternalShares() external view returns (uint256) {
        return _getExternalShares();
    }

    /**
     * @return the maximum amount of external shares that can be minted under the current external ratio limit
     */
    function getMaxMintableExternalShares() external view returns (uint256) {
        return _getMaxMintableExternalShares();
    }

    /**
     * @return the total amount of Execution Layer rewards collected to the Lido contract
     * @dev ether received through LidoExecutionLayerRewardsVault is kept on this contract's balance the same way
     * as other buffered ether is kept (until it gets depositedAmount or withdrawn)
     */
    function getTotalELRewardsCollected() public view returns (uint256) {
        return TOTAL_EL_REWARDS_COLLECTED_POSITION.getStorageUint256();
    }

    /**
     * @return the Lido Locator address
     */
    function getLidoLocator() external view returns (ILidoLocator) {
        return _getLidoLocator();
    }

    /**
     * @dev DEPRECATED: Use getBalanceStats() for new integrations
     * @notice Get the key values related to the Consensus Layer side of the contract.
     * @return depositedValidators - number of depositedAmount validators from Lido contract side
     * @return beaconValidators - number of Lido validators visible on Consensus Layer, reported by oracle
     * @return beaconBalance - total amount of ether on the Consensus Layer side (sum of all the balances of Lido validators)
     */
    function getBeaconStat()
        external
        view
        returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance)
    {
        depositedValidators = _getSeedDepositsCount();
        (uint256 clValidatorsBalance, uint256 clPendingBalance) = _getClValidatorsBalanceAndClPendingBalance();
        /// @dev Since there is now no gap between the deposit on EL and its observation on the CL layer,
        ///      for compatibility, beaconValidators = depositedValidators.
        /// @dev beaconBalance returned as sum of active and pending balances because this amounts
        ///      are visible on the CL side at moment of report
        return (depositedValidators, depositedValidators, clValidatorsBalance.add(clPendingBalance));
    }

    /// @notice Returns the balances and deposits state as of the time of the last report
    /// @return clValidatorsBalance Sum of validator's active balances in wei at last report
    /// @return clPendingBalance Sum of validator's pending deposits in wei at last report
    /// @return depositedAmount Deposits made since last oracle report
    /// @return depositedAmountForLastRefSlot Deposits made since last oracle report and up to the last refSlot
    function getBalanceStats()
        external
        view
        returns (
            uint256 clValidatorsBalance,
            uint256 clPendingBalance,
            uint256 depositedAmount,
            uint256 depositedAmountForLastRefSlot
        )
    {
        (clValidatorsBalance, clPendingBalance) = _getClValidatorsBalanceAndClPendingBalance();

        depositedAmount = _getDepositedEther();
        (uint256 depositedEtherFromLastRefSlot,) = _getDepositedEtherFromLastRefSlot();
        /// @dev depositedEtherFromLastRefSlot is always less than depositedEther, so we can safely subtract
        depositedAmountForLastRefSlot = depositedAmount - depositedEtherFromLastRefSlot;
    }

    /**
     * To accurately track the ETH that was depositedAmount between the refSlot and the report transaction, we use the following
     * approach:
     *
     * Data structure can be represented as:
     *   - lastRefSlot - last deposit refSlot
     *   - depositedEther - total sum of all deposits across all periods since the last successful report
     *   - depositedEtherFromLastRefSlot - sum of deposits within the current reporting period (i.e. made since lastRefSlot),
     *   - to be included in the next report
     *
     * Flow diagram:
     *                                                              NOW
     *                     ┌── depositedEther ─-----───────────────┐ ↓
     *      │○○○○○○○○○○○○○○│○●●○○R○○○●○○●○│○○●●●○○●○●○○○○│○○●●○○●○○●○○○○│
     *      ┆         lastReport-↑       currentRefSlot-↑└────⁠┬────┘
     *      ┆              ┆ currentReportFrame-↓        ┆    └depositedEtherFromLastRefSlot
     *      ⁠║   frame X    ⁠║   frame X+1  ⁠║   frame X+2  ⁠║   frame X+3  ⁠║
     *
     *       R - report transaction slot
     *       ● - slot with deposits
     *       ○ - empty slot
     *       ⁠║ - frame refSlot
     *
     * Logic:
     *   - On any read/write operation, we first retrieve currentRefSlot
     *   - Whenever the refSlot changes (i.e. the reporting period changes), we reset depositedEtherFromLastRefSlot to zero
     *   - To obtain the exact deposit amount for the reporting periods, we compute:  depositedEther - depositedEtherFromLastRefSlot
     *   - On each deposit, both counters are incremented:  depositedEther += amount and depositedEtherFromLastRefSlot += amount
     *   - At reporting time, deposits already accounted for in the report are excluded from depositedEther, leaving
     *     only the current period: depositedEther = depositedEtherFromLastRefSlot
     */
    /// @dev read and adjust the `depositedEtherFromLastRefSlot` value according to the current frame
    function _getDepositedEtherFromLastRefSlot()
        internal
        view
        returns (uint256 depositedEtherFromLastRefSlot, uint256 refSlot)
    {
        uint256 lastRefSlot;
        (depositedEtherFromLastRefSlot, lastRefSlot) = _getDepositedEtherFromLastRefSlotAndLastRefSlot();
        (refSlot,) = _getCurrentFrame(); // get current refSlot
        if (refSlot != lastRefSlot) {
            // treating all unsettled amounts as belonging to previous periods,
            // i.e., as already settled (accounted in upcoming report)
            depositedEtherFromLastRefSlot = 0;
        }
    }

    /// @dev get currentFrameRefSlot from oracle processing state
    function _getCurrentFrame() internal view returns (uint256 refSlot, uint256 refSlotTimestamp) {
        (refSlot, refSlotTimestamp) = _accountingOracle().getCurrentFrame();
    }

    /**
     * @notice Check that Lido allows depositing buffered ether to the Consensus Layer
     * @dev Depends on the bunker mode and protocol pause state
     */
    function canDeposit() public view returns (bool) {
        return !_withdrawalQueue().isBunkerModeActive() && !isStopped();
    }

    /**
     * @return the amount of ether in the buffer that can be deposited to the Consensus Layer
     * @dev Equals buffered ether minus withdrawals reserve from `_getBufferedEtherAllocation()`
     */
    function getDepositableEther() external view returns (uint256) {
        return _getDepositableEther(_getBufferedEtherAllocation());
    }

    /**
     * @notice Calculates depositable amount from precomputed buffer allocation
     * @return Depositable amount, equal to `allocation.depositsReserve + allocation.unreserved`
     */
    function _getDepositableEther(BufferedEtherAllocation allocation) internal pure returns (uint256) {
        return allocation.depositsReserve + allocation.unreserved;
    }

    /**
     * @dev Spends depositable buffer and updates stored deposits reserve accordingly.
     *      Decreases stored deposits reserve by spent amount, bounded below by zero
     */
    function _spendDepositableEther(uint256 _depositAmount) internal {
        BufferedEtherAllocation memory allocation = _getBufferedEtherAllocation();
        uint256 depositableEther = _getDepositableEther(allocation);
        require(_depositAmount <= depositableEther, "NOT_ENOUGH_ETHER");

        /// @dev the requested amount will be sent to DepositContract, so we increment
        ///      depositedEther counter to keep _getInternalEther value correct
        uint256 depositedEther = _getDepositedEther().add(_depositAmount);
        _setBufferedEtherAndDepositedEther(allocation.total.sub(_depositAmount), depositedEther);
        emit Unbuffered(_depositAmount);

        (uint256 depositedEtherFromLastRefSlot, uint256 refSlot) = _getDepositedEtherFromLastRefSlot();
        depositedEtherFromLastRefSlot = depositedEtherFromLastRefSlot.add(_depositAmount);
        _setDepositedEtherFromLastRefSlotAndLastRefSlot(depositedEtherFromLastRefSlot, refSlot);

        uint256 storedDepositsReserve = DEPOSITS_RESERVE_POSITION.getStorageUint256();
        if (storedDepositsReserve > 0) {
            _setDepositsReserve(storedDepositsReserve > _depositAmount ? storedDepositsReserve - _depositAmount : 0);
        }
    }

    /**
     * @notice Withdraw `_amount` of buffer to Staking Router
     * @dev Can be called only by the Staking Router contract
     * @notice _seedDepositsCount - DEPRECATED, it is used only for backward compatibility
     *
     * @param _amount amount of ETH to withdraw
     * @param _seedDepositsCount amount of seed deposits. In case of top up this value will be equal to 0
     */
    function withdrawDepositableEther(uint256 _amount, uint256 _seedDepositsCount) external {
        require(canDeposit(), "CAN_NOT_DEPOSIT");
        IStakingRouter stakingRouter = _stakingRouter();
        _auth(address(stakingRouter));
        require(_amount != 0, "ZERO_AMOUNT");

        _spendDepositableEther(_amount);

        if (_seedDepositsCount > 0) {
            uint256 newSeedDepositsCount = _getSeedDepositsCount().add(_seedDepositsCount);
            _setSeedDepositsCount(newSeedDepositsCount);
            /// @dev event name is kept for backward compatibility
            emit DepositedValidatorsChanged(newSeedDepositsCount);
        }

        /// @dev forward the requested amount of ether to the StakingRouter
        stakingRouter.receiveDepositableEther.value(_amount)();
    }

    /**
     * @notice Mint stETH shares
     * @param _recipient recipient of the shares
     * @param _amountOfShares amount of shares to mint
     * @dev can be called only by accounting
     */
    function mintShares(address _recipient, uint256 _amountOfShares) external {
        _auth(_accounting());
        _whenNotStopped();

        _mintShares(_recipient, _amountOfShares);
        _emitTransferAfterMintingShares(_recipient, _amountOfShares);
    }

    /**
     * @notice Burn stETH shares from the `msg.sender` address
     * @param _amountOfShares amount of shares to burn
     * @dev can be called only by burner
     */
    function burnShares(uint256 _amountOfShares) external {
        _auth(_burner());
        _whenNotStopped();

        uint256 preRebaseTokenAmount = getPooledEthByShares(_amountOfShares);
        _burnShares(msg.sender, _amountOfShares);
        uint256 postRebaseTokenAmount = getPooledEthByShares(_amountOfShares);

        // Historically, Lido contract does not emit Transfer to zero address events
        // for burning but emits SharesBurnt instead, so it's kept here for compatibility
        _emitSharesBurnt(msg.sender, preRebaseTokenAmount, postRebaseTokenAmount, _amountOfShares);
    }

    /**
     * @notice Mint shares backed by external ether sources
     * @param _recipient Address to receive the minted shares
     * @param _amountOfShares Amount of shares to mint
     * @dev Can be called only by VaultHub
     *      NB: Reverts if the external balance limit is exceeded.
     */
    function mintExternalShares(address _recipient, uint256 _amountOfShares) external {
        require(_amountOfShares != 0, "MINT_ZERO_AMOUNT_OF_SHARES");
        _auth(_vaultHub());
        _whenNotStopped();

        require(_amountOfShares <= _getMaxMintableExternalShares(), "EXTERNAL_BALANCE_LIMIT_EXCEEDED");

        _decreaseStakingLimit(getPooledEthByShares(_amountOfShares));

        _setExternalShares(_getExternalShares() + _amountOfShares);
        _mintShares(_recipient, _amountOfShares);

        _emitTransferAfterMintingShares(_recipient, _amountOfShares);

        emit ExternalSharesMinted(_recipient, _amountOfShares);
    }

    /**
     * @notice Burn external shares from the `msg.sender` address
     * @param _amountOfShares Amount of shares to burn
     * @dev can be called only by VaultHub
     */
    function burnExternalShares(uint256 _amountOfShares) external {
        require(_amountOfShares != 0, "BURN_ZERO_AMOUNT_OF_SHARES");
        _auth(_vaultHub());
        _whenNotStopped();

        uint256 externalShares = _getExternalShares();

        if (externalShares < _amountOfShares) revert("EXT_SHARES_TOO_SMALL");
        _setExternalShares(externalShares - _amountOfShares);
        _burnShares(msg.sender, _amountOfShares);

        uint256 stethAmount = getPooledEthByShares(_amountOfShares);
        _increaseStakingLimit(stethAmount);

        // Historically, Lido contract does not emit Transfer to zero address events
        // for burning but emits SharesBurnt instead, so it's kept here for compatibility
        // we use the same `stethAmount` here as external shares burn does not change share rate
        _emitSharesBurnt(msg.sender, stethAmount, stethAmount, _amountOfShares);
        emit ExternalSharesBurnt(_amountOfShares);
    }

    /**
     * @notice Transfer ether to the buffer decreasing the number of external shares in the same time
     * @param _amountOfShares Amount of external shares to burn
     * @dev it's an equivalent of using `submit` and then `burnExternalShares`
     * but without any limits or pauses
     *
     * - msg.value is transferred to the buffer
     */
    function rebalanceExternalEtherToInternal(uint256 _amountOfShares) external payable {
        require(msg.value != 0, "ZERO_VALUE");
        _auth(_vaultHub());
        _whenNotStopped();

        if (msg.value != getPooledEthBySharesRoundUp(_amountOfShares)) {
            revert("VALUE_SHARES_MISMATCH");
        }

        uint256 externalShares = _getExternalShares();

        if (externalShares < _amountOfShares) revert("EXT_SHARES_TOO_SMALL");

        // here the external balance is decreased (totalShares remains the same)
        _setExternalShares(externalShares - _amountOfShares);

        // here the buffer is increased
        _setBufferedEther(_getBufferedEther() + msg.value);

        // the result can be a smallish rebase like 1-2 wei per tx
        // but it's not worth then using submit for it,
        // so invariants are the same
        emit ExternalEtherTransferredToBuffer(msg.value);
        emit ExternalSharesBurnt(_amountOfShares);
    }

    /**
     * @notice Process CL related state changes as a part of the report processing
     * @dev All data validation was done by Accounting and OracleReportSanityChecker
     * @dev Replaces validator counting in v3 with direct balance tracking for EIP-7251 support
     * @param _reportTimestamp timestamp of the report
     * @param _clValidatorsBalance Validators balance on the consensus layer
     * @param _clPendingBalance Pending deposits balance on the consensus layer
     */
    function processClStateUpdate(uint256 _reportTimestamp, uint256 _clValidatorsBalance, uint256 _clPendingBalance)
        external
    {
        _whenNotStopped();
        _auth(_accounting());

        (uint256 depositedEtherFromLastRefSlot, uint256 refSlot) = _getDepositedEtherFromLastRefSlot();
        /// @dev just save adjusted depositedEtherFromLastRefSlot
        _setDepositedEtherFromLastRefSlotAndLastRefSlot(depositedEtherFromLastRefSlot, refSlot);
        /// @dev Since `depositedEther` accumulates all deposits, including those that occurred
        ///      after `refSlot` but before the report, we must retain only the amount not
        ///      reflected in the report
        _setDepositedEther(depositedEtherFromLastRefSlot);

        /// @dev new values of clValidatorsBalance and clPendingBalance should reflect all
        ///      deposits during the report frame
        _setClValidatorsBalanceAndClPendingBalance(_clValidatorsBalance, _clPendingBalance);
        emit CLBalancesUpdated(_reportTimestamp, _clValidatorsBalance, _clPendingBalance);
    }

    /**
     * @notice Internalize external bad debt
     * @param _amountOfShares amount of shares to internalize
     */
    function internalizeExternalBadDebt(uint256 _amountOfShares) external {
        require(_amountOfShares != 0, "BAD_DEBT_ZERO_SHARES");
        _whenNotStopped();
        _auth(_accounting());

        uint256 externalShares = _getExternalShares();

        require(externalShares >= _amountOfShares, "EXT_SHARES_TOO_SMALL");

        // total shares remains the same
        // external shares are decreased
        // => external ether is decreased as well
        // internal shares are increased
        // internal ether stays the same
        // => total pooled ether is decreased
        // => share rate is decreased
        // ==> losses are split between token holders
        _setExternalShares(externalShares - _amountOfShares);

        emit ExternalBadDebtInternalized(_amountOfShares);
        emit ExternalSharesBurnt(_amountOfShares);
    }

    /**
     * @notice Process withdrawals and collect rewards as a part of the report processing
     * @dev All data validation was done by Accounting and OracleReportSanityChecker
     * @param _reportTimestamp timestamp of the report
     * @param _reportClBalance total balance of validators reported by the oracle
     * @param _principalCLBalance total balance of validators in the previous report and deposits made since then
     * @param _withdrawalsToWithdraw amount of withdrawals to collect from WithdrawalsVault
     * @param _elRewardsToWithdraw amount of EL rewards to collect from ELRewardsVault
     * @param _lastWithdrawalRequestToFinalize last withdrawal request ID to finalize
     * @param _withdrawalsShareRate share rate used to fulfill withdrawal requests
     * @param _etherToLockOnWithdrawalQueue amount of ETH to lock on the WithdrawalQueue to fulfill withdrawal requests
     */
    function collectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _principalCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _withdrawalsShareRate,
        uint256 _etherToLockOnWithdrawalQueue
    ) external {
        _whenNotStopped();

        ILidoLocator locator = _getLidoLocator();
        _auth(_accounting(locator));

        // withdraw execution layer rewards and put them to the buffer
        if (_elRewardsToWithdraw > 0) {
            _elRewardsVault(locator).withdrawRewards(_elRewardsToWithdraw);
        }

        // withdraw withdrawals and put them to the buffer
        if (_withdrawalsToWithdraw > 0) {
            _withdrawalVault(locator).withdrawWithdrawals(_withdrawalsToWithdraw);
        }

        // finalize withdrawals (send ether, assign shares for burning)
        if (_etherToLockOnWithdrawalQueue > 0) {
            _withdrawalQueue(locator)
            .finalize
            .value(_etherToLockOnWithdrawalQueue)(_lastWithdrawalRequestToFinalize, _withdrawalsShareRate);
        }

        uint256 postBufferedEther = _getBufferedEther()
            .add(_elRewardsToWithdraw) // Collected from ELVault
            .add(_withdrawalsToWithdraw) // Collected from WithdrawalVault
            .sub(_etherToLockOnWithdrawalQueue); // Sent to WithdrawalQueue

        _setBufferedEther(postBufferedEther);
        _updateBufferedEtherAllocation();

        emit ETHDistributed(
            _reportTimestamp,
            _principalCLBalance,
            _reportClBalance,
            _withdrawalsToWithdraw,
            _elRewardsToWithdraw,
            postBufferedEther
        );
    }

    /**
     * @dev Syncs stored deposits reserve to configured target after oracle report processing
     */
    function _updateBufferedEtherAllocation() internal {
        uint256 depositsReserveTarget = getDepositsReserveTarget();
        uint256 depositsReserve = DEPOSITS_RESERVE_POSITION.getStorageUint256();

        if (depositsReserve != depositsReserveTarget) {
            _setDepositsReserve(depositsReserveTarget);
        }
    }

    /**
     * @notice Emits the `TokenRebase` and `InternalShareRateUpdated` events
     * @param _reportTimestamp timestamp of the refSlot block for the report applied
     * @param _timeElapsed seconds since the previous applied report
     * @param _preTotalShares the total number of shares before the oracle report tx
     * @param _preTotalEther the total amount of ether before the oracle report tx
     * @param _postTotalShares the total number of shares after the oracle report tx
     * @param _postTotalEther the total amount of ether after the oracle report tx
     * @param _postInternalShares the total number of internal shares after the oracle report tx
     * @param _postInternalEther the total amount of internal ether after the oracle tx
     * @param _sharesMintedAsFees the number of shares minted to pay fees to Lido and StakingModules
     * @dev these events are used to calculate protocol gross (without protocol fees deducted) and net APR (StETH APR)
     *
     *      preShareRate = preTotalEther * 1e27 / preTotalShares
     *      postShareRate = postTotalEther * 1e27 / postTotalShares
     *      NET_APR = SECONDS_IN_YEAR * ((postShareRate - preShareRate) / preShareRate) / timeElapsed
     *      postShareRateNoFees = postInternalEther * 1e27 / (postInternalShares - sharesMintedAsFees)
     *      GROSS_APR = SECONDS_IN_YEAR * (postShareRateNoFees - preShareRate) / preShareRate / timeElapsed
     *
     */
    function emitTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _postInternalShares,
        uint256 _postInternalEther,
        uint256 _sharesMintedAsFees
    ) external {
        _auth(_accounting());

        emit TokenRebased(
            _reportTimestamp,
            _timeElapsed,
            _preTotalShares,
            _preTotalEther,
            _postTotalShares,
            _postTotalEther,
            _sharesMintedAsFees
        );

        emit InternalShareRateUpdated(_reportTimestamp, _postInternalShares, _postInternalEther, _sharesMintedAsFees);
    }

    /**
     * @notice Overrides default AragonApp behavior to disallow recovery.
     */
    function transferToVault(
        address /* _token */
    )
        external
    {
        revert("NOT_SUPPORTED");
    }

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////// DEPRECATED PUBLIC METHODS ///////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    /**
     * @notice DEPRECATED: Returns current 0x01 withdrawal credentials of deposited validators
     * @dev DEPRECATED: use StakingRouter.getWithdrawalCredentials() instead
     */
    function getWithdrawalCredentials() external view returns (bytes32) {
        return _stakingRouter().getWithdrawalCredentials();
    }

    /**
     * @notice DEPRECATED: Returns the treasury address
     * @dev DEPRECATED: use LidoLocator.treasury()
     */
    function getTreasury() external view returns (address) {
        return _getLidoLocator().treasury();
    }

    /**
     * @notice DEPRECATED: Returns current staking rewards fee rate
     * @dev DEPRECATED: Now fees information is stored in StakingRouter and
     * with higher precision. Use StakingRouter.getStakingFeeAggregateDistribution() instead.
     * @return totalFee total rewards fee in 1e4 precision (10000 is 100%). The value might be
     * inaccurate because the actual value is truncated here to 1e4 precision.
     */
    function getFee() external view returns (uint16 totalFee) {
        totalFee = _stakingRouter().getTotalFeeE4Precision();
    }

    /**
     * @notice DEPRECATED: Returns current fee distribution, values relative to the total fee (getFee())
     * @dev DEPRECATED: Now fees information is stored in StakingRouter and
     * with higher precision. Use StakingRouter.getStakingFeeAggregateDistribution() instead.
     * @return treasuryFeeBasisPoints return treasury fee in TOTAL_BASIS_POINTS (10000 is 100% fee) precision
     * @return insuranceFeeBasisPoints always returns 0 because the capability to send fees to
     * insurance from Lido contract is removed.
     * @return operatorsFeeBasisPoints return total fee for all operators of all staking modules in
     * TOTAL_BASIS_POINTS (10000 is 100% fee) precision.
     * Previously returned total fee of all node operators of NodeOperatorsRegistry (Curated staking module now)
     * The value might be inaccurate because the actual value is truncated here to 1e4 precision.
     */
    function getFeeDistribution()
        external
        view
        returns (uint16 treasuryFeeBasisPoints, uint16 insuranceFeeBasisPoints, uint16 operatorsFeeBasisPoints)
    {
        IStakingRouter stakingRouter = _stakingRouter();
        uint256 totalBasisPoints = stakingRouter.TOTAL_BASIS_POINTS();
        uint256 totalFee = stakingRouter.getTotalFeeE4Precision();
        (uint256 treasuryFeeBasisPointsAbs, uint256 operatorsFeeBasisPointsAbs) =
            stakingRouter.getStakingFeeAggregateDistributionE4Precision();

        insuranceFeeBasisPoints = 0; // explicitly set to zero
        treasuryFeeBasisPoints = uint16((treasuryFeeBasisPointsAbs * totalBasisPoints) / totalFee);
        operatorsFeeBasisPoints = uint16((operatorsFeeBasisPointsAbs * totalBasisPoints) / totalFee);
    }

    /// @dev Process user deposit, mint liquid tokens and increase the pool buffer
    /// @param _referral address of referral.
    /// @return amount of StETH shares minted
    function _submit(address _referral) internal returns (uint256) {
        require(msg.value != 0, "ZERO_DEPOSIT");

        _decreaseStakingLimit(msg.value);

        uint256 sharesAmount = getSharesByPooledEth(msg.value);

        _mintShares(msg.sender, sharesAmount);

        _setBufferedEther(_getBufferedEther() + msg.value);
        emit Submitted(msg.sender, msg.value, _referral);

        _emitTransferAfterMintingShares(msg.sender, sharesAmount);
        return sharesAmount;
    }

    /// @dev Get the total amount of ether controlled by the protocol internally
    /// (buffered ether + CL validators balance + CL pending balance + deposited since last report)
    function _getInternalEther() internal view returns (uint256) {
        (uint256 bufferedEther, uint256 depositedEther) = _getBufferedEtherAndDepositedEther();
        (uint256 clValidatorsBalance, uint256 clPendingBalance) = _getClValidatorsBalanceAndClPendingBalance();

        // With balance-based accounting, we don't need to calculate transientEther
        // as pending deposits are already included in clPendingBalance
        return bufferedEther.add(clValidatorsBalance).add(clPendingBalance).add(depositedEther);
    }

    /// @dev Calculate the amount of ether controlled by external entities
    function _getExternalEther(uint256 _internalEther) internal view returns (uint256) {
        (uint256 totalShares, uint256 externalShares) = _getTotalAndExternalShares();
        uint256 internalShares = totalShares - externalShares;
        return (externalShares * _internalEther) / internalShares;
    }

    /// @dev Get the total amount of ether controlled by the protocol and external entities
    /// @return total balance in wei
    function _getTotalPooledEther() internal view returns (uint256) {
        uint256 internalEther = _getInternalEther();
        return internalEther.add(_getExternalEther(internalEther));
    }

    /// @dev the numerator (in ether) of the share rate for StETH conversion between shares and ether and vice versa.
    /// using the numerator and denominator different from totalShares and totalPooledEther allows to:
    /// - avoid double precision loss on additional division on external ether calculations
    /// - optimize gas cost of conversions between shares and ether
    function _getShareRateNumerator() internal view returns (uint256) {
        return _getInternalEther();
    }

    /// @dev the denominator (in shares) of the share rate for StETH conversion between shares and ether and vice versa.
    function _getShareRateDenominator() internal view returns (uint256) {
        (uint256 totalShares, uint256 externalShares) = _getTotalAndExternalShares();
        uint256 internalShares = totalShares - externalShares; // never 0 because of the stone in the elevator
        return internalShares;
    }

    /// @notice Calculate the maximum amount of external shares that can be additionally minted while maintaining
    ///         maximum allowed external ratio limits
    /// @return Maximum amount of external shares that can be additionally minted
    /// @dev This function enforces the ratio between external and total shares to stay below a limit.
    ///      The limit is defined by some maxRatioBP out of totalBP.
    ///
    ///      The calculation ensures: (externalShares + x) / (totalShares + x) <= maxRatioBP / totalBP
    ///      Which gives formula: x <= (totalShares * maxRatioBP - externalShares * totalBP) / (totalBP - maxRatioBP)
    ///
    ///      Special cases:
    ///      - Returns 0 if maxBP is 0 (external minting is disabled) or external shares already exceed the limit
    ///      - Returns 2^256-1 if maxBP is 100% (external minting is unlimited)
    function _getMaxMintableExternalShares() internal view returns (uint256) {
        uint256 maxRatioBP = _getMaxExternalRatioBP();
        if (maxRatioBP == 0) return 0;
        if (maxRatioBP == TOTAL_BASIS_POINTS) return uint256(-1);

        (uint256 totalShares, uint256 externalShares) = _getTotalAndExternalShares();

        if (totalShares * maxRatioBP <= externalShares * TOTAL_BASIS_POINTS) return 0;

        return (totalShares * maxRatioBP - externalShares * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - maxRatioBP);
    }

    function _pauseStaking() internal {
        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().setStakeLimitPauseState(true)
        );

        emit StakingPaused();
    }

    function _resumeStaking() internal {
        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().setStakeLimitPauseState(false)
        );

        emit StakingResumed();
    }

    function _getCurrentStakeLimit(StakeLimitState.Data memory _stakeLimitData) internal view returns (uint256) {
        if (_stakeLimitData.isStakingPaused()) {
            return 0;
        }
        if (!_stakeLimitData.isStakingLimitSet()) {
            return uint256(-1);
        }

        return _stakeLimitData.calculateCurrentStakeLimit();
    }

    /// @dev note that staking limit may be increased by burnExternalShares function
    function _decreaseStakingLimit(uint256 _amount) internal {
        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();
        // There is an invariant that protocol pause also implies staking pause.
        // Thus, no need to check protocol pause explicitly.
        require(!stakeLimitData.isStakingPaused(), "STAKING_PAUSED");

        if (stakeLimitData.isStakingLimitSet()) {
            uint256 currentStakeLimit = stakeLimitData.calculateCurrentStakeLimit();
            require(_amount <= currentStakeLimit, "STAKE_LIMIT");

            STAKING_STATE_POSITION.setStorageStakeLimitStruct(
                stakeLimitData.updatePrevStakeLimit(currentStakeLimit - _amount)
            );
        }
    }

    function _increaseStakingLimit(uint256 _amount) internal {
        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();
        /// NB: burning external shares must be allowed even when staking is paused to allow external ether withdrawals
        if (stakeLimitData.isStakingLimitSet() && !stakeLimitData.isStakingPaused()) {
            uint256 newStakeLimit = stakeLimitData.calculateCurrentStakeLimit() + _amount;

            STAKING_STATE_POSITION.setStorageStakeLimitStruct(stakeLimitData.updatePrevStakeLimit(newStakeLimit));
        }
    }

    /// @dev Bytecode size-efficient analog of the `auth(_role)` modifier
    /// @param _role Permission name
    function _auth(bytes32 _role) internal view {
        require(canPerform(msg.sender, _role, new uint256[](0)), "APP_AUTH_FAILED");
    }

    /// @dev simple address-based auth
    function _auth(address _address) internal view {
        require(msg.sender == _address, "APP_AUTH_FAILED");
    }

    function _stakingRouter() internal view returns (IStakingRouter) {
        return IStakingRouter(_getLidoLocator().stakingRouter());
    }

    function _withdrawalQueue(ILidoLocator _locator) internal view returns (IWithdrawalQueue) {
        return IWithdrawalQueue(_locator.withdrawalQueue());
    }

    function _withdrawalQueue() internal view returns (IWithdrawalQueue) {
        return _withdrawalQueue(_getLidoLocator());
    }

    function _vaultHub() internal view returns (address) {
        return _getLidoLocator().vaultHub();
    }

    function _burner(ILidoLocator _locator) internal view returns (address) {
        return _locator.burner();
    }

    function _burner() internal view returns (address) {
        return _getLidoLocator().burner();
    }

    function _accounting(ILidoLocator _locator) internal view returns (address) {
        return _locator.accounting();
    }

    function _accounting() internal view returns (address) {
        return _accounting(_getLidoLocator());
    }

    function _accountingOracle() internal view returns (IAccountingOracle) {
        return IAccountingOracle(_getLidoLocator().accountingOracle());
    }

    function _elRewardsVault(ILidoLocator _locator) internal view returns (ILidoExecutionLayerRewardsVault) {
        return ILidoExecutionLayerRewardsVault(_locator.elRewardsVault());
    }

    function _elRewardsVault() internal view returns (address) {
        return address(_elRewardsVault(_getLidoLocator()));
    }

    function _withdrawalVault(ILidoLocator _locator) internal view returns (IWithdrawalVault) {
        return IWithdrawalVault(_locator.withdrawalVault());
    }

    function _withdrawalVault() internal view returns (address) {
        return address(_withdrawalVault(_getLidoLocator()));
    }

    /// @notice Mints shares on behalf of 0xdead address,
    /// the shares amount is equal to the contract's balance.
    ///
    /// Allows to get rid of zero checks for `totalShares` and `totalPooledEther`
    /// and overcome corner cases.
    ///
    /// NB: reverts if the current contract's balance is zero.
    ///
    /// @dev must be invoked before using the token
    function _bootstrapInitialHolder() internal {
        uint256 balance = address(this).balance;
        assert(balance != 0);

        if (_getTotalShares() == 0) {
            // if protocol is empty, bootstrap it with the contract's balance
            // address(0xdead) is a holder for initial shares
            _setBufferedEther(balance);
            // emitting `Submitted` before Transfer events to preserve events order in tx
            emit Submitted(INITIAL_TOKEN_HOLDER, balance, 0);
            _mintInitialShares(balance);
        }
    }

    function _getExternalShares() internal view returns (uint256) {
        return TOTAL_AND_EXTERNAL_SHARES_POSITION.getHighUint128();
    }

    function _setExternalShares(uint256 _externalShares) internal {
        TOTAL_AND_EXTERNAL_SHARES_POSITION.setHighUint128(_externalShares);
    }

    function _getTotalAndExternalShares() internal view returns (uint256, uint256) {
        return TOTAL_AND_EXTERNAL_SHARES_POSITION.getLowAndHighUint128();
    }

    // helpers: buffered ether and deposited ether since last report

    function _getBufferedEther() internal view returns (uint256) {
        return BUFFERED_ETHER_AND_DEPOSITED_ETHER_POSITION.getLowUint128();
    }

    function _getDepositedEther() internal view returns (uint256) {
        return BUFFERED_ETHER_AND_DEPOSITED_ETHER_POSITION.getHighUint128();
    }

    function _getBufferedEtherAndDepositedEther() internal view returns (uint256, uint256) {
        return BUFFERED_ETHER_AND_DEPOSITED_ETHER_POSITION.getLowAndHighUint128();
    }

    function _setBufferedEther(uint256 _newBufferedEther) internal {
        BUFFERED_ETHER_AND_DEPOSITED_ETHER_POSITION.setLowUint128(_newBufferedEther);
    }

    function _setDepositedEther(uint256 _newDepositedEther) internal {
        BUFFERED_ETHER_AND_DEPOSITED_ETHER_POSITION.setHighUint128(_newDepositedEther);
    }

    function _setBufferedEtherAndDepositedEther(uint256 _newBufferedEther, uint256 _newDepositedEther) internal {
        BUFFERED_ETHER_AND_DEPOSITED_ETHER_POSITION.setLowAndHighUint128(_newBufferedEther, _newDepositedEther);
    }

    function _getDepositedEtherFromLastRefSlotAndLastRefSlot() internal view returns (uint256, uint256) {
        return DEPOSITED_ETHER_FROM_LAST_REFSLOT_AND_LAST_REFSLOT_POSITION.getLowAndHighUint128();
    }

    function _setDepositedEtherFromLastRefSlotAndLastRefSlot(
        uint256 _newDepositedEtherFromLastRefSlot,
        uint256 _lastRefSlot
    ) internal {
        DEPOSITED_ETHER_FROM_LAST_REFSLOT_AND_LAST_REFSLOT_POSITION.setLowAndHighUint128(
                _newDepositedEtherFromLastRefSlot, _lastRefSlot
            );
    }

    // helpers: [DEPRECATED] deposited validators count

    function _getSeedDepositsCount() internal view returns (uint256) {
        return SEED_DEPOSITS_COUNT_POSITION.getLowUint128();
    }

    function _setSeedDepositsCount(uint256 _newSeedDepositsCount) internal {
        SEED_DEPOSITS_COUNT_POSITION.setLowUint128(_newSeedDepositsCount);
    }

    // helpers: CL validators and pending balances

    function _getClValidatorsBalanceAndClPendingBalance() internal view returns (uint256, uint256) {
        return CL_VALIDATORS_BALANCE_AND_CL_PENDING_BALANCE_POSITION.getLowAndHighUint128();
    }

    function _setClValidatorsBalanceAndClPendingBalance(uint256 _newClValidatorsBalance, uint256 _newClPendingBalance)
        internal
    {
        CL_VALIDATORS_BALANCE_AND_CL_PENDING_BALANCE_POSITION.setLowAndHighUint128(
            _newClValidatorsBalance, _newClPendingBalance
        );
    }

    // ---

    function _setLidoLocator(address _newLidoLocator) internal {
        LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION.setLowUint160(uint160(_newLidoLocator));
    }

    function _getLidoLocator() internal view returns (ILidoLocator) {
        return ILidoLocator(LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION.getLowUint160());
    }

    function _setMaxExternalRatioBP(uint256 _newMaxExternalRatioBP) internal {
        require(_newMaxExternalRatioBP <= TOTAL_BASIS_POINTS, "INVALID_MAX_EXTERNAL_RATIO");

        LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION.setHighUint96(_newMaxExternalRatioBP);

        emit MaxExternalRatioBPSet(_newMaxExternalRatioBP);
    }

    function _getMaxExternalRatioBP() internal view returns (uint256) {
        return LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION.getHighUint96();
    }
}
