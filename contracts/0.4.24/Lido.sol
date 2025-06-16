// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.4.24;

import {AragonApp, UnstructuredStorage} from "@aragon/os/contracts/apps/AragonApp.sol";
import {SafeMath} from "@aragon/os/contracts/lib/math/SafeMath.sol";

import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";

import {StETHPermit} from "./StETHPermit.sol";
import {Versioned} from "./utils/Versioned.sol";

import {Math256} from "../common/lib/Math256.sol";
import {StakeLimitUtils, StakeLimitUnstructuredStorage, StakeLimitState} from "./lib/StakeLimitUtils.sol";
import {UnstructuredStorageUint128} from "./utils/UnstructuredStorageUint128.sol";

interface IBurnerMigration {
    function migrate(address _oldBurner) external;
}

interface IStakingRouter {
    function deposit(uint256 _depositsCount, uint256 _stakingModuleId, bytes _depositCalldata) external payable;

    function getStakingModuleMaxDepositsCount(
        uint256 _stakingModuleId,
        uint256 _maxDepositsValue
    ) external view returns (uint256);

    function getTotalFeeE4Precision() external view returns (uint16 totalFee);

    function TOTAL_BASIS_POINTS() external view returns (uint256);

    function getWithdrawalCredentials() external view returns (bytes32);

