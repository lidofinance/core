// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.4.24;

import {AragonApp, UnstructuredStorage} from "@aragon/os/contracts/apps/AragonApp.sol";
import {SafeMath} from "@aragon/os/contracts/lib/math/SafeMath.sol";

import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {StakeLimitUtils, StakeLimitUnstructuredStorage, StakeLimitState} from "./lib/StakeLimitUtils.sol";
import {Math256} from "../common/lib/Math256.sol";

import {StETHPermit} from "./StETHPermit.sol";

import {Versioned} from "./utils/Versioned.sol";

interface IStakingRouter {
    function deposit(
        uint256 _depositsCount,
        uint256 _stakingModuleId,
        bytes _depositCalldata
    ) external payable;

    function getStakingModuleMaxDepositsCount(
        uint256 _stakingModuleId,
        uint256 _maxDepositsValue
    ) external view returns (uint256);

    function getTotalFeeE4Precision() external view returns (uint16 totalFee);

    function TOTAL_BASIS_POINTS() external view returns (uint256);

    function getWithdrawalCredentials() external view returns (bytes32);

    function getStakingFeeAggregateDistributionE4Precision() external view returns (
        uint16 modulesFee, uint16 treasuryFee
    );
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
* Lido is an Ethereum liquid staking protocol solving the problem of frozen staked ether on Consensus Layer
* being unavailable for transfers and DeFi on Execution Layer.
*
* Since balances of all token holders change when the amount of total pooled Ether
* changes, this token cannot fully implement ERC20 standard: it only emits `Transfer`
* events upon explicit transfer between holders. In contrast, when Lido oracle reports
* rewards, no Transfer events are generated: doing so would require emitting an event
* for each token holder and thus running an unbounded loop.
*
* ---
* NB: Order of inheritance must preserve the structured storage layout of the previous versions.
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
    using StakeLimitUnstructuredStorage for bytes32;
    using StakeLimitUtils for StakeLimitState.Data;

    /// ACL
    bytes32 public constant PAUSE_ROLE =
        0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d; // keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE =
        0x2fc10cc8ae19568712f7a176fb4978616a610650813c9d05326c34abb62749c7; // keccak256("RESUME_ROLE");
    bytes32 public constant STAKING_PAUSE_ROLE =
        0x84ea57490227bc2be925c684e2a367071d69890b629590198f4125a018eb1de8; // keccak256("STAKING_PAUSE_ROLE")
    bytes32 public constant STAKING_CONTROL_ROLE =
        0xa42eee1333c0758ba72be38e728b6dadb32ea767de5b4ddbaea1dae85b1b051f; // keccak256("STAKING_CONTROL_ROLE")
    bytes32 public constant UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE =
        0xe6dc5d79630c61871e99d341ad72c5a052bed2fc8c79e5a4480a7cd31117576c; // keccak256("UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE")

