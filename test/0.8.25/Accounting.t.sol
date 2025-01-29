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

    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256);

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
    uint256 public ghost_sharesMintAsFees;
    uint256 public ghost_transferShares;
    uint256 public ghost_totalRewards;
    uint256 public ghost_principalClBalance;
    uint256 public ghost_unifiedClBalance;

    address private accountingOracle;
    address private lidoExecutionLayerRewardVault;
    LimitsList public limitList;

    constructor(
        address _accounting,
        address _lido,
        address _accountingOracle,
        LimitsList memory _limitList,
        address _lidoExecutionLayerRewardVault
    ) {
        accounting = IAccounting(_accounting);
        lido = ILido(_lido);
        accountingOracle = _accountingOracle;
        limitList = _limitList;
        lidoExecutionLayerRewardVault = _lidoExecutionLayerRewardVault;
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

        _clValidators = bound(
            _clValidators,
            _preClValidators,
            _preClValidators + limitList.appearedValidatorsPerDayLimit
        );
        _clBalance = bound(_clBalance, _clValidators * stableBalance, _clValidators * stableBalance + 1_000);

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

        // research correlation with elRewardsVaultBalance
        vm.deal(lidoExecutionLayerRewardVault, 300 ether);

        ReportValues memory currentReport = ReportValues({
            timestamp: _timestamp,
            timeElapsed: _timeElapsed,
            clValidators: _clValidators,
            clBalance: _clBalance * 1 ether,
            withdrawalVaultBalance: 0,
            elRewardsVaultBalance: 200 ether,
            sharesRequestedToBurn: 0,
            withdrawalFinalizationBatches: new uint256[](0),
            vaultValues: new uint256[](0),
            netCashFlows: new int256[](0)
        });

        ghost_principalClBalance =
            _preClBalance *
            1 ether +
            (currentReport.clValidators - _preClValidators) *
            stableBalance *
            1 ether;
        ghost_unifiedClBalance = currentReport.clBalance + currentReport.withdrawalVaultBalance; // ?

        ghost_totalRewards = ghost_unifiedClBalance - ghost_principalClBalance + currentReport.elRewardsVaultBalance;

        vm.prank(accountingOracle);

        vm.recordLogs();
        accounting.handleOracleReport(currentReport);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        bytes32 totalSharesSignature = keccak256("Mock__MintedTotalShares(uint256)");
        bytes32 transferSharesSignature = keccak256("TransferShares(address,address,uint256)");
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == totalSharesSignature) {
                ghost_sharesMintAsFees = abi.decode(abi.encodePacked(entries[i].topics[1]), (uint256));
            }

            if (entries[i].topics[0] == transferSharesSignature) {
                ghost_transferShares = abi.decode(entries[i].data, (uint256));
            }
        }
    }
}

contract AccountingTest is BaseProtocolTest {
    AccountingHandler private accountingHandler;

    uint256 private protocolStartBalance = 1 ether;

    address private rootAccount = address(0x123);
    address private userAccount = address(0x321);

    function setUp() public {
        BaseProtocolTest.setUpProtocol(protocolStartBalance, rootAccount, userAccount);

        accountingHandler = new AccountingHandler(
            lidoLocator.accounting(),
            lidoLocator.lido(),
            lidoLocator.accountingOracle(),
            limitList,
            lidoLocator.elRewardsVault()
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
    // CLb + ELr <= 10%

    // - user tokens must not be used except burner as source (from Zero / to Zero). From burner to zerop
    // - from zero to Treasure, burner
    //
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
    function invariant_handleOracleReport() public view {
        ILido lido = ILido(lidoLocator.lido());
        (uint256 depositedValidators, uint256 clValidators, uint256 clBalance) = lido.getBeaconStat();

        assertGe(clValidators, accountingHandler.ghost_clValidators());
        assertEq(depositedValidators, accountingHandler.ghost_depositedValidators());

        if (accountingHandler.ghost_unifiedClBalance() > accountingHandler.ghost_principalClBalance()) {
            uint256 treasuryFeesETH = lido.getPooledEthByShares(accountingHandler.ghost_sharesMintAsFees()) / 1 ether;
            uint256 reportRewardsMintedETH = lido.getPooledEthByShares(accountingHandler.ghost_transferShares()) /
                1 ether;
            uint256 totalFees = treasuryFeesETH + reportRewardsMintedETH;
            uint256 totalRewards = accountingHandler.ghost_totalRewards() / 1 ether;

            if (totalRewards != 0) {
                uint256 percents = (totalFees * 100) / totalRewards;

                assertTrue(percents <= 10);
                assertTrue(percents > 0);
            }
        }
    }
}
