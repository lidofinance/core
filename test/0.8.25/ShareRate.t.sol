// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import {WithdrawalQueueBase} from "contracts/0.8.9/WithdrawalQueueBase.sol";
import {WithdrawalQueueERC721} from "contracts/0.8.9/WithdrawalQueueERC721.sol";
import {EIP712StETH} from "contracts/0.8.9/EIP712StETH.sol";
import {LidoLocator} from "contracts/0.8.9/LidoLocator.sol";
import {BaseProtocolTest, ILido} from "./Protocol__Deployment.t.sol";

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

// Number of blocks in one day (assuming 12 second block time)
uint256 constant ONE_DAY_IN_BLOCKS = 7_200;

// Protocol configuration constants
uint256 constant MAX_EXTERNAL_RATIO_BP = 10_000; // 100%
uint256 constant MAX_STAKE_LIMIT = 15_000_000 ether;
uint256 constant STAKE_LIMIT_INCREASE_PER_BLOCK = 20 ether;
uint256 constant MAX_AMOUNT_OF_SHARES = 100;
uint256 constant PROTOCOL_START_BALANCE = 15_000 ether;
uint256 constant PROTOCOL_START_EXTERNAL_SHARES = 10_000;

// Test account addresses
address constant ROOT_ACCOUNT = address(0x123);
address constant USER_ACCOUNT = address(0x321);

// Withdrawal queue configuration
uint256 constant MIN_WITHDRAWAL_AMOUNT = 0.0005 ether;
uint256 constant MAX_WITHDRAWAL_AMOUNT = 1000 ether;
uint256 constant FINALIZATION_DELAY_BLOCKS = 1_500;
uint256 constant FINALIZATION_DELAY_DAYS = 1;
uint256 constant FINALIZATION_ETH_BUFFER = 10_000 ether;
uint256 constant MAX_BATCHES_SIZE = 36;
uint256 constant BATCH_CALCULATION_TIMEOUT = 1_000;
uint256 constant BATCH_CALCULATION_MAX_ITERATIONS = 3;

// Share rate bounds for finalization
uint256 constant MIN_SHARE_RATE = 0.0001 * 10 ** 27;
uint256 constant MAX_SHARE_RATE = 100 * 10 ** 27;

// Test user configuration
uint256 constant USER_COUNT = 1_000;

