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
import {console2} from "../../foundry/lib/forge-std/src/console2.sol";

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

interface ISecondOpinionOracleMock {
    function mock__setReportValues(
        bool _success,
        uint256 _clBalanceGwei,
        uint256 _withdrawalVaultBalanceWei,
        uint256 _totalDepositedValidators,
        uint256 _totalExitedValidators
    ) external;
}

// 0.002792 * 10^18
// 0.0073 * 10^18
uint256 constant maxYiedPerOperatorWei = 2_792_000_000_000_000; // which % of slashing could be?
uint256 constant maxLossPerOperatorWei = 7_300_000_000_000_000;

struct FuzzValues {
    uint256 _preClValidators;
    uint256 _preClBalanceGwei;
    uint256 _clValidators;
    uint256 _clBalanceGwei;
    uint256 _withdrawalVaultBalance;
    uint256 _elRewardsVaultBalance;
    uint256 _sharesRequestedToBurn;
    uint256 _lidoExecutionLayerRewardVault;
}

contract AccountingHandler is CommonBase, StdCheats, StdUtils {
    struct Ghost {
        int256 clValidators;
        int256 depositedValidators;
        int256 sharesMintAsFees;
        int256 transferShares;
        int256 totalRewards;
        int256 principalClBalance;
        int256 unifiedClBalance;
    }

    IAccounting private accounting;
    ILido private lido;
    ISecondOpinionOracleMock private secondOpinionOracle;

    Ghost public ghost;

    address private accountingOracle;
    address private lidoExecutionLayerRewardVault;
    LimitsList public limitList;

    constructor(
        address _accounting,
        address _lido,
        address _accountingOracle,
        LimitsList memory _limitList,
        address _lidoExecutionLayerRewardVault,
        address _secondOpinionOracle
    ) {
        accounting = IAccounting(_accounting);
        lido = ILido(_lido);
        accountingOracle = _accountingOracle;
        limitList = _limitList;
        lidoExecutionLayerRewardVault = _lidoExecutionLayerRewardVault;
        ghost = Ghost(0, 0, 0, 0, 0, 0, 0);
        secondOpinionOracle = ISecondOpinionOracleMock(_secondOpinionOracle);
    }

    function cutGwei(uint256 value) public returns (uint256) {
        return (value / 1 gwei) * 1 gwei;
    }

    function handleOracleReport(FuzzValues memory fuzz) external {
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
        uint256 stableBalanceWei = 32 * 1 ether;

        fuzz._lidoExecutionLayerRewardVault = bound(fuzz._lidoExecutionLayerRewardVault, 0, 1000);
        fuzz._elRewardsVaultBalance = bound(fuzz._elRewardsVaultBalance, 0, fuzz._lidoExecutionLayerRewardVault);

        if (fuzz._elRewardsVaultBalance < fuzz._lidoExecutionLayerRewardVault) {
            console2.log(
                "reported values less then EL",
                int256(fuzz._elRewardsVaultBalance) - int256(fuzz._lidoExecutionLayerRewardVault)
            );
        } else if (fuzz._elRewardsVaultBalance == fuzz._lidoExecutionLayerRewardVault) {
            console2.log("equal");
        }

        fuzz._preClValidators = bound(fuzz._preClValidators, 250_000, type(uint32).max);
        fuzz._preClBalanceGwei = cutGwei(fuzz._preClValidators * stableBalanceWei);

        ghost.clValidators = int256(fuzz._preClValidators);

        fuzz._clValidators = bound(
            fuzz._clValidators,
            fuzz._preClValidators,
            fuzz._preClValidators + limitList.appearedValidatorsPerDayLimit
        );

        uint256 minBalancePerValidator = fuzz._clValidators * (stableBalanceWei - maxLossPerOperatorWei);
        uint256 maxBalancePerValidator = fuzz._clValidators * (stableBalanceWei + maxYiedPerOperatorWei);
        fuzz._clBalanceGwei = cutGwei(bound(fuzz._clBalanceGwei, minBalancePerValidator, maxBalancePerValidator));

        // depositedValidators is always greater or equal to beaconValidators
        // Todo: Upper extremum ?
        uint256 depositedValidators = bound(
            fuzz._preClValidators,
            fuzz._clValidators,
            fuzz._clValidators + limitList.appearedValidatorsPerDayLimit
        );
        ghost.depositedValidators = int256(depositedValidators);

        vm.store(address(lido), keccak256("lido.Lido.depositedValidators"), bytes32(depositedValidators));
        vm.store(address(lido), keccak256("lido.Lido.beaconValidators"), bytes32(fuzz._preClValidators));
        vm.store(address(lido), keccak256("lido.Lido.beaconBalance"), bytes32(fuzz._preClBalanceGwei));

        vm.deal(lidoExecutionLayerRewardVault, fuzz._lidoExecutionLayerRewardVault * 1 ether);

        ReportValues memory currentReport = ReportValues({
            timestamp: _timestamp,
            timeElapsed: _timeElapsed,
            clValidators: fuzz._clValidators,
            clBalance: fuzz._clBalanceGwei,
            withdrawalVaultBalance: 0,
            elRewardsVaultBalance: fuzz._elRewardsVaultBalance * 1 ether,
            sharesRequestedToBurn: 0,
            withdrawalFinalizationBatches: new uint256[](0),
            vaultValues: new uint256[](0),
            netCashFlows: new int256[](0)
        });

        ghost.unifiedClBalance = int256(currentReport.clBalance + currentReport.withdrawalVaultBalance); // ?
        ghost.principalClBalance = int256(
            fuzz._preClBalanceGwei + (currentReport.clValidators - fuzz._preClValidators) * stableBalanceWei * 1 ether
        );

        ghost.totalRewards =
            ghost.unifiedClBalance -
            ghost.principalClBalance +
            int256(currentReport.elRewardsVaultBalance);

        secondOpinionOracle.mock__setReportValues(
            true,
            currentReport.clBalance / 1e9,
            currentReport.withdrawalVaultBalance,
            uint256(ghost.depositedValidators),
            0
        );

        vm.prank(accountingOracle);

        vm.recordLogs();
        accounting.handleOracleReport(currentReport);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        bytes32 totalSharesSignature = keccak256("Mock__MintedTotalShares(uint256)");
        bytes32 transferSharesSignature = keccak256("TransferShares(address,address,uint256)");
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == totalSharesSignature) {
                ghost.sharesMintAsFees = int256(abi.decode(abi.encodePacked(entries[i].topics[1]), (uint256)));
            }

            if (entries[i].topics[0] == transferSharesSignature) {
                ghost.transferShares = int256(abi.decode(entries[i].data, (uint256)));
            }
        }
    }

    function getGhost() public view returns (Ghost memory) {
        return ghost;
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
            lidoLocator.elRewardsVault(),
            address(secondOpinionOracleMock)
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
     */
    function invariant_handleOracleReport() public view {
        ILido lido = ILido(lidoLocator.lido());
        (uint256 depositedValidators, uint256 clValidators, uint256 clBalance) = lido.getBeaconStat();

        // Should not be able to decrease validator number
        assertGe(clValidators, uint256(accountingHandler.getGhost().clValidators));
        assertEq(depositedValidators, uint256(accountingHandler.getGhost().depositedValidators));

        // - 0 OR 10% OF PROTOCOL FEES SHOULD BE REPORTED (Collect total fees from reports in handler)
        // CLb + ELr <= 10%
        if (accountingHandler.getGhost().unifiedClBalance > accountingHandler.getGhost().principalClBalance) {
            if (accountingHandler.getGhost().sharesMintAsFees < 0) {
                revert("sharesMintAsFees < 0");
            }

            if (accountingHandler.getGhost().transferShares < 0) {
                revert("transferShares < 0");
            }

            int256 treasuryFeesETH = int256(
                lido.getPooledEthByShares(uint256(accountingHandler.getGhost().sharesMintAsFees))
            );
            int256 reportRewardsMintedETH = int256(
                lido.getPooledEthByShares(uint256(accountingHandler.getGhost().transferShares))
            );
            int256 totalFees = int256(treasuryFeesETH + reportRewardsMintedETH);
            int256 totalRewards = accountingHandler.getGhost().totalRewards;

            if (totalRewards != 0) {
                int256 percents = (totalFees * 100) / totalRewards;
                console2.log("percents", percents);

                assertTrue(percents <= 10, "all distributed rewards > 10%");
                assertTrue(percents > 0, "all distributed rewards < 0%");
            }
        } else {
            console2.log("Negative rebase. Skipping report", accountingHandler.getGhost().totalRewards / 1 ether);
        }
    }
}
