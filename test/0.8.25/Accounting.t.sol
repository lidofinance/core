// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {ReportValues} from "contracts/common/interfaces/ReportValues.sol";

import {BaseProtocolTest} from "./Protocol__Deployment.t.sol";
import {console2} from "../../foundry/lib/forge-std/src/console2.sol";

interface IAccounting {
    function handleOracleReport(ReportValues memory _report) external;

    function simulateOracleReport(ReportValues memory _report, uint256 _withdrawalShareRate) external;
}

interface ILido {
    function getTotalShares() external view returns (uint256);
}

contract AccountingHandler is CommonBase, StdCheats, StdUtils {
    IAccounting private accounting;
    ILido private lido;

    ReportValues[] public reports;
    address private accountingOracle;

    constructor(address _accounting, address _lido, address _accountingOracle, ReportValues memory _refReport) {
        accounting = IAccounting(_accounting);
        lido = ILido(_lido);
        reports.push(_refReport);
        accountingOracle = _accountingOracle;
    }

    function length() public view returns (uint256) {
        return reports.length;
    }

    function handleOracleReport(
        uint256 _clValidators,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn
    ) external {
        ReportValues memory lastReport = reports[reports.length - 1];

        uint256 _timeElapsed = 86_400;
        uint256 _timestamp = lastReport.timestamp + _timeElapsed;

        // cheatCode for
        // if (_report.timestamp >= block.timestamp) revert IncorrectReportTimestamp(_report.timestamp, block.timestamp);
        vm.warp(_timestamp + 1);

        _clValidators = bound(_clValidators, lastReport.clValidators, type(uint32).max);
        _withdrawalVaultBalance = bound(_withdrawalVaultBalance, 0, type(uint32).max);
        _elRewardsVaultBalance = bound(_elRewardsVaultBalance, 0, type(uint32).max);
        _sharesRequestedToBurn = bound(_sharesRequestedToBurn, 0, lido.getTotalShares());
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

        vm.prank(accountingOracle);
        try accounting.handleOracleReport(currentReport) {
            reports.push(currentReport);
        } catch {
            console2.log("Could not store report");
        }
    }
}

contract AccountingTest is BaseProtocolTest {
    AccountingHandler private accountingHandler;

    uint256 private protocolStartBalance = 15_000 ether;

    address private rootAccount = address(0x123);
    address private userAccount = address(0x321);

    function setUp() public {
        BaseProtocolTest.setUpProtocol(protocolStartBalance, rootAccount, userAccount);

        ReportValues memory refReport = ReportValues({
            timestamp: genesisTimestamp,
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

        accountingHandler = new AccountingHandler(
            lidoLocator.accounting(),
            lidoLocator.lido(),
            lidoLocator.accountingOracle(),
            refReport
        );

        // Set target contract to the accounting handler
        targetContract(address(accountingHandler));

        // Set target selectors to the accounting handler
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = accountingHandler.handleOracleReport.selector;

        targetSelector(FuzzSelector({addr: address(accountingHandler), selectors: selectors}));
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 2
     * forge-config: default.invariant.depth = 2
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_fuzzTotalShares() public {
        assertGt(accountingHandler.length(), 0); // TODO: add real invariant, this is just a placeholder
    }
}
