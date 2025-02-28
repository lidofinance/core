// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import "../../contracts/0.8.9/WithdrawalQueueBase.sol";
import "../../contracts/0.8.9/WithdrawalQueueERC721.sol";
import "contracts/0.8.9/EIP712StETH.sol";
import {LidoLocator} from "contracts/0.8.9/LidoLocator.sol";
import {BaseProtocolTest, ILido} from "./Protocol__Deployment.t.sol";

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

uint256 constant ONE_DAY_IN_BLOCKS = 7_200;

contract ShareRateHandler is CommonBase, StdCheats, StdUtils {
    struct BoundaryValues {
        address externalSharesRecipient;
        uint256 mintedExternalShares;
        uint256 burnExternalShares;
    }

    ILido public lidoContract;
    WithdrawalQueueERC721 public wqContract;
    address public accounting;
    address public userAccount;
    address public rootAccount;

    BoundaryValues public boundaryValues;

    uint256 public maxAmountOfShares;

    uint256[] public amountsQW;
    address[] public users;
    uint256 public constant userCount = 1_000;

    constructor(
        ILido _lido,
        WithdrawalQueueERC721 _wqContract,
        address _accounting,
        address _userAccount,
        address _rootAccount,
        uint256 _maxAmountOfShares
    ) {
        lidoContract = _lido;
        accounting = _accounting;
        userAccount = _userAccount;
        rootAccount = _rootAccount;
        maxAmountOfShares = _maxAmountOfShares;
        wqContract = _wqContract;

        // Initialize boundary values with extreme values
        boundaryValues = BoundaryValues({
            externalSharesRecipient: makeAddr("randomRecipient"),
            mintedExternalShares: 0,
            burnExternalShares: 0
        });

        for (uint256 i = 0; i <= userCount; i++) {
            uint256 privateKey = uint256(keccak256(abi.encodePacked(i)));
            address randomAddr = vm.addr(privateKey);

            users.push(randomAddr);
        }
    }

    function mintExternalShares(address _recipient, uint256 _amountOfShares) external {
        // we don't want to test the zero address case, as it would revert
        vm.assume(_recipient != address(0));

        _amountOfShares = bound(_amountOfShares, 1, maxAmountOfShares);

        vm.prank(userAccount);
        lidoContract.resumeStaking();

        vm.prank(accounting);

        boundaryValues.externalSharesRecipient = _recipient;
        boundaryValues.mintedExternalShares = _amountOfShares;

        lidoContract.mintExternalShares(_recipient, _amountOfShares);
    }

    function burnExternalShares(uint256 _amountOfShares) external {
        uint256 totalShares = lidoContract.getExternalShares();
        if (totalShares != 0) {
            _amountOfShares = bound(_amountOfShares, 2, maxAmountOfShares);
        } else {
            _amountOfShares = 1;
        }

        vm.prank(userAccount);
        lidoContract.resumeStaking();

        vm.prank(accounting);

        boundaryValues.burnExternalShares = _amountOfShares;

        lidoContract.burnExternalShares(_amountOfShares);
    }

    function getTotalShares() external view returns (uint256) {
        return lidoContract.getTotalShares();
    }

    function submit(uint256 _senderId, uint256 _amountETH) external payable returns (bool) {
        if (_senderId > this.userCount()) {
            _senderId = bound(_senderId, 0, this.userCount());
        }

        address sender = users[_senderId];

        _amountETH = bound(_amountETH, 0.0005 ether, 1000 ether);
        vm.deal(sender, _amountETH);

        vm.prank(sender);
        lidoContract.submit{value: _amountETH}(address(0));

        vm.roll(block.number + ONE_DAY_IN_BLOCKS);
        return true;
    }

    function getBalanceByUser(address _owner) public returns (uint256) {
        return lidoContract.balanceOf(_owner);
    }

    function transfer(uint256 _senderId, uint256 _recipientId, uint256 _amountTokens) external payable returns (bool) {
        if (_senderId > this.userCount()) {
            _senderId = bound(_senderId, 0, this.userCount());
        }

        if (_recipientId > this.userCount()) {
            _recipientId = bound(_recipientId, 0, this.userCount());
        }

        if (_recipientId == _senderId) {
            return false;
        }

        address _sender = users[_senderId];
        address _recipient = users[_recipientId];

        if (getBalanceByUser(_sender) == 0) {
            vm.prank(_sender);
            this.submit(_senderId, _amountTokens);
        }

        _amountTokens = bound(_amountTokens, 1, getBalanceByUser(_sender));

        vm.prank(_sender);
        lidoContract.transfer(_recipient, _amountTokens);
        vm.roll(block.number + ONE_DAY_IN_BLOCKS);

        return true;
    }

    function withdrawStEth(
        uint256 _ownerId,
        uint256 _amountTokens,
        uint256 maxShareRate
    ) external payable returns (bool) {
        if (_ownerId > this.userCount()) {
            _ownerId = bound(_ownerId, 0, this.userCount());
        }

        address _owner = users[_ownerId];
        if (getBalanceByUser(_owner) == 0) {
            vm.prank(_owner);
            this.submit(_ownerId, _amountTokens);
        }

        if (getBalanceByUser(_owner) < wqContract.MIN_STETH_WITHDRAWAL_AMOUNT()) {
            vm.prank(_owner);
            this.submit(_ownerId, _amountTokens);
        }

        uint256 userBalance = getBalanceByUser(_owner);

        vm.prank(_owner);
        lidoContract.approve(address(wqContract), userBalance);
        vm.roll(block.number + 1);

        _amountTokens = bound(_amountTokens, wqContract.MIN_STETH_WITHDRAWAL_AMOUNT(), userBalance);
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

        vm.prank(_owner);
        uint256[] memory requestIds = wqContract.requestWithdrawals(amountsQW, _owner);
        delete amountsQW;

        vm.roll(block.number + 1_500);
        vm.warp(block.timestamp + 1 days);
        this.finalize(maxShareRate, _amountTokens + 10_000 * 1 ether);

        if (wqContract.getLastFinalizedRequestId() > 0) {
            WithdrawalQueueBase.WithdrawalRequestStatus[] memory requestStatues = wqContract.getWithdrawalStatus(
                requestIds
            );
            for (uint256 i = 0; i < requestIds.length; i++) {
                if (!requestStatues[i].isClaimed) {
                    vm.deal(_owner, 1 ether);
                    vm.prank(_owner);
                    wqContract.claimWithdrawal(requestIds[i]);
                }
            }
        }

        return true;
    }

    function getBoundaryValues() public view returns (BoundaryValues memory) {
        return boundaryValues;
    }

    function finalize(uint256 maxShareRate, uint256 ethBudget) public payable {
        maxShareRate = bound(maxShareRate, 0.0001 * 10 ** 27, 100 * 10 ** 27);

        uint256[] memory batches = calculateBatches(ethBudget, maxShareRate);

        if (batches.length > 0) {
            (uint256 eth, ) = wqContract.prefinalize(batches, maxShareRate);

            vm.deal(address(rootAccount), eth);
            vm.prank(rootAccount);
            wqContract.finalize{value: eth}(batches[batches.length - 1], maxShareRate);
        }
    }

    function calculateBatches(uint256 ethBudget, uint256 maxShareRate) public view returns (uint256[] memory batches) {
        uint256[36] memory emptyBatches;
        WithdrawalQueueBase.BatchesCalculationState memory state = WithdrawalQueueBase.BatchesCalculationState(
            ethBudget * 1 ether,
            false,
            emptyBatches,
            0
        );
        while (!state.finished) {
            state = wqContract.calculateFinalizationBatches(maxShareRate, block.timestamp + 1_000, 3, state);
        }

        batches = new uint256[](state.batchesLength);
        for (uint256 i; i < state.batchesLength; ++i) {
            batches[i] = state.batches[i];
        }
    }
}

