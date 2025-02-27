// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import "contracts/0.8.9/EIP712StETH.sol";

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {StorageSlot} from "@openzeppelin/contracts-v4.4/utils/StorageSlot.sol";

import {LidoLocator} from "contracts/0.8.9/LidoLocator.sol";

import {BaseProtocolTest, WithdrawalQueue, ILido} from "./Protocol__Deployment.t.sol";

uint256 constant ONE_DAY_IN_BLOCKS = 7_200;

contract ShareRateHandler is CommonBase, StdCheats, StdUtils {
    struct BoundaryValues {
        address externalSharesRecipient;
        uint256 mintedExternalShares;
        uint256 burnExternalShares;
        address transferRecipient;
        uint256 transferAmount;
    }

    ILido public lidoContract;
    WithdrawalQueue public wqContract;
    address public accounting;
    address public userAccount;

    BoundaryValues public boundaryValues;

    uint256 public maxAmountOfShares;

    mapping(address => uint256) public balances;
    uint256[] public amountsQW;

    constructor(
        ILido _lido,
        WithdrawalQueue _wqContract,
        address _accounting,
        address _userAccount,
        uint256 _maxAmountOfShares
    ) {
        lidoContract = _lido;
        accounting = _accounting;
        userAccount = _userAccount;
        maxAmountOfShares = _maxAmountOfShares;
        wqContract = _wqContract;

        // Initialize boundary values with extreme values
        boundaryValues = BoundaryValues({
            externalSharesRecipient: makeAddr("randomRecipient"),
            mintedExternalShares: 0,
            burnExternalShares: 0,
            transferRecipient: makeAddr("randomTransferRecipient"),
            transferAmount: 0
        });
    }

    function mintExternalShares(address _recipient, uint256 _amountOfShares) external {
        // we don't want to test the zero address case, as it would revert
        vm.assume(_recipient != address(0));

        _amountOfShares = bound(_amountOfShares, 1, maxAmountOfShares);
        // TODO: We need to make this condition work
        // _amountOfShares = bound(_amountOfShares, 1, _amountOfShares);

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

    function submit(address _sender, uint256 _amountETH) external payable returns (bool) {
        if (_sender == address(0) || _amountETH == 0) {
            return false;
        }

        if (_amountETH > 1000 ether || _amountETH == 0) {
            _amountETH = bound(_amountETH, 1, 1000 ether);
        }

        balances[_sender] += _amountETH;
        vm.deal(_sender, _amountETH);

        vm.prank(_sender);
        lidoContract.submit{value: _amountETH}(address(0));
        vm.roll(block.number + ONE_DAY_IN_BLOCKS);
        return true;
    }

    function transfer(address _sender, address _recipient, uint256 _amountTokens) external payable returns (bool) {
        if (
            _recipient == address(0) ||
            _sender == address(0) ||
            _amountTokens == 0 ||
            _sender == _recipient ||
            _recipient == address(lidoContract)
        ) {
            return false;
        }

        _amountTokens = bound(_amountTokens, 1, 1000 ether);
        if (balances[_sender] == 0) {
            console2.log("checking_sender_balance");
            vm.prank(_sender);
            this.submit(_sender, _amountTokens);
        } else {
            console2.log("else:", balances[_sender]);
            console2.log("else:", _sender.balance);
        }

        console2.log("sender_balance", _sender.balance);

        _amountTokens = bound(_amountTokens, 1, balances[_sender]);
        vm.prank(_sender);
        lidoContract.transfer(_recipient, _amountTokens);
        balances[_sender] -= _amountTokens;

        vm.roll(block.number + ONE_DAY_IN_BLOCKS);

        return true;
    }

    function withdrawStEth(address _owner, uint256 _amountTokens) external payable returns (bool) {
        if (_owner == address(0) || _amountTokens == 0 || balances[_owner] == 0) {
            return false;
        }

        _amountTokens = bound(_amountTokens, 1, balances[_owner]);
        vm.prank(_owner);

        amountsQW.push(_amountTokens);
        wqContract.requestWithdrawals(amountsQW, _owner);
        amountsQW.pop();

        return true;
    }

    function getBoundaryValues() public view returns (BoundaryValues memory) {
        return boundaryValues;
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

        shareRateHandler = new ShareRateHandler(lidoContract, wq, accountingContract, userAccount, _maxAmountOfShares);

        bytes4[] memory externalSharesSelectors = new bytes4[](3);
        // externalSharesSelectors[0] = shareRateHandler.mintExternalShares.selector;
        // externalSharesSelectors[1] = shareRateHandler.burnExternalShares.selector;
        externalSharesSelectors[0] = shareRateHandler.submit.selector;
        externalSharesSelectors[1] = shareRateHandler.transfer.selector;
        externalSharesSelectors[2] = shareRateHandler.withdrawStEth.selector;

        // TODO: submit - lido
        // TODO: transfers - steth

        // TODO: withdrawals request - requestWithdrawals - withdrawal queue
        // TODO: claim - requestWithdrawals - withdrawal queue

        targetContract(address(shareRateHandler));
        targetSelector(FuzzSelector({addr: address(shareRateHandler), selectors: externalSharesSelectors}));

        // bytes4[] memory actionsSelectors = new bytes4[](1);
        // externalSharesSelectors[0] = shareRateHandler.transfer.selector;
        // externalSharesSelectors[0] = shareRateHandler.submit.selector;

        // targetSelector(FuzzSelector({addr: address(shareRateHandler), selectors: actionsSelectors}));

        // @dev mint 10000 external shares to simulate some shares already minted, so
        //      burnExternalShares will be able to actually burn some shares
        vm.prank(accountingContract);
        lidoContract.mintExternalShares(accountingContract, protocolStartExternalShares);
        shareRateHandler.submit(makeAddr("randomAdr"), 10 ether);

        vm.roll(block.number + ONE_DAY_IN_BLOCKS);
    }

    function logBoundaryValues() internal view {
        ShareRateHandler.BoundaryValues memory bounds = shareRateHandler.getBoundaryValues();

        console2.log("Boundary Values:");
        console2.log("External shares recipient:", bounds.externalSharesRecipient);
        console2.log("Minted external shares:", bounds.mintedExternalShares);
        console2.log("Burned external shares:", bounds.burnExternalShares);
        console2.log("transfer recipient:", bounds.transferRecipient);
        console2.log("transfer amount:", bounds.transferAmount);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     *
     * TODO: Maybe add an invariant that lido.getExternalShares = startExternalBalance + mintedExternal - burnedExternal?
     * So we'll know it something is odd inside a math for external shares?
     */
    function invariant_totalShares() public view {
        assertEq(lidoContract.getTotalShares(), shareRateHandler.getTotalShares());
        // assertEq(true, true);

        // logBoundaryValues();
    }
}