contract ShareRateHandler is CommonBase, StdCheats, StdUtils {
    // Protocol contracts
    ILido public lidoContract;
    WithdrawalQueueERC721 public wqContract;
    address public vaultHub;

    // Account addresses
    address public userAccount;
    address public rootAccount;

    // Test state tracking
    uint256 public maxAmountOfShares;
    uint256[] public amountsQW;
    address[] public users;
    uint256 public constant userCount = 1_000;

    constructor(
        ILido _lido,
        WithdrawalQueueERC721 _wqContract,
        address _vaultHub,
        address _userAccount,
        address _rootAccount,
        uint256 _maxAmountOfShares
    ) {
        lidoContract = _lido;
        wqContract = _wqContract;
        vaultHub = _vaultHub;
        userAccount = _userAccount;
        rootAccount = _rootAccount;
        maxAmountOfShares = _maxAmountOfShares;

        _initializeUsers();
    }

    /// Actions for fuzzing

    function mintExternalShares(address _recipient, uint256 _amountOfShares) external returns (bool) {
        vm.assume(_recipient != address(0));

        _amountOfShares = bound(_amountOfShares, 1, maxAmountOfShares);

        vm.prank(userAccount);
        lidoContract.resumeStaking();

        vm.prank(vaultHub);
        lidoContract.mintExternalShares(_recipient, _amountOfShares);

        return true;
    }

    function burnExternalShares(uint256 _amountOfShares) external returns (bool) {
        uint256 totalShares = lidoContract.getExternalShares();
        if (totalShares != 0) {
            _amountOfShares = bound(_amountOfShares, 2, maxAmountOfShares);
        } else {
            _amountOfShares = 1;
        }

        vm.prank(userAccount);
        lidoContract.resumeStaking();

        vm.prank(vaultHub);
        lidoContract.burnExternalShares(_amountOfShares);

        return true;
    }

    function submit(uint256 _senderId, uint256 _amountETH) external payable returns (bool) {
        _senderId = _boundSenderId(_senderId);
        address sender = users[_senderId];

        _amountETH = bound(_amountETH, MIN_WITHDRAWAL_AMOUNT, MAX_WITHDRAWAL_AMOUNT);
        vm.deal(sender, _amountETH);

        vm.prank(sender);
        lidoContract.submit{value: _amountETH}(address(0));
        vm.roll(block.number + ONE_DAY_IN_BLOCKS);

        return true;
    }

    function transfer(uint256 _senderId, uint256 _recipientId, uint256 _amountTokens) external payable returns (bool) {
        _senderId = _boundSenderId(_senderId);
        _recipientId = _boundSenderId(_recipientId);

        if (_recipientId == _senderId) {
            return false;
        }

        address _sender = users[_senderId];
        address _recipient = users[_recipientId];

        if (_getLidoUserBalance(_sender) == 0) {
            vm.prank(_sender);
            this.submit(_senderId, _amountTokens);
        }

        _amountTokens = bound(_amountTokens, 1, _getLidoUserBalance(_sender));

        vm.prank(_sender);
        lidoContract.transfer(_recipient, _amountTokens);
        vm.roll(block.number + ONE_DAY_IN_BLOCKS);

        return true;
    }

    function withdrawStEth(
        uint256 _ownerId,
        uint256 _amountTokens,
        uint256 _maxShareRate
    ) external payable returns (bool) {
        _ownerId = _boundSenderId(_ownerId);
        address _owner = users[_ownerId];

        _ensureUserHasTokens(_owner, _ownerId, _amountTokens);

        uint256 userBalance = _getLidoUserBalance(_owner);

        vm.prank(_owner);
        lidoContract.approve(address(wqContract), userBalance);
        vm.roll(block.number + 1);

        _amountTokens = _prepareWithdrawalAmounts(_amountTokens, userBalance);

        vm.prank(_owner);
        uint256[] memory requestIds = wqContract.requestWithdrawals(amountsQW, _owner);
        delete amountsQW;

        vm.roll(block.number + FINALIZATION_DELAY_BLOCKS);
        vm.warp(block.timestamp + FINALIZATION_DELAY_DAYS);

        _finalize(_maxShareRate, _amountTokens + FINALIZATION_ETH_BUFFER);

        _claimWithdrawals(_owner, requestIds);

        return true;
    }

    // Getters

    function getTotalShares() external view returns (uint256) {
        return lidoContract.getTotalShares();
    }

    /// Helpers

    function _getLidoUserBalance(address _owner) public view returns (uint256) {
        return lidoContract.balanceOf(_owner);
    }

    function _initializeUsers() private {
        for (uint256 i = 0; i <= USER_COUNT; i++) {
            uint256 privateKey = uint256(keccak256(abi.encodePacked(i)));
            address randomAddr = vm.addr(privateKey);
            users.push(randomAddr);
        }
    }

    function _boundSenderId(uint256 _senderId) private view returns (uint256) {
        if (_senderId > this.userCount()) {
            return bound(_senderId, 0, this.userCount());
        }
        return _senderId;
    }

    function _ensureUserHasTokens(address _owner, uint256 _ownerId, uint256 _amountTokens) private {
        if (_getLidoUserBalance(_owner) == 0) {
            vm.prank(_owner);
            this.submit(_ownerId, _amountTokens);
        }

        if (_getLidoUserBalance(_owner) < wqContract.MIN_STETH_WITHDRAWAL_AMOUNT()) {
            vm.prank(_owner);
            this.submit(_ownerId, _amountTokens);
        }
    }

    function _prepareWithdrawalAmounts(uint256 _amountTokens, uint256 _userBalance) private returns (uint256) {
        _amountTokens = bound(_amountTokens, wqContract.MIN_STETH_WITHDRAWAL_AMOUNT(), _userBalance);

        if (_amountTokens >= wqContract.MAX_STETH_WITHDRAWAL_AMOUNT()) {
            while (_amountTokens >= wqContract.MAX_STETH_WITHDRAWAL_AMOUNT()) {
                amountsQW.push(wqContract.MAX_STETH_WITHDRAWAL_AMOUNT());
                _amountTokens -= wqContract.MAX_STETH_WITHDRAWAL_AMOUNT();
            }

            if (_amountTokens > 0 && _amountTokens >= wqContract.MIN_STETH_WITHDRAWAL_AMOUNT()) {
                amountsQW.push(_amountTokens);
            }
        } else {
            amountsQW.push(_amountTokens);
        }

        return _amountTokens;
    }

    function _calculateBatches(
        uint256 _ethBudget,
        uint256 _maxShareRate
    ) public view returns (uint256[] memory batches) {
        uint256[MAX_BATCHES_SIZE] memory emptyBatches;
        WithdrawalQueueBase.BatchesCalculationState memory state = WithdrawalQueueBase.BatchesCalculationState(
            _ethBudget * 1 ether,
            false,
            emptyBatches,
            0
        );

        while (!state.finished) {
            state = wqContract.calculateFinalizationBatches(
                _maxShareRate,
                block.timestamp + BATCH_CALCULATION_TIMEOUT,
                BATCH_CALCULATION_MAX_ITERATIONS,
                state
            );
        }

        batches = new uint256[](state.batchesLength);
        for (uint256 i; i < state.batchesLength; ++i) {
            batches[i] = state.batches[i];
        }
    }

    function _finalize(uint256 _maxShareRate, uint256 _ethBudget) public payable {
        _maxShareRate = bound(_maxShareRate, MIN_SHARE_RATE, MAX_SHARE_RATE);

        uint256[] memory batches = _calculateBatches(_ethBudget, _maxShareRate);

        if (batches.length > 0) {
            (uint256 eth, ) = wqContract.prefinalize(batches, _maxShareRate);

            vm.deal(address(rootAccount), eth);
            vm.prank(rootAccount);
            wqContract.finalize{value: eth}(batches[batches.length - 1], _maxShareRate);
        }
    }

    function _claimWithdrawals(address _owner, uint256[] memory _requestIds) private {
        if (wqContract.getLastFinalizedRequestId() > 0) {
            WithdrawalQueueBase.WithdrawalRequestStatus[] memory requestStatues = wqContract.getWithdrawalStatus(
                _requestIds
            );

            for (uint256 i = 0; i < _requestIds.length; i++) {
                if (!requestStatues[i].isClaimed) {
                    vm.deal(_owner, 1 ether);
                    vm.prank(_owner);
                    wqContract.claimWithdrawal(_requestIds[i]);
                }
            }
        }
    }
}

