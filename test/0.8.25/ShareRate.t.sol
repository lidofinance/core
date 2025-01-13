// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import "contracts/0.8.9/EIP712StETH.sol";

import {CommonBase} from "forge-std/Base.sol";
import {LidoLocator} from "contracts/0.8.9/LidoLocator.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {BaseProtocolTest, ILido} from "./Protocol__Deployment.t.sol";

contract ShareRateHandler is CommonBase, StdCheats, StdUtils {
    ILido public lidoContract;
    address public accounting;
    address public userAccount;

    uint256 public maxAmountOfShares;

    constructor(ILido _lido, address _accounting, address _userAccount, uint256 _maxAmountOfShares) {
        lidoContract = _lido;
        accounting = _accounting;
        userAccount = _userAccount;
        maxAmountOfShares = _maxAmountOfShares;
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
        lidoContract.burnExternalShares(_amountOfShares);
    }

    function getTotalShares() external view returns (uint256) {
        return lidoContract.getTotalShares();
    }
}

contract ShareRateTest is BaseProtocolTest {
    ShareRateHandler public shareRateHandler;

    uint256 private _maxExternalRatioBP = 10_000;
    uint256 private _maxStakeLimit = 15_000 ether;
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

        shareRateHandler = new ShareRateHandler(lidoContract, accountingContract, userAccount, _maxAmountOfShares);
        targetContract(address(shareRateHandler));

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = shareRateHandler.mintExternalShares.selector;
        selectors[1] = shareRateHandler.burnExternalShares.selector;

        targetSelector(FuzzSelector({addr: address(shareRateHandler), selectors: selectors}));

        // @dev mint 10000 external shares to simulate some shares already minted, so
        //      burnExternalShares will be able to actually burn some shares
        vm.prank(accountingContract);
        lidoContract.mintExternalShares(accountingContract, protocolStartExternalShares);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_totalShares() public {
        assertEq(lidoContract.getTotalShares(), shareRateHandler.getTotalShares());
    }
}