    uint256 private constant DEPOSIT_SIZE = 32 ether;

    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    /// @dev storage slot position for the Lido protocol contracts locator
    bytes32 internal constant LIDO_LOCATOR_POSITION =
        0x9ef78dff90f100ea94042bd00ccb978430524befc391d3e510b5f55ff3166df7; // keccak256("lido.Lido.lidoLocator")
    /// @dev storage slot position of the staking rate limit structure
    bytes32 internal constant STAKING_STATE_POSITION =
        0xa3678de4a579be090bed1177e0a24f77cc29d181ac22fd7688aca344d8938015; // keccak256("lido.Lido.stakeLimit");
    /// @dev amount of Ether (on the current Ethereum side) buffered on this smart contract balance
    bytes32 internal constant BUFFERED_ETHER_POSITION =
        0xed310af23f61f96daefbcd140b306c0bdbf8c178398299741687b90e794772b0; // keccak256("lido.Lido.bufferedEther");
    /// @dev number of deposited validators (incrementing counter of deposit operations).
    bytes32 internal constant DEPOSITED_VALIDATORS_POSITION =
        0xe6e35175eb53fc006520a2a9c3e9711a7c00de6ff2c32dd31df8c5a24cac1b5c; // keccak256("lido.Lido.depositedValidators");
    /// @dev total amount of ether on Consensus Layer (sum of all the balances of Lido validators)
    // "beacon" in the `keccak256()` parameter is staying here for compatibility reason
    bytes32 internal constant CL_BALANCE_POSITION =
        0xa66d35f054e68143c18f32c990ed5cb972bb68a68f500cd2dd3a16bbf3686483; // keccak256("lido.Lido.beaconBalance");
    /// @dev number of Lido's validators available in the Consensus Layer state
    // "beacon" in the `keccak256()` parameter is staying here for compatibility reason
    bytes32 internal constant CL_VALIDATORS_POSITION =
        0x9f70001d82b6ef54e9d3725b46581c3eb9ee3aa02b941b6aa54d678a9ca35b10; // keccak256("lido.Lido.beaconValidators");
    /// @dev Just a counter of total amount of execution layer rewards received by Lido contract. Not used in the logic.
    bytes32 internal constant TOTAL_EL_REWARDS_COLLECTED_POSITION =
        0xafe016039542d12eec0183bb0b1ffc2ca45b027126a494672fba4154ee77facb; // keccak256("lido.Lido.totalELRewardsCollected");
    /// @dev amount of token shares minted that is backed by external sources
    bytes32 internal constant EXTERNAL_SHARES_POSITION =
        0x2ab18be87d6c30f8dc2a29c9950ab4796c891232dbcc6a95a6b44b9f8aad9352; // keccak256("lido.Lido.externalShares");
    /// @dev maximum allowed ratio of external shares to total shares in basis points
    bytes32 internal constant MAX_EXTERNAL_RATIO_POSITION =
        0x5248bc99214b4b9bfb04eed7603bdab7b47ab5b436236fcbf7bda3acc9aea148; // keccak256("lido.Lido.maxExternalRatioBP")
    bytes32 internal constant MAX_EXTERNAL_BALANCE_POSITION =
        0x5d9acd3b741c556363e77af693c2f6219b9bf4d826159e864c4e3c3f08e6d97a; // keccak256("lido.Lido.maxExternalBalance")
    bytes32 internal constant EXTERNAL_BALANCE_POSITION =
        0x2a094e9f51934d7c659e7b6195b27a4a50d3f8a3c5e2d91b2f6c2e68c16c485b; // keccak256("lido.Lido.externalBalance")

    // Staking was paused (don't accept user's ether submits)
    event StakingPaused();
    // Staking was resumed (accept user's ether submits)
    event StakingResumed();
    // Staking limit was set (rate limits user's submits)
    event StakingLimitSet(uint256 maxStakeLimit, uint256 stakeLimitIncreasePerBlock);
    // Staking limit was removed
    event StakingLimitRemoved();

    // Emits when validators number delivered by the oracle
    event CLValidatorsUpdated(
        uint256 indexed reportTimestamp,
        uint256 preCLValidators,
        uint256 postCLValidators
    );

    // Emits when var at `DEPOSITED_VALIDATORS_POSITION` changed
    event DepositedValidatorsChanged(
        uint256 depositedValidators
    );

    // Emits when oracle accounting report processed
    event ETHDistributed(
        uint256 indexed reportTimestamp,
        uint256 preCLBalance,
        uint256 postCLBalance,
        uint256 withdrawalsWithdrawn,
        uint256 executionLayerRewardsWithdrawn,
        uint256 postBufferedEther
    );

    // Emits when token rebased (total supply and/or total shares were changed)
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

    // External shares minted for receiver
    event ExternalSharesMinted(address indexed receiver, uint256 amountOfShares, uint256 stethAmount);

    // External shares burned for account
    event ExternalSharesBurned(address indexed account, uint256 amountOfShares, uint256 stethAmount);

    // Maximum ratio of external shares to total shares in basis points set
    event MaxExternalRatioBPSet(uint256 maxExternalRatioBP);

    /**
    * @dev As AragonApp, Lido contract must be initialized with following variables:
    *      NB: by default, staking and the whole Lido pool are in paused state
    *
    * The contract's balance must be non-zero to allow initial holder bootstrap.
    *
    * @param _lidoLocator lido locator contract
    * @param _eip712StETH eip712 helper contract for StETH
    */
    function initialize(address _lidoLocator, address _eip712StETH)
        public
        payable
        onlyInit
    {
        _bootstrapInitialHolder();

        LIDO_LOCATOR_POSITION.setStorageAddress(_lidoLocator);
        emit LidoLocatorSet(_lidoLocator);
        _initializeEIP712StETH(_eip712StETH);

        // set infinite allowance for burner from withdrawal queue
        // to burn finalized requests' shares
        _approve(
            ILidoLocator(_lidoLocator).withdrawalQueue(),
            ILidoLocator(_lidoLocator).burner(),
            INFINITE_ALLOWANCE
        );

        _initialize_v3();
        initialized();
    }