contract ShareRateTest is BaseProtocolTest {
    // Contract under test
    ShareRateHandler public shareRateHandler;

    function setUp() public {
        // Initialize protocol with starting balance and accounts
        BaseProtocolTest.setUpProtocol(PROTOCOL_START_BALANCE, ROOT_ACCOUNT, USER_ACCOUNT);
        address vaultHubAddress = lidoLocator.vaultHub();

        // Configure protocol parameters
        _configureProtocolSettings();

        // Initialize the handler
        shareRateHandler = new ShareRateHandler(
            lidoContract,
            wq,
            vaultHubAddress,
            USER_ACCOUNT,
            ROOT_ACCOUNT,
            MAX_AMOUNT_OF_SHARES
        );

        // Configure fuzzing targets
        bytes4[] memory externalSharesSelectors = new bytes4[](5);
        externalSharesSelectors[0] = shareRateHandler.mintExternalShares.selector;
        externalSharesSelectors[1] = shareRateHandler.burnExternalShares.selector;
        externalSharesSelectors[2] = shareRateHandler.submit.selector;
        externalSharesSelectors[3] = shareRateHandler.transfer.selector;
        externalSharesSelectors[4] = shareRateHandler.withdrawStEth.selector;

        targetContract(address(shareRateHandler));
        targetSelector(FuzzSelector({addr: address(shareRateHandler), selectors: externalSharesSelectors}));

        // Initialize with starting shares
        _provisionProtocol(vaultHubAddress);

        // Advance blockchain state
        vm.roll(block.number + ONE_DAY_IN_BLOCKS);
    }

    function _configureProtocolSettings() private {
        vm.startPrank(USER_ACCOUNT);
        lidoContract.setMaxExternalRatioBP(MAX_EXTERNAL_RATIO_BP);
        lidoContract.setStakingLimit(MAX_STAKE_LIMIT, STAKE_LIMIT_INCREASE_PER_BLOCK);
        lidoContract.resume();
        vm.stopPrank();
    }

    function _provisionProtocol(address vaultHubAddress) private {
        // Mint external shares to simulate existing shares for burn operations
        vm.prank(vaultHubAddress);
        lidoContract.mintExternalShares(vaultHubAddress, PROTOCOL_START_EXTERNAL_SHARES);
        shareRateHandler.submit(0, 10 ether);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_totalShares() public view {
        assertEq(lidoContract.getTotalShares(), shareRateHandler.getTotalShares());
    }
}
