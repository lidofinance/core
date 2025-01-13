// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import "contracts/0.8.9/EIP712StETH.sol";
import "forge-std/Test.sol";

import {CommonBase} from "forge-std/Base.sol";
import {LidoLocator} from "contracts/0.8.9/LidoLocator.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {Protocol__Deployment, ILido} from "./Protocol__Deployment.t.sol";

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
        _amountOfShares = bound(_amountOfShares, 1, maxAmountOfShares);

        vm.startPrank(userAccount);
        lidoContract.resumeStaking();
        vm.stopPrank();

        vm.startPrank(accounting);
        lidoContract.mintExternalShares(_recipient, _amountOfShares);
        vm.stopPrank();
    }

    function burnExternalShares(uint256 _amountOfShares) external {
        _amountOfShares = bound(_amountOfShares, 1, maxAmountOfShares);
        vm.startPrank(userAccount);
        lidoContract.resumeStaking();
        vm.stopPrank();

        vm.startPrank(accounting);
        lidoContract.burnExternalShares(_amountOfShares);
        vm.stopPrank();
    }

    function getTotalShares() external view returns (uint256) {
        return lidoContract.getTotalShares();
    }
}

contract ShareRate is Protocol__Deployment {
    ShareRateHandler public shareRateHandler;

    uint256 private _maxExternalRatioBP = 10_000;
    uint256 private _maxStakeLimit = 15_000 ether;
    uint256 private _stakeLimitIncreasePerBlock = 20 ether;
    uint256 private _maxAmountOfShares = 100;
    uint256 private protocolStartBalance = 15_000 ether;

    address private rootAccount = address(0x123);
    address private userAccount = address(0x321);

    function setUp() public {
        Protocol__Deployment.prepareLidoContract(
            protocolStartBalance,
            rootAccount,
            userAccount
        );

        vm.startPrank(userAccount);
        lidoContract.setMaxExternalRatioBP(_maxExternalRatioBP);
        lidoContract.setStakingLimit(_maxStakeLimit, _stakeLimitIncreasePerBlock);
        lidoContract.resume();
        vm.stopPrank();

        shareRateHandler = new ShareRateHandler(lidoContract, lidoLocator.accounting(), userAccount, _maxAmountOfShares);
        targetContract(address(shareRateHandler));

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = shareRateHandler.mintExternalShares.selector;
        selectors[1] = shareRateHandler.burnExternalShares.selector;

        targetSelector(
            FuzzSelector({addr: address(shareRateHandler), selectors: selectors})
        );
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 32
     * forge-config: default.invariant.depth = 16
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_totalShares() public {
        assertEq(lidoContract.getTotalShares(), shareRateHandler.getTotalShares());
    }
}