    /**
     * @notice A function to finalize upgrade to v3 (from v2). Can be called only once
     *
     * For more details see https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-10.md
     */
    function finalizeUpgrade_v3() external {
        require(hasInitialized(), "NOT_INITIALIZED");
        _checkContractVersion(2);

        _initialize_v3();
    }

    /**
     * initializer for the Lido version "3"
     */
    function _initialize_v3() internal {
        _setContractVersion(3);
    }

    /**
     * @notice Stops accepting new Ether to the protocol
     *
     * @dev While accepting new Ether is stopped, calls to the `submit` function,
     * as well as to the default payable function, will revert.
     *
     * Emits `StakingPaused` event.
     */
    function pauseStaking() external {
        _auth(STAKING_PAUSE_ROLE);

        _pauseStaking();
    }

    /**
     * @notice Resumes accepting new Ether to the protocol (if `pauseStaking` was called previously)
     * NB: Staking could be rate-limited by imposing a limit on the stake amount
     * at each moment in time, see `setStakingLimit()` and `removeStakingLimit()`
     *
     * @dev Preserves staking limit if it was set previously
     *
     * Emits `StakingResumed` event
     */
    function resumeStaking() external {
        _auth(STAKING_CONTROL_ROLE);
        require(hasInitialized(), "NOT_INITIALIZED");

        _resumeStaking();
    }

    /**
     * @notice Sets the staking rate limit
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
     * Emits `StakingLimitSet` event
     *
     * @param _maxStakeLimit max stake limit value
     * @param _stakeLimitIncreasePerBlock stake limit increase per single block
     */
    function setStakingLimit(uint256 _maxStakeLimit, uint256 _stakeLimitIncreasePerBlock) external {
        _auth(STAKING_CONTROL_ROLE);

        STAKING_STATE_POSITION.setStorageStakeLimitStruct(
            STAKING_STATE_POSITION.getStorageStakeLimitStruct().setStakingLimit(_maxStakeLimit, _stakeLimitIncreasePerBlock)
        );

        emit StakingLimitSet(_maxStakeLimit, _stakeLimitIncreasePerBlock);
    }

    /**
     * @notice Removes the staking rate limit
     *
     * Emits `StakingLimitRemoved` event
     */
    function removeStakingLimit() external {
        _auth(STAKING_CONTROL_ROLE);

        STAKING_STATE_POSITION.setStorageStakeLimitStruct(STAKING_STATE_POSITION.getStorageStakeLimitStruct().removeStakingLimit());

        emit StakingLimitRemoved();
    }

    /**
     * @notice Check staking state: whether it's paused or not
     */
    function isStakingPaused() external view returns (bool) {
        return STAKING_STATE_POSITION.getStorageStakeLimitStruct().isStakingPaused();
    }

    /**
     * @notice Returns how much Ether can be staked in the current block
     * @dev Special return values:
     * - 2^256 - 1 if staking is unlimited;
     * - 0 if staking is paused or if limit is exhausted.
     */
    function getCurrentStakeLimit() external view returns (uint256) {
        return _getCurrentStakeLimit(STAKING_STATE_POSITION.getStorageStakeLimitStruct());
    }

    /**
     * @notice Returns full info about current stake limit params and state
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

    /// @return max external ratio in basis points
    function getMaxExternalRatioBP() external view returns (uint256) {
        return MAX_EXTERNAL_RATIO_POSITION.getStorageUint256();
    }

    /// @notice Sets the maximum allowed external balance as basis points of total pooled ether
    /// @param _maxExternalRatioBP The maximum basis points [0-10000]
    function setMaxExternalRatioBP(uint256 _maxExternalRatioBP) external {
        _auth(STAKING_CONTROL_ROLE);

        require(_maxExternalRatioBP <= TOTAL_BASIS_POINTS, "INVALID_MAX_EXTERNAL_RATIO");

        MAX_EXTERNAL_RATIO_POSITION.setStorageUint256(_maxExternalRatioBP);

        emit MaxExternalRatioBPSet(_maxExternalRatioBP);
    }

    /**
    * @notice Send funds to the pool
    * @dev Users are able to submit their funds by transacting to the fallback function.
    * Unlike vanilla Ethereum Deposit contract, accepting only 32-Ether transactions, Lido
    * accepts payments of any size. Submitted Ethers are stored in Buffer until someone calls
    * deposit() and pushes them to the Ethereum Deposit contract.
    */
    // solhint-disable-next-line no-complex-fallback
    function() external payable {
        // protection against accidental submissions by calling non-existent function
        require(msg.data.length == 0, "NON_EMPTY_DATA");
        _submit(0);
    }

