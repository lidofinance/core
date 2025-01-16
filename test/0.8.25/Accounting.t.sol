// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import "../../contracts/common/interfaces/ReportValues.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";

import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "../../foundry/lib/forge-std/src/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

contract AccountingMock {
    function handleOracleReport(ReportValues memory _report) external {
        /*timestamp = _timestamp;
        timeElapsed = _timeElapsed;
        clValidators = _clValidators;
        clBalance = _clValidators * 32 ether;

        withdrawalVaultBalance = _withdrawalVaultBalance;
        elRewardsVaultBalance = _elRewardsVaultBalance;
        elRewardsVaultBalance = _elRewardsVaultBalance;
        sharesRequestedToBurn = _sharesRequestedToBurn;

        withdrawalFinalizationBatches = _withdrawalFinalizationBatches;
        vaultValues = _vaultValues;
        netCashFlows = _netCashFlows;*/
    }

    function check() public pure returns (bool) {
        return true;
    }
}

contract AccountingHandler is CommonBase, StdCheats, StdUtils {
    AccountingMock private accounting;
    ReportValues[] public reports;

    constructor(AccountingMock _accounting, ReportValues memory _refReport) {
        accounting = _accounting;
        reports.push(_refReport);
    }

    function length() public view returns (uint256) {
        return reports.length;
    }

    function handleOracleReport(
        uint256 _clValidators,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        // TODO When adding lido.accounting contract - to use this limitation
        // sharesRequestedToBurn - [0, lido.getTotalShares()]
        uint256 _sharesRequestedToBurn
    ) external {
        ReportValues memory lastReport = reports[reports.length - 1];

        uint256 _timeElapsed = 86_400;
        uint256 _timestamp = lastReport.timestamp + _timeElapsed;

        _clValidators = bound(_clValidators, lastReport.clValidators, type(uint32).max);
        _withdrawalVaultBalance = bound(_withdrawalVaultBalance, 0, type(uint32).max);
        _elRewardsVaultBalance = bound(_elRewardsVaultBalance, 0, type(uint32).max);
        // _clValidators = Math.floor(_clValidators);
        uint256 clBalance = _clValidators * 32 ether;

        ReportValues memory currentReport = ReportValues({
            timestamp: _timestamp,
            timeElapsed: _timeElapsed,
            clValidators: _clValidators,
            clBalance: clBalance,
            withdrawalVaultBalance: _withdrawalVaultBalance,
            elRewardsVaultBalance: _elRewardsVaultBalance,
            sharesRequestedToBurn: _sharesRequestedToBurn,
            withdrawalFinalizationBatches: new uint256[](0),
            vaultValues: new uint256[](0),
            netCashFlows: new int256[](0)
        });

        accounting.handleOracleReport(currentReport);

        reports.push(currentReport);
    }
}

contract AccountingTest is Test {
    AccountingMock private accounting;
    AccountingHandler private accountingHlr;

    function setUp() public {
        ReportValues memory refReport = ReportValues({
            timestamp: 1705312150,
            timeElapsed: 0,
            clValidators: 0,
            clBalance: 0,
            withdrawalVaultBalance: 0,
            elRewardsVaultBalance: 0,
            sharesRequestedToBurn: 0,
            withdrawalFinalizationBatches: new uint256[](0),
            vaultValues: new uint256[](0),
            netCashFlows: new int256[](0)
        });

        accounting = new AccountingMock();
        accountingHlr = new AccountingHandler(accounting, refReport);

        targetContract(address(accountingHlr));

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = accountingHlr.handleOracleReport.selector;

        targetSelector(FuzzSelector({addr: address(accountingHlr), selectors: selectors}));
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_fuzzTotalShares() public {
        assertEq(accounting.check(), true);
        console2.log("Reports count:", accountingHlr.length());
    }
}