contract ShareRateTest is BaseProtocolTest {
    ShareRateHandler public shareRateHandler;

    uint256 private _maxExternalRatioBP = 10_000;
    uint256 private _maxStakeLimit = 15_000_000 ether;
    uint256 private _stakeLimitIncreasePerBlock = 20 ether;
    uint256 private _maxAmountOfShares = 100;

    uint256 private protocolStartBalance = 15_000 ether;
    uint256 private protocolStartExternalShares = 10_000;

    address private rootAccount = address(0x123);
    address private userAccount = address(0x321);

    function setUp() public {
        BaseProtocolTest.setUpProtocol(protocolStartBalance, rootAccount, userAccount);

        address accountingContract = lidoLocator.accounting();

        vm.startPrank(userAccount);
        lidoContract.setMaxExternalRatioBP(_maxExternalRatioBP);
        lidoContract.setStakingLimit(_maxStakeLimit, _stakeLimitIncreasePerBlock);
        lidoContract.resume();
        vm.stopPrank();

        shareRateHandler = new ShareRateHandler(
            lidoContract,
            wq,
            accountingContract,
            userAccount,
            rootAccount,
            _maxAmountOfShares
        );

        bytes4[] memory externalSharesSelectors = new bytes4[](5);
        externalSharesSelectors[0] = shareRateHandler.mintExternalShares.selector;
        externalSharesSelectors[1] = shareRateHandler.burnExternalShares.selector;
        externalSharesSelectors[2] = shareRateHandler.submit.selector;
        externalSharesSelectors[3] = shareRateHandler.transfer.selector;
        externalSharesSelectors[4] = shareRateHandler.withdrawStEth.selector;

        targetContract(address(shareRateHandler));
        targetSelector(FuzzSelector({addr: address(shareRateHandler), selectors: externalSharesSelectors}));

        // @dev mint 10000 external shares to simulate some shares already minted, so
        //      burnExternalShares will be able to actually burn some shares
        vm.prank(accountingContract);
        lidoContract.mintExternalShares(accountingContract, protocolStartExternalShares);
        shareRateHandler.submit(0, 10 ether);

        vm.roll(block.number + ONE_DAY_IN_BLOCKS);
    }

    function logBoundaryValues() public view {
        ShareRateHandler.BoundaryValues memory bounds = shareRateHandler.getBoundaryValues();

        console2.log("Boundary Values:");
        console2.log("External shares recipient:", bounds.externalSharesRecipient);
        console2.log("Minted external shares:", bounds.mintedExternalShares);
        console2.log("Burned external shares:", bounds.burnExternalShares);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_totalShares() public view {
        assertEq(lidoContract.getTotalShares(), shareRateHandler.getTotalShares());

        logBoundaryValues();
    }
}