    /**
     * @notice Send funds to the pool with optional _referral parameter
     * @dev This function is alternative way to submit funds. Supports optional referral address.
     * @return Amount of StETH shares generated
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
        require(msg.sender == getLidoLocator().elRewardsVault());

        TOTAL_EL_REWARDS_COLLECTED_POSITION.setStorageUint256(getTotalELRewardsCollected().add(msg.value));

        emit ELRewardsReceived(msg.value);
    }

    /**
    * @notice A payable function for withdrawals acquisition. Can be called only by `WithdrawalVault`
    * @dev We need a dedicated function because funds received by the default payable function
    * are treated as a user deposit
    */
    function receiveWithdrawals() external payable {
        require(msg.sender == getLidoLocator().withdrawalVault());

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
     * @notice Unsafely change deposited validators
     *
     * The method unsafely changes deposited validator counter.
     * Can be required when onboarding external validators to Lido
     * (i.e., had deposited before and rotated their type-0x00 withdrawal credentials to Lido)
     *
     * @param _newDepositedValidators new value
     */
    function unsafeChangeDepositedValidators(uint256 _newDepositedValidators) external {
        _auth(UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE);

        DEPOSITED_VALIDATORS_POSITION.setStorageUint256(_newDepositedValidators);

        emit DepositedValidatorsChanged(_newDepositedValidators);
    }

    /**
    * @notice Get the amount of Ether temporary buffered on this contract balance
    * @dev Buffered balance is kept on the contract from the moment the funds are received from user
    * until the moment they are actually sent to the official Deposit contract.
    * @return amount of buffered funds in wei
    */
    function getBufferedEther() external view returns (uint256) {
        return _getBufferedEther();
    }

    /**
     * @notice Get the amount of ether held by external contracts
     * @return amount of external ether in wei
     */
    function getExternalEther() external view returns (uint256) {
        return _getExternalEther(_getInternalEther());
    }

    /**
     * @notice Get the total amount of external shares
     * @return total external shares
     */
    function getExternalShares() external view returns (uint256) {
        return EXTERNAL_SHARES_POSITION.getStorageUint256();
    }

    /**
     * @notice Get the maximum amount of external shares that can be minted under the current external ratio limit
     * @return maximum mintable external shares
     */
    function getMaxMintableExternalShares() external view returns (uint256) {
        return _getMaxMintableExternalShares();
    }

    /**
     * @notice Get total amount of execution layer rewards collected to Lido contract
     * @dev Ether got through LidoExecutionLayerRewardsVault is kept on this contract's balance the same way
     * as other buffered Ether is kept (until it gets deposited)
     * @return amount of funds received as execution layer rewards in wei
     */
    function getTotalELRewardsCollected() public view returns (uint256) {
        return TOTAL_EL_REWARDS_COLLECTED_POSITION.getStorageUint256();
    }

    /**
     * @notice Gets authorized oracle address
     * @return address of oracle contract
     */
    function getLidoLocator() public view returns (ILidoLocator) {
        return ILidoLocator(LIDO_LOCATOR_POSITION.getStorageAddress());
    }

    /**
    * @notice Returns the key values related to Consensus Layer side of the contract. It historically contains beacon
    * @return depositedValidators - number of deposited validators from Lido contract side
    * @return beaconValidators - number of Lido validators visible on Consensus Layer, reported by oracle
    * @return beaconBalance - total amount of ether on the Consensus Layer side (sum of all the balances of Lido validators)
    */
    function getBeaconStat() external view returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance) {
        depositedValidators = DEPOSITED_VALIDATORS_POSITION.getStorageUint256();
        beaconValidators = CL_VALIDATORS_POSITION.getStorageUint256();
        beaconBalance = CL_BALANCE_POSITION.getStorageUint256();
    }