    function getStakingFeeAggregateDistributionE4Precision() external view returns (uint16 modulesFee, uint16 treasuryFee);
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
 * SLOT 2: mapping(address => uint256) internal noncesByAddress (`StETHPermit`)
 *
 * `Versioned` and `AragonApp` both don't have the pre-allocated structured storage.
 */
contract Lido is Versioned, StETHPermit, AragonApp {
    using SafeMath for uint256;
    using UnstructuredStorage for bytes32;
    using UnstructuredStorageUint128 for bytes32;
    using StakeLimitUnstructuredStorage for bytes32;
    using StakeLimitUtils for StakeLimitState.Data;

    /// ACL
    bytes32 public constant PAUSE_ROLE = 0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d; // keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = 0x2fc10cc8ae19568712f7a176fb4978616a610650813c9d05326c34abb62749c7; // keccak256("RESUME_ROLE");
    bytes32 public constant STAKING_PAUSE_ROLE = 0x84ea57490227bc2be925c684e2a367071d69890b629590198f4125a018eb1de8; // keccak256("STAKING_PAUSE_ROLE")
    bytes32 public constant STAKING_CONTROL_ROLE = 0xa42eee1333c0758ba72be38e728b6dadb32ea767de5b4ddbaea1dae85b1b051f; // keccak256("STAKING_CONTROL_ROLE")
    bytes32 public constant UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE =
        0xe6dc5d79630c61871e99d341ad72c5a052bed2fc8c79e5a4480a7cd31117576c; // keccak256("UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE")

    uint256 private constant DEPOSIT_SIZE = 32 ether;

    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    /// @dev storage slot position for the total and external shares (from StETH contract)
    /// Since version 3, high 128 bits are used for the external shares
    /// |----- 128 bit -----|------ 128 bit -------|
    /// |   external shares |     total shares     |
    bytes32 internal constant TOTAL_AND_EXTERNAL_SHARES_POSITION =
        TOTAL_SHARES_POSITION; // this is a slot from StETH contract

    /// @dev storage slot position for the Lido protocol contracts locator
    /// Since version 3, high 96 bits are used for the max external ratio BP
    /// |----- 96 bit -----|------ 160 bit -------|
    /// |max external ratio| lido locator address |
    bytes32 internal constant LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION =
        0x9ef78dff90f100ea94042bd00ccb978430524befc391d3e510b5f55ff3166df7; // keccak256("lido.Lido.lidoLocator")
    /// @dev amount of ether (on the current Ethereum side) buffered on this smart contract balance
    /// Since version 3, high 128 bits are used for the deposited validators count
    /// |----- 128 bit -----|------ 128 bit -------|
    /// |   buffered ether  | deposited validators |
    bytes32 internal constant BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION =
        0xed310af23f61f96daefbcd140b306c0bdbf8c178398299741687b90e794772b0; // keccak256("lido.Lido.bufferedEther");
    /// @dev total amount of ether on Consensus Layer (sum of all the balances of Lido validators)
    // "beacon" in the `keccak256()` parameter is staying here for compatibility reason
    /// Since version 3, high 128 bits are used for the CL validators count
    /// |----- 128 bit -----|------ 128 bit -------|
    /// |   CL balance      |   CL validators      |
    bytes32 internal constant CL_BALANCE_AND_CL_VALIDATORS_POSITION =
        0xa66d35f054e68143c18f32c990ed5cb972bb68a68f500cd2dd3a16bbf3686483; // keccak256("lido.Lido.beaconBalance");
    /// @dev storage slot position of the staking rate limit structure
    bytes32 internal constant STAKING_STATE_POSITION =
        0xa3678de4a579be090bed1177e0a24f77cc29d181ac22fd7688aca344d8938015; // keccak256("lido.Lido.stakeLimit");
    /// @dev Just a counter of total amount of execution layer rewards received by Lido contract. Not used in the logic.
    bytes32 internal constant TOTAL_EL_REWARDS_COLLECTED_POSITION =
        0xafe016039542d12eec0183bb0b1ffc2ca45b027126a494672fba4154ee77facb; // keccak256("lido.Lido.totalELRewardsCollected");

    // Staking was paused (don't accept user's ether submits)
    event StakingPaused();
    // Staking was resumed (accept user's ether submits)
    event StakingResumed();
    // Staking limit was set (rate limits user's submits)
    event StakingLimitSet(uint256 maxStakeLimit, uint256 stakeLimitIncreasePerBlock);
    // Staking limit was removed
    event StakingLimitRemoved();

    // Emitted when validators number delivered by the oracle
    event CLValidatorsUpdated(uint256 indexed reportTimestamp, uint256 preCLValidators, uint256 postCLValidators);

    // Emitted when var at `DEPOSITED_VALIDATORS_POSITION` changed
    event DepositedValidatorsChanged(uint256 depositedValidators);

    // Emitted when oracle accounting report processed
    // @dev `preCLBalance` is the balance of the validators on previous report
    // plus the amount of ether that was deposited to the deposit contract since then
    event ETHDistributed(
        uint256 indexed reportTimestamp,
        uint256 preCLBalance, // actually its preCLBalance + deposits due to compatibility reasons
        uint256 postCLBalance,
        uint256 withdrawalsWithdrawn,
        uint256 executionLayerRewardsWithdrawn,
        uint256 postBufferedEther
    );

    // Emitted when token is rebased (total supply and/or total shares were changed)
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
    event ExternalSharesMinted(address indexed receiver, uint256 amountOfShares, uint256 amountOfStETH);

    // External shares burned for account
    event ExternalSharesBurned(address indexed account, uint256 amountOfShares, uint256 stethAmount);

    // Maximum ratio of external shares to total shares in basis points set
    event MaxExternalRatioBPSet(uint256 maxExternalRatioBP);

    // External ether transferred to buffer
    event ExternalEtherTransferredToBuffer(uint256 amount);

    // Bad debt internalized
    event ExternalBadDebtInternalized(uint256 amountOfShares);

    /**
     * @dev As AragonApp, Lido contract must be initialized with following variables:
     *      NB: by default, staking and the whole Lido pool are in paused state
     *
     * The contract's balance must be non-zero to allow initial holder bootstrap.
     *
     * @param _lidoLocator lido locator contract
     * @param _eip712StETH eip712 helper contract for StETH
     */
    function initialize(address _lidoLocator, address _eip712StETH) public payable onlyInit {
        _bootstrapInitialHolder(); // stone in the elevator

        _setLidoLocator(_lidoLocator);
        emit LidoLocatorSet(_lidoLocator);
        _initializeEIP712StETH(_eip712StETH);

        _setContractVersion(3);

        _approve(_getLidoLocator().withdrawalQueue(), _getLidoLocator().burner(), INFINITE_ALLOWANCE);
        initialized();
    }

    /**
     * @notice A function to finalize upgrade to v3 (from v2). Can be called only once
     *
     * For more details see https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-10.md
     * @param _oldBurner The address of the old Burner contract to migrate from
     * @param _contractsWithBurnerAllowances Contracts that have allowances for the old burner to be migrated
     */
    function finalizeUpgrade_v3(address _oldBurner, address[] _contractsWithBurnerAllowances) external {
        require(hasInitialized(), "NOT_INITIALIZED");
        _checkContractVersion(2);
        require(_oldBurner != address(0), "OLD_BURNER_ADDRESS_ZERO");
        address burner = _getLidoLocator().burner();
        require(_oldBurner != burner, "OLD_BURNER_SAME_AS_NEW");

        _setContractVersion(3);

        // migrate burner stETH balance
        uint256 oldBurnerShares = _sharesOf(_oldBurner);
        if (oldBurnerShares > 0) {
            uint256 oldBurnerBalance = getPooledEthByShares(oldBurnerShares);
            _transferShares(_oldBurner, burner, oldBurnerShares);
            _emitTransferEvents(_oldBurner, burner, oldBurnerBalance, oldBurnerShares);
        }

        // initialize new burner with state from the old burner
        IBurnerMigration(burner).migrate(_oldBurner);

        // migrating allowances
        for (uint256 i = 0; i < _contractsWithBurnerAllowances.length; i++) {
            uint256 oldAllowance = allowance(_contractsWithBurnerAllowances[i], _oldBurner);
            _approve(_contractsWithBurnerAllowances[i], _oldBurner, 0);
            _approve(_contractsWithBurnerAllowances[i], burner, oldAllowance);
        }

        // migrate storage to packed representation

        bytes32 DEPOSITED_VALIDATORS_POSITION =
            0xe6e35175eb53fc006520a2a9c3e9711a7c00de6ff2c32dd31df8c5a24cac1b5c; // keccak256("lido.Lido.depositedValidators");

        _setDepositedValidators(DEPOSITED_VALIDATORS_POSITION.getStorageUint256());
        DEPOSITED_VALIDATORS_POSITION.setStorageUint256(0);

        // number of Lido's validators available in the Consensus Layer state
        // "beacon" in the `keccak256()` parameter is staying here for compatibility reason
        bytes32 CL_VALIDATORS_POSITION =
            0x9f70001d82b6ef54e9d3725b46581c3eb9ee3aa02b941b6aa54d678a9ca35b10; // keccak256("lido.Lido.beaconValidators");

        _setClValidators(CL_VALIDATORS_POSITION.getStorageUint256());
        CL_VALIDATORS_POSITION.setStorageUint256(0);

        // nullify new values to be safe
        _setMaxExternalRatioBP(0);
        _setExternalShares(0);
    }

    /**
     * @notice Stop accepting new ether to the protocol
     *
     * @dev While accepting new ether is stopped, calls to the `submit` function,
     * as well as to the default payable function, will revert.
     */
    function pauseStaking() external {
        _auth(STAKING_PAUSE_ROLE);

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
     * - `_maxStakeLimit` >= 2^96
     * - `_maxStakeLimit` < `_stakeLimitIncreasePerBlock`
     * - `_maxStakeLimit` / `_stakeLimitIncreasePerBlock` >= 2^32 (only if `_stakeLimitIncreasePerBlock` != 0)
     *
     * @param _maxStakeLimit max stake limit value
     * @param _stakeLimitIncreasePerBlock stake limit increase per single block
     */
    function setStakingLimit(uint256 _maxStakeLimit, uint256 _stakeLimitIncreasePerBlock) external {
        _auth(STAKING_CONTROL_ROLE);

        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().setStakingLimit(
                _maxStakeLimit,
                _stakeLimitIncreasePerBlock
            )
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
    function isStakingPaused() external view returns (bool) {
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
        require(_maxExternalRatioBP <= TOTAL_BASIS_POINTS, "INVALID_MAX_EXTERNAL_RATIO");

        _setMaxExternalRatioBP(_maxExternalRatioBP);

        emit MaxExternalRatioBPSet(_maxExternalRatioBP);
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
        require(msg.sender == _getLidoLocator().elRewardsVault());

        TOTAL_EL_REWARDS_COLLECTED_POSITION.setStorageUint256(getTotalELRewardsCollected().add(msg.value));

        emit ELRewardsReceived(msg.value);
    }

    /**
     * @notice A payable function for withdrawals acquisition. Can be called only by `WithdrawalVault`
     * @dev We need a dedicated function because funds received by the default payable function
     * are treated as a user deposit
     */
    function receiveWithdrawals() external payable {
        require(msg.sender == _getLidoLocator().withdrawalVault());

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
     * @notice Unsafely change the deposited validators counter
     *
     * The method unsafely changes deposited validator counter.
     * Can be required when onboarding external validators to Lido
     * (i.e., had deposited before and rotated their type-0x00 withdrawal credentials to Lido)
     *
     * @param _newDepositedValidators new value
     *
     * TODO: remove this with maxEB-friendly accounting
     */
    function unsafeChangeDepositedValidators(uint256 _newDepositedValidators) external {
        _auth(UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE);

        _setDepositedValidators(_newDepositedValidators);

        emit DepositedValidatorsChanged(_newDepositedValidators);
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
     * as other buffered ether is kept (until it gets deposited or withdrawn)
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
     * @notice Get the key values related to the Consensus Layer side of the contract.
     * @return depositedValidators - number of deposited validators from Lido contract side
     * @return beaconValidators - number of Lido validators visible on Consensus Layer, reported by oracle
     * @return beaconBalance - total amount of ether on the Consensus Layer side (sum of all the balances of Lido validators)
     */
    function getBeaconStat()
        external
        view
        returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance)
    {
        depositedValidators = _getDepositedValidators();
        (beaconBalance, beaconValidators) = _getClBalanceAndClValidators();
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
     * @dev Takes into account unfinalized stETH required by WithdrawalQueue
     */
    function getDepositableEther() public view returns (uint256) {
        uint256 bufferedEther = _getBufferedEther();
        uint256 withdrawalReserve = _withdrawalQueue().unfinalizedStETH();
        return bufferedEther > withdrawalReserve ? bufferedEther - withdrawalReserve : 0;
    }

    /**
     * @notice Invoke a deposit call to the Staking Router contract and update buffered counters
     * @param _maxDepositsCount max deposits count
     * @param _stakingModuleId id of the staking module to be deposited
     * @param _depositCalldata module calldata
     */
    function deposit(uint256 _maxDepositsCount, uint256 _stakingModuleId, bytes _depositCalldata) external {
        ILidoLocator locator = _getLidoLocator();

        require(msg.sender == locator.depositSecurityModule(), "APP_AUTH_DSM_FAILED");
        require(canDeposit(), "CAN_NOT_DEPOSIT");

        IStakingRouter stakingRouter = IStakingRouter(locator.stakingRouter());
        uint256 depositsCount = Math256.min(
            _maxDepositsCount,
            stakingRouter.getStakingModuleMaxDepositsCount(_stakingModuleId, getDepositableEther())
        );

        uint256 depositsValue;
        if (depositsCount > 0) {
            depositsValue = depositsCount.mul(DEPOSIT_SIZE);
            /// @dev firstly update the local state of the contract to prevent a reentrancy attack,
            ///     even if the StakingRouter is a trusted contract.

            (uint256 bufferedEther, uint256 depositedValidators) = _getBufferedEtherAndDepositedValidators();
            depositedValidators = depositedValidators.add(depositsCount);

            _setBufferedEtherAndDepositedValidators(bufferedEther.sub(depositsValue), depositedValidators);
            emit Unbuffered(depositsValue);
            emit DepositedValidatorsChanged(depositedValidators);
        }

        /// @dev transfer ether to StakingRouter and make a deposit at the same time. All the ether
        ///     sent to StakingRouter is counted as deposited. If StakingRouter can't deposit all
        ///     passed ether it MUST revert the whole transaction (never happens in normal circumstances)
        stakingRouter.deposit.value(depositsValue)(depositsCount, _stakingModuleId, _depositCalldata);
    }

    /**
     * @notice Mint stETH shares
     * @param _recipient recipient of the shares
     * @param _amountOfShares amount of shares to mint
     * @dev can be called only by accounting
     */
    function mintShares(address _recipient, uint256 _amountOfShares) public {
        _auth(_getLidoLocator().accounting());
        _whenNotStopped();

        _mintShares(_recipient, _amountOfShares);
        // emit event after minting shares because we are always having the net new ether under the hood
        // for vaults we have new locked ether and for fees we have a part of rewards
        _emitTransferAfterMintingShares(_recipient, _amountOfShares);
    }

    /**
     * @notice Burn stETH shares from the `msg.sender` address
     * @param _amountOfShares amount of shares to burn
     * @dev can be called only by burner
     */
    function burnShares(uint256 _amountOfShares) public {
        _auth(_getLidoLocator().burner());
        _whenNotStopped();
        _burnShares(msg.sender, _amountOfShares);

        // historically there is no events for this kind of burning
        // TODO: should burn events be emitted here?
        // maybe TransferShare for cover burn and all events for withdrawal burn
    }

    /**
     * @notice Mint shares backed by external ether sources
     * @param _recipient Address to receive the minted shares
     * @param _amountOfShares Amount of shares to mint
     * @dev Can be called only by VaultHub
     *      NB: Reverts if the the external balance limit is exceeded.
     */
    function mintExternalShares(address _recipient, uint256 _amountOfShares) external {
        require(_recipient != address(0), "MINT_RECEIVER_ZERO_ADDRESS");
        require(_amountOfShares != 0, "MINT_ZERO_AMOUNT_OF_SHARES");
        _auth(_getLidoLocator().vaultHub());
        _whenNotStopped();

        require(_amountOfShares <= _getMaxMintableExternalShares(), "EXTERNAL_BALANCE_LIMIT_EXCEEDED");

        _setExternalShares(_getExternalShares() + _amountOfShares);

        _mintShares(_recipient, _amountOfShares);
        // emit event after minting shares because we are always having the net new ether under the hood
        // for vaults we have new locked ether and for fees we have a part of rewards
        _emitTransferAfterMintingShares(_recipient, _amountOfShares);

        emit ExternalSharesMinted(_recipient, _amountOfShares, getPooledEthByShares(_amountOfShares));
    }

    /**
     * @notice Burn external shares from the `msg.sender` address
     * @param _amountOfShares Amount of shares to burn
     */
    function burnExternalShares(uint256 _amountOfShares) external {
        require(_amountOfShares != 0, "BURN_ZERO_AMOUNT_OF_SHARES");
        _auth(_getLidoLocator().vaultHub());
        _whenNotStopped();

        uint256 externalShares = _getExternalShares();

        if (externalShares < _amountOfShares) revert("EXT_SHARES_TOO_SMALL");
        _setExternalShares(externalShares - _amountOfShares);

        _burnShares(msg.sender, _amountOfShares);

        uint256 stethAmount = getPooledEthByShares(_amountOfShares);
        _emitTransferEvents(msg.sender, address(0), stethAmount, _amountOfShares);
        emit ExternalSharesBurned(msg.sender, _amountOfShares, stethAmount);
    }

    /**
     * @notice Transfer ether to the buffer decreasing the number of external shares in the same time
     * @dev it's an equivalent of using `submit` and then `burnExternalShares`
     * but without any limits or pauses
     *
     * - msg.value is transferred to the buffer
     */
    function rebalanceExternalEtherToInternal() external payable {
        require(msg.value != 0, "ZERO_VALUE");
        _auth(_getLidoLocator().vaultHub());
        _whenNotStopped();

        uint256 amountOfShares = getSharesByPooledEth(msg.value);
        uint256 externalShares = _getExternalShares();

        if (externalShares < amountOfShares) revert("EXT_SHARES_TOO_SMALL");

        // here the external balance is decreased (totalShares remains the same)
        _setExternalShares(externalShares - amountOfShares);

        // here the buffer is increased
        _setBufferedEther(_getBufferedEther() + msg.value);

        // the result can be a smallish rebase like 1-2 wei per tx
        // but it's not worth then using submit for it,
        // so invariants are the same
        emit ExternalEtherTransferredToBuffer(msg.value);
    }

    /**
     * @notice Process CL related state changes as a part of the report processing
     * @dev All data validation was done by Accounting and OracleReportSanityChecker
     * @param _reportTimestamp timestamp of the report
     * @param _preClValidators number of validators in the previous CL state (for event compatibility)
     * @param _reportClValidators number of validators in the current CL state
     * @param _reportClBalance total balance of the current CL state
     */
    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _preClValidators,
        uint256 _reportClValidators,
        uint256 _reportClBalance
    ) external {
        _whenNotStopped();
        _auth(_getLidoLocator().accounting());

        // Save the current CL balance and validators to
        // calculate rewards on the next rebase
        _setClBalanceAndClValidators(_reportClBalance, _reportClValidators);

        emit CLValidatorsUpdated(_reportTimestamp, _preClValidators, _reportClValidators);
        // cl balance change are logged in ETHDistributed event later
    }

    /**
     * @notice Internalize external bad debt
     * @param _amountOfShares amount of shares to internalize
     */
    function internalizeExternalBadDebt(uint256 _amountOfShares) external {
        require(_amountOfShares != 0, "BAD_DEBT_ZERO_SHARES");
        _whenNotStopped();
        _auth(_getLidoLocator().accounting());

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
        _auth(locator.accounting());

        // withdraw execution layer rewards and put them to the buffer
        if (_elRewardsToWithdraw > 0) {
            ILidoExecutionLayerRewardsVault(locator.elRewardsVault()).withdrawRewards(_elRewardsToWithdraw);
        }

        // withdraw withdrawals and put them to the buffer
        if (_withdrawalsToWithdraw > 0) {
            IWithdrawalVault(locator.withdrawalVault()).withdrawWithdrawals(_withdrawalsToWithdraw);
        }

        // finalize withdrawals (send ether, assign shares for burning)
        if (_etherToLockOnWithdrawalQueue > 0) {
            IWithdrawalQueue(locator.withdrawalQueue()).finalize.value(_etherToLockOnWithdrawalQueue)(
                _lastWithdrawalRequestToFinalize,
                _withdrawalsShareRate
            );
        }

        uint256 postBufferedEther = _getBufferedEther()
            .add(_elRewardsToWithdraw) // Collected from ELVault
            .add(_withdrawalsToWithdraw) // Collected from WithdrawalVault
            .sub(_etherToLockOnWithdrawalQueue); // Sent to WithdrawalQueue

        _setBufferedEther(postBufferedEther);

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
     * @notice Emit the `TokenRebase` event
     * @dev It's here for back compatibility reasons
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
        _auth(_getLidoLocator().accounting());

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

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////// DEPRECATED PUBLIC METHODS ///////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    /**
     * @notice DEPRECATED: Returns current withdrawal credentials of deposited validators
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
        (uint256 treasuryFeeBasisPointsAbs, uint256 operatorsFeeBasisPointsAbs) = stakingRouter
            .getStakingFeeAggregateDistributionE4Precision();

        insuranceFeeBasisPoints = 0; // explicitly set to zero
        treasuryFeeBasisPoints = uint16((treasuryFeeBasisPointsAbs * totalBasisPoints) / totalFee);
        operatorsFeeBasisPoints = uint16((operatorsFeeBasisPointsAbs * totalBasisPoints) / totalFee);
    }

    /**
     * @notice Overrides default AragonApp behavior to disallow recovery.
     */
    function transferToVault(address /* _token */) external {
        revert("NOT_SUPPORTED");
    }

    /// @dev Process user deposit, mint liquid tokens and increase the pool buffer
    /// @param _referral address of referral.
    /// @return amount of StETH shares minted
    function _submit(address _referral) internal returns (uint256) {
        require(msg.value != 0, "ZERO_DEPOSIT");

        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();
        // There is an invariant that protocol pause also implies staking pause.
        // Thus, no need to check protocol pause explicitly.
        require(!stakeLimitData.isStakingPaused(), "STAKING_PAUSED");

        if (stakeLimitData.isStakingLimitSet()) {
            uint256 currentStakeLimit = stakeLimitData.calculateCurrentStakeLimit();

            require(msg.value <= currentStakeLimit, "STAKE_LIMIT");

            STAKING_STATE_POSITION.setStorageStakeLimitStruct(
                stakeLimitData.updatePrevStakeLimit(currentStakeLimit - msg.value)
            );
        }

        uint256 sharesAmount = getSharesByPooledEth(msg.value);

        _mintShares(msg.sender, sharesAmount);

        _setBufferedEther(_getBufferedEther().add(msg.value));
        emit Submitted(msg.sender, msg.value, _referral);

        _emitTransferAfterMintingShares(msg.sender, sharesAmount);
        return sharesAmount;
    }

    /// @dev Get the total amount of ether controlled by the protocol internally
    /// (buffered + CL balance of StakingRouter controlled validators + transient)
    function _getInternalEther() internal view returns (uint256) {
        (uint256 bufferedEther, uint256 depositedValidators) = _getBufferedEtherAndDepositedValidators();
        (uint256 clBalance, uint256 clValidators) = _getClBalanceAndClValidators();

        // clValidators can never be less than deposited ones.
        assert(depositedValidators >= clValidators);
        // the total base balance (multiple of 32) of validators in transient state,
        // i.e. submitted to the official Deposit contract but not yet visible in the CL state.
        uint256 transientEther = (depositedValidators - clValidators) * DEPOSIT_SIZE;

        return bufferedEther
            .add(clBalance)
            .add(transientEther);
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

        return
            (totalShares * maxRatioBP - externalShares * TOTAL_BASIS_POINTS) /
            (TOTAL_BASIS_POINTS - maxRatioBP);
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

    function _withdrawalQueue() internal view returns (IWithdrawalQueue) {
        return IWithdrawalQueue(_getLidoLocator().withdrawalQueue());
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

    function _getBufferedEther() internal view returns (uint256) {
        return BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.getLowUint128();
    }

    function _setBufferedEther(uint256 _newBufferedEther) internal {
        BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.setLowUint128(_newBufferedEther);
    }

    function _getDepositedValidators() internal view returns (uint256) {
        return BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.getHighUint128();
    }

    function _setDepositedValidators(uint256 _newDepositedValidators) internal {
        BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.setHighUint128(_newDepositedValidators);
    }

    function _getBufferedEtherAndDepositedValidators() internal view returns (uint256, uint256) {
        return BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.getLowAndHighUint128();
    }

    function _setBufferedEtherAndDepositedValidators(
        uint256 _newBufferedEther,
        uint256 _newDepositedValidators
    ) internal {
        BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.setLowAndHighUint128(
            _newBufferedEther,
            _newDepositedValidators
        );
    }

    function _getClBalanceAndClValidators() internal view returns (uint256, uint256) {
        return CL_BALANCE_AND_CL_VALIDATORS_POSITION.getLowAndHighUint128();
    }

    function _setClBalanceAndClValidators(uint256 _newClBalance, uint256 _newClValidators) internal {
        CL_BALANCE_AND_CL_VALIDATORS_POSITION.setLowAndHighUint128(_newClBalance, _newClValidators);
    }

    function _setClValidators(uint256 _newClValidators) internal {
        CL_BALANCE_AND_CL_VALIDATORS_POSITION.setHighUint128(_newClValidators);
    }

    function _setLidoLocator(address _newLidoLocator) internal {
        LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION.setLowUint160(uint160(_newLidoLocator));
    }

    function _getLidoLocator() internal view returns (ILidoLocator) {
        return ILidoLocator(LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION.getStorageAddress());
    }

    function _setMaxExternalRatioBP(uint256 _newMaxExternalRatioBP) internal {
        LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION.setHighUint96(_newMaxExternalRatioBP);
    }

    function _getMaxExternalRatioBP() internal view returns (uint256) {
        return LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION.getHighUint96();
    }
}
