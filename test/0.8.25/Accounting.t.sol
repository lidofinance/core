// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import "foundry/lib/forge-std/src/Vm.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {BaseProtocolTest} from "./Protocol__Deployment.t.sol";
import {LimitsList} from "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";
import {ReportValues} from "contracts/common/interfaces/ReportValues.sol";

interface IAccounting {
    function handleOracleReport(ReportValues memory _report) external;

    function simulateOracleReport(ReportValues memory _report, uint256 _withdrawalShareRate) external;
}

interface ILido {
    function getTotalShares() external view returns (uint256);

    function resume() external;

    function getBeaconStat()
        external
        view
        returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance);
}

contract AccountingHandler is CommonBase, StdCheats, StdUtils {
    IAccounting private accounting;
    ILido private lido;

    uint256 public ghost_clValidators;
    uint256 public ghost_depositedValidators;
    address private accountingOracle;
    LimitsList public limitList;

    constructor(address _accounting, address _lido, address _accountingOracle, LimitsList memory _limitList) {
        accounting = IAccounting(_accounting);
        lido = ILido(_lido);
        accountingOracle = _accountingOracle;
        ghost_clValidators = 0;
        limitList = _limitList;
    }

    function handleOracleReport(
        uint256 _preClValidators,
        uint256 _preClBalance,
        uint256 _clValidators,
        uint256 _clBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn
    ) external {
        uint256 _timeElapsed = 86_400;
        uint256 _timestamp = 1_737_366_566 + _timeElapsed;

        // cheatCode for
        // if (_report.timestamp >= block.timestamp) revert IncorrectReportTimestamp(_report.timestamp, block.timestamp);
        vm.warp(_timestamp + 1);

        // How to determinate max possible balance of validator
        //
        // APR ~ 4-6 %
        // BalVal = 32 ETH
        // after 10 years staking 32 x (1 + 0.06)^10 ~= 57.4
        // after 20 years staking 32 x (1 + 0.06)^20 ~= 114.8
        //
        // Min Balance = 16. If balVal < 16, then validator is deactivated
        // uint256 minBalance = 16;
        // uint256 maxBalance = 100;
        uint256 stableBalance = 32;

        // _withdrawalVaultBalance = bound(_withdrawalVaultBalance, 0, type(uint32).max);
        // _elRewardsVaultBalance = bound(_elRewardsVaultBalance, 0, type(uint32).max);
        // _sharesRequestedToBurn = bound(_sharesRequestedToBurn, 0, lido.getTotalShares());
        // _clValidators = Math.floor(_clValidators);

        _preClValidators = bound(_preClValidators, 250_000, type(uint32).max);
        _preClBalance = bound(_preClBalance, _preClValidators * stableBalance, _preClValidators * stableBalance);
        ghost_clValidators = _preClValidators;

        // _clValidators = bound(_clValidators, _preClValidators, _preClValidators + 900);
        _clValidators = bound(
            _clValidators,
            _preClValidators,
            _preClValidators + limitList.appearedValidatorsPerDayLimit
        );
        _clBalance = bound(_clBalance, _clValidators * stableBalance, _clValidators * stableBalance);

        // depositedValidators is always greater or equal to beaconValidators
        // Todo: Upper extremum ?
        uint256 depositedValidators = bound(
            _preClValidators,
            _clValidators,
            _clValidators + limitList.appearedValidatorsPerDayLimit
        );
        ghost_depositedValidators = depositedValidators;

        vm.store(address(lido), keccak256("lido.Lido.depositedValidators"), bytes32(depositedValidators));
        vm.store(address(lido), keccak256("lido.Lido.beaconValidators"), bytes32(_preClValidators));
        vm.store(address(lido), keccak256("lido.Lido.beaconBalance"), bytes32(_preClBalance * 1 ether));

        ReportValues memory currentReport = ReportValues({
            timestamp: _timestamp,
            timeElapsed: _timeElapsed,
            clValidators: _clValidators,
            clBalance: _clBalance * 1 ether,
            withdrawalVaultBalance: 0,
            elRewardsVaultBalance: 0,
            sharesRequestedToBurn: 0,
            withdrawalFinalizationBatches: new uint256[](0),
            vaultValues: new uint256[](0),
            netCashFlows: new int256[](0)
        });

        vm.prank(accountingOracle);
        accounting.handleOracleReport(currentReport);
    }
}

contract AccountingTest is BaseProtocolTest {
    AccountingHandler private accountingHandler;

    uint256 private protocolStartBalance = 15_000 ether;

    address private rootAccount = address(0x123);
    address private userAccount = address(0x321);

    function setUp() public {
        BaseProtocolTest.setUpProtocol(protocolStartBalance, rootAccount, userAccount);

        accountingHandler = new AccountingHandler(
            lidoLocator.accounting(),
            lidoLocator.lido(),
            lidoLocator.accountingOracle(),
            limitList
        );

        // Set target contract to the accounting handler
        targetContract(address(accountingHandler));

        vm.prank(userAccount);
        lidoContract.resume();

        // Set target selectors to the accounting handler
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = accountingHandler.handleOracleReport.selector;

        targetSelector(FuzzSelector({addr: address(accountingHandler), selectors: selectors}));
    }

    //function invariant_fuzzTotalShares() public {
    // - 0 OR 10% OF PROTOCOL FEES SHOULD BE REPORTED (Collect total fees from reports in handler)
    // - user tokens must not be used except burner contract (from Zero / to Zero)
    // - solvency - stETH <> ETH = 1:1 - internal and total share rates are equal
    // - vault params do not affect protocol share rate
    //}

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     *
     *  Should not be able to decrease validator number
     */
    function invariant_clValidators() public {
        ILido lido = ILido(lidoLocator.lido());
        (uint256 depositedValidators, uint256 clValidators, uint256 clBalance) = lido.getBeaconStat();

        assertGe(clValidators, accountingHandler.ghost_clValidators());
        assertEq(depositedValidators, accountingHandler.ghost_depositedValidators());

        // console2.log(depositedValidators);
    }
}