    /**
     * @dev Check that Lido allows depositing buffered ether to the consensus layer
     * Depends on the bunker state and protocol's pause state
     */
    function canDeposit() public view returns (bool) {
        return !_withdrawalQueue().isBunkerModeActive() && !isStopped();
    }

    /**
     * @dev Returns depositable ether amount.
     * Takes into account unfinalized stETH required by WithdrawalQueue
     */
    function getDepositableEther() public view returns (uint256) {
        uint256 bufferedEther = _getBufferedEther();
        uint256 withdrawalReserve = _withdrawalQueue().unfinalizedStETH();
        return bufferedEther > withdrawalReserve ? bufferedEther - withdrawalReserve : 0;
    }

    /**
     * @dev Invokes a deposit call to the Staking Router contract and updates buffered counters
     * @param _maxDepositsCount max deposits count
     * @param _stakingModuleId id of the staking module to be deposited
     * @param _depositCalldata module calldata
     */
    function deposit(
        uint256 _maxDepositsCount,
        uint256 _stakingModuleId,
        bytes _depositCalldata
    ) external {
        ILidoLocator locator = getLidoLocator();

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
            BUFFERED_ETHER_POSITION.setStorageUint256(_getBufferedEther().sub(depositsValue));
            emit Unbuffered(depositsValue);

            uint256 newDepositedValidators = DEPOSITED_VALIDATORS_POSITION.getStorageUint256().add(depositsCount);
            DEPOSITED_VALIDATORS_POSITION.setStorageUint256(newDepositedValidators);
            emit DepositedValidatorsChanged(newDepositedValidators);
        }

        /// @dev transfer ether to StakingRouter and make a deposit at the same time. All the ether
        ///     sent to StakingRouter is counted as deposited. If StakingRouter can't deposit all
        ///     passed ether it MUST revert the whole transaction (never happens in normal circumstances)
        stakingRouter.deposit.value(depositsValue)(depositsCount, _stakingModuleId, _depositCalldata);
    }

    /// @notice Mint stETH shares
    /// @param _recipient recipient of the shares
    /// @param _amountOfShares amount of shares to mint
    /// @dev can be called only by accounting
    function mintShares(address _recipient, uint256 _amountOfShares) public {
        _auth(getLidoLocator().accounting());

        _mintShares(_recipient, _amountOfShares);
        // emit event after minting shares because we are always having the net new ether under the hood
        // for vaults we have new locked ether and for fees we have a part of rewards
        _emitTransferAfterMintingShares(_recipient, _amountOfShares);
    }

    /// @notice Burn stETH shares from the sender address
    /// @param _amountOfShares amount of shares to burn
    /// @dev can be called only by burner
    function burnShares(uint256 _amountOfShares) public {
        _auth(getLidoLocator().burner());

        _burnShares(msg.sender, _amountOfShares);

        // historically there is no events for this kind of burning
        // TODO: should burn events be emitted here?
        // maybe TransferShare for cover burn and all events for withdrawal burn
    }

    /// @notice Mint shares backed by external vaults
    ///
    /// @param _receiver Address to receive the minted shares
    /// @param _amountOfShares Amount of shares to mint
    /// @dev Can be called only by accounting (authentication in mintShares method).
    ///      NB: Reverts if the the external balance limit is exceeded.
    function mintExternalShares(address _receiver, uint256 _amountOfShares) external {
        require(_receiver != address(0), "MINT_RECEIVER_ZERO_ADDRESS");
        require(_amountOfShares != 0, "MINT_ZERO_AMOUNT_OF_SHARES");

        // TODO: separate role and flag for external shares minting pause
        require(!STAKING_STATE_POSITION.getStorageStakeLimitStruct().isStakingPaused(), "STAKING_PAUSED");

        uint256 newExternalShares = EXTERNAL_SHARES_POSITION.getStorageUint256().add(_amountOfShares);
        uint256 maxMintableExternalShares = _getMaxMintableExternalShares();

        require(newExternalShares <= maxMintableExternalShares, "EXTERNAL_BALANCE_LIMIT_EXCEEDED");

        EXTERNAL_SHARES_POSITION.setStorageUint256(newExternalShares);

        mintShares(_receiver, _amountOfShares);

        emit ExternalSharesMinted(_receiver, _amountOfShares, getPooledEthByShares(_amountOfShares));
    }

    /// @notice Burns external shares from a specified account
    ///
    /// @param _amountOfShares Amount of shares to burn
    function burnExternalShares(uint256 _amountOfShares) external {
        require(_amountOfShares != 0, "BURN_ZERO_AMOUNT_OF_SHARES");
        _auth(getLidoLocator().accounting());

        uint256 externalShares = EXTERNAL_SHARES_POSITION.getStorageUint256();

        if (externalShares < _amountOfShares) revert("EXT_SHARES_TOO_SMALL");
        EXTERNAL_SHARES_POSITION.setStorageUint256(externalShares - _amountOfShares);

        _burnShares(msg.sender, _amountOfShares);

        uint256 stethAmount = getPooledEthByShares(_amountOfShares);
        _emitTransferEvents(msg.sender, address(0), stethAmount, _amountOfShares);
        emit ExternalSharesBurned(msg.sender, _amountOfShares, stethAmount);
    }

    /// @notice processes CL related state changes as a part of the report processing
    /// @dev all data validation was done by Accounting and OracleReportSanityChecker
    /// @param _reportTimestamp timestamp of the report
    /// @param _preClValidators number of validators in the previous CL state (for event compatibility)
    /// @param _reportClValidators number of validators in the current CL state
    /// @param _reportClBalance total balance of the current CL state
    /// @param _postExternalShares total external shares
    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _preClValidators,
        uint256 _reportClValidators,
        uint256 _reportClBalance,
        uint256 _postExternalShares
    ) external {
        _whenNotStopped();

        _auth(getLidoLocator().accounting());

        // Save the current CL balance and validators to
        // calculate rewards on the next rebase
        CL_VALIDATORS_POSITION.setStorageUint256(_reportClValidators);
        CL_BALANCE_POSITION.setStorageUint256(_reportClBalance);
        EXTERNAL_SHARES_POSITION.setStorageUint256(_postExternalShares);

        emit CLValidatorsUpdated(_reportTimestamp, _preClValidators, _reportClValidators);
        // cl and external balance change are logged in ETHDistributed event later
    }

    /// @notice processes withdrawals and rewards as a part of the report processing
    /// @dev all data validation was done by Accounting and OracleReportSanityChecker
    /// @param _reportTimestamp timestamp of the report
    /// @param _reportClBalance total balance of validators reported by the oracle
    /// @param _adjustedPreCLBalance total balance of validators in the previous report and deposits made since then
    /// @param _withdrawalsToWithdraw amount of withdrawals to collect from WithdrawalsVault
    /// @param _elRewardsToWithdraw amount of EL rewards to collect from ELRewardsVault
    /// @param _lastWithdrawalRequestToFinalize last withdrawal request ID to finalize
    /// @param _withdrawalsShareRate share rate used to fulfill withdrawal requests
    /// @param _etherToLockOnWithdrawalQueue amount of ETH to lock on the WithdrawalQueue to fulfill withdrawal requests
    function collectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _adjustedPreCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _withdrawalsShareRate,
        uint256 _etherToLockOnWithdrawalQueue
    ) external {
        _whenNotStopped();

        ILidoLocator locator = getLidoLocator();
        _auth(locator.accounting());

        // withdraw execution layer rewards and put them to the buffer
        if (_elRewardsToWithdraw > 0) {
            ILidoExecutionLayerRewardsVault(locator.elRewardsVault())
                .withdrawRewards(_elRewardsToWithdraw);
        }

        // withdraw withdrawals and put them to the buffer
        if (_withdrawalsToWithdraw > 0) {
            IWithdrawalVault(locator.withdrawalVault())
                .withdrawWithdrawals(_withdrawalsToWithdraw);
        }

        // finalize withdrawals (send ether, assign shares for burning)
        if (_etherToLockOnWithdrawalQueue > 0) {
            IWithdrawalQueue(locator.withdrawalQueue())
                .finalize.value(_etherToLockOnWithdrawalQueue)(
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
            _adjustedPreCLBalance,
            _reportClBalance,
            _withdrawalsToWithdraw,
            _elRewardsToWithdraw,
            postBufferedEther
        );
    }

    /// @notice emit TokenRebase event
    /// @dev it's here for back compatibility reasons
    function emitTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external {
        _auth(getLidoLocator().accounting());

        emit TokenRebased(
            _reportTimestamp,
            _timeElapsed,
            _preTotalShares,
            _preTotalEther,
            _postTotalShares,
            _postTotalEther,
            _sharesMintedAsFees
        );
    }

    // DEPRECATED PUBLIC METHODS

    /**
     * @notice Returns current withdrawal credentials of deposited validators
     * @dev DEPRECATED: use StakingRouter.getWithdrawalCredentials() instead
     */
    function getWithdrawalCredentials() external view returns (bytes32) {
        return _stakingRouter().getWithdrawalCredentials();
    }

    /**
     * @notice Returns legacy oracle
     * @dev DEPRECATED: the `AccountingOracle` superseded the old one
     */
    function getOracle() external view returns (address) {
        return getLidoLocator().legacyOracle();
    }

    /**
     * @notice Returns the treasury address
     * @dev DEPRECATED: use LidoLocator.treasury()
     */
    function getTreasury() external view returns (address) {
        return getLidoLocator().treasury();
    }

    /**
     * @notice Returns current staking rewards fee rate
     * @dev DEPRECATED: Now fees information is stored in StakingRouter and
     * with higher precision. Use StakingRouter.getStakingFeeAggregateDistribution() instead.
     * @return totalFee total rewards fee in 1e4 precision (10000 is 100%). The value might be
     * inaccurate because the actual value is truncated here to 1e4 precision.
     */
    function getFee() external view returns (uint16 totalFee) {
        totalFee = _stakingRouter().getTotalFeeE4Precision();
    }

    /**
     * @notice Returns current fee distribution, values relative to the total fee (getFee())
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
        external view
        returns (
            uint16 treasuryFeeBasisPoints,
            uint16 insuranceFeeBasisPoints,
            uint16 operatorsFeeBasisPoints
        )
    {
        IStakingRouter stakingRouter = _stakingRouter();
        uint256 totalBasisPoints = stakingRouter.TOTAL_BASIS_POINTS();
        uint256 totalFee = stakingRouter.getTotalFeeE4Precision();
        (uint256 treasuryFeeBasisPointsAbs, uint256 operatorsFeeBasisPointsAbs) = stakingRouter
            .getStakingFeeAggregateDistributionE4Precision();

        insuranceFeeBasisPoints = 0;  // explicitly set to zero
        treasuryFeeBasisPoints = uint16((treasuryFeeBasisPointsAbs * totalBasisPoints) / totalFee);
        operatorsFeeBasisPoints = uint16((operatorsFeeBasisPointsAbs * totalBasisPoints) / totalFee);
    }

    /**
     * @notice Overrides default AragonApp behavior to disallow recovery.
     */
    function transferToVault(address /* _token */) external {
        revert("NOT_SUPPORTED");
    }

    /**
     * @dev Process user deposit, mints liquid tokens and increase the pool buffer
     * @param _referral address of referral.
     * @return amount of StETH shares generated
     */
    function _submit(address _referral) internal returns (uint256) {
        require(msg.value != 0, "ZERO_DEPOSIT");

        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();
        // There is an invariant that protocol pause also implies staking pause.
        // Thus, no need to check protocol pause explicitly.
        require(!stakeLimitData.isStakingPaused(), "STAKING_PAUSED");

        if (stakeLimitData.isStakingLimitSet()) {
            uint256 currentStakeLimit = stakeLimitData.calculateCurrentStakeLimit();

            require(msg.value <= currentStakeLimit, "STAKE_LIMIT");

            STAKING_STATE_POSITION.setStorageStakeLimitStruct(stakeLimitData.updatePrevStakeLimit(currentStakeLimit - msg.value));
        }

        uint256 sharesAmount = getSharesByPooledEth(msg.value);

        _mintShares(msg.sender, sharesAmount);

        _setBufferedEther(_getBufferedEther().add(msg.value));
        emit Submitted(msg.sender, msg.value, _referral);

        _emitTransferAfterMintingShares(msg.sender, sharesAmount);
        return sharesAmount;
    }

    /**
     * @dev Gets the amount of Ether temporary buffered on this contract balance
     */
    function _getBufferedEther() internal view returns (uint256) {
        return BUFFERED_ETHER_POSITION.getStorageUint256();
    }

    /**
     * @dev Sets the amount of Ether temporary buffered on this contract balance
     * @param _newBufferedEther new amount of buffered funds in wei
     */
    function _setBufferedEther(uint256 _newBufferedEther) internal {
        BUFFERED_ETHER_POSITION.setStorageUint256(_newBufferedEther);
    }

    /// @dev Calculates and returns the total base balance (multiple of 32) of validators in transient state,
    ///     i.e. submitted to the official Deposit contract but not yet visible in the CL state.
    /// @return transient ether in wei (1e-18 Ether)
    function _getTransientEther() internal view returns (uint256) {
        uint256 depositedValidators = DEPOSITED_VALIDATORS_POSITION.getStorageUint256();
        uint256 clValidators = CL_VALIDATORS_POSITION.getStorageUint256();
        // clValidators can never be less than deposited ones.
        assert(depositedValidators >= clValidators);

        return (depositedValidators - clValidators).mul(DEPOSIT_SIZE);
    }

    function _getInternalEther() internal view returns (uint256) {
        return _getBufferedEther()
        .add(CL_BALANCE_POSITION.getStorageUint256())
            .add(_getTransientEther());
    }

    function _getExternalEther(uint256 _internalEther) internal view returns (uint256) {
        // TODO: cache external ether to storage
        // to exchange 1 SLOAD in _getTotalPooledEther() 1 SSTORE in mintEE/burnEE
        // _getTPE is super wide used
        uint256 externalShares = EXTERNAL_SHARES_POSITION.getStorageUint256();
        uint256 internalShares = _getTotalShares() - externalShares;
        return externalShares.mul(_internalEther).div(internalShares);
    }

    /**
     * @dev Gets the total amount of Ether controlled by the protocol and external entities
     * @return total balance in wei
     */
    function _getTotalPooledEther() internal view returns (uint256) {
        uint256 internalEther = _getInternalEther();
        return internalEther.add(_getExternalEther(internalEther));
    }

    /// @notice Calculates the maximum amount of external shares that can be minted while maintaining
    ///         maximum allowed external ratio limits
    /// @return Maximum amount of external shares that can be minted
    /// @dev This function enforces the ratio between external and total shares to stay below a limit.
    ///      The limit is defined by some maxRatioBP out of totalBP.
    ///
    ///      The calculation ensures: (external + x) / (total + x) <= maxRatioBP / totalBP
    ///      Which gives formula: x <= (total * maxRatioBP - external * totalBP) / (totalBP - maxRatioBP)
    ///
    ///      Special cases:
    ///      - Returns 0 if maxBP is 0 (external minting is disabled) or external shares already exceed the limit
    function _getMaxMintableExternalShares() internal view returns (uint256) {
        uint256 maxRatioBP = MAX_EXTERNAL_RATIO_POSITION.getStorageUint256();
        uint256 externalShares = EXTERNAL_SHARES_POSITION.getStorageUint256();
        uint256 totalShares = _getTotalShares();

        if (maxRatioBP == 0) return 0;
        if (maxRatioBP == TOTAL_BASIS_POINTS) return uint256(-1);
        if (totalShares.mul(maxRatioBP) <= externalShares.mul(TOTAL_BASIS_POINTS)) return 0;

        return (totalShares.mul(maxRatioBP).sub(externalShares.mul(TOTAL_BASIS_POINTS)))
            .div(TOTAL_BASIS_POINTS.sub(maxRatioBP));
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

    /**
     * @dev Size-efficient analog of the `auth(_role)` modifier
     * @param _role Permission name
     */
    function _auth(bytes32 _role) internal view {
        require(canPerform(msg.sender, _role, new uint256[](0)), "APP_AUTH_FAILED");
    }

    // @dev simple address-based auth
    function _auth(address _address) internal view {
        require(msg.sender == _address, "APP_AUTH_FAILED");
    }

    function _stakingRouter() internal view returns (IStakingRouter) {
        return IStakingRouter(getLidoLocator().stakingRouter());
    }

    function _withdrawalQueue() internal view returns (IWithdrawalQueue) {
        return IWithdrawalQueue(getLidoLocator().withdrawalQueue());
    }

    /**
     * @notice Mints shares on behalf of 0xdead address,
     * the shares amount is equal to the contract's balance.     *
     *
     * Allows to get rid of zero checks for `totalShares` and `totalPooledEther`
     * and overcome corner cases.
     *
     * NB: reverts if the current contract's balance is zero.
     *
     * @dev must be invoked before using the token
     */
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
}
