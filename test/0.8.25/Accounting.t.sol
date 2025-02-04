// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {BaseProtocolTest} from "./Protocol__Deployment.t.sol";
import {LimitsList} from "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";
import {ReportValues} from "contracts/common/interfaces/ReportValues.sol";

interface IStakingRouter {
    function getRecipients() external view returns (address[] memory);
}

interface IAccounting {
    function handleOracleReport(ReportValues memory _report) external;

    function simulateOracleReport(ReportValues memory _report, uint256 _withdrawalShareRate) external;
}

interface ILido {
    function getTotalShares() external view returns (uint256);

    function getBufferedEther() external view returns (uint256);

    function getExternalShares() external view returns (uint256);

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
uint256 constant maxYieldPerOperatorWei = 2_792_000_000_000_000; // which % of slashing could be?
uint256 constant maxLossPerOperatorWei = 7_300_000_000_000_000;
uint256 constant stableBalanceWei = 32 * 1 ether;

struct FuzzValues {
    uint256 _preClValidators;
    uint256 _preClBalanceWei;
    uint256 _clValidators;
    uint256 _clBalanceWei;
    uint256 _withdrawalVaultBalance;
    uint256 _elRewardsVaultBalanceWei;
    uint256 _sharesRequestedToBurn;
    uint256 _lidoExecutionLayerRewardVaultWei;
}

struct LidoTransfer {
    address from;
    address to;
}

contract AccountingHandler is CommonBase, StdCheats, StdUtils {
    struct Ghost {
        int256 clValidators;
        int256 depositedValidators;
        int256 sharesMintAsFees;
        int256 transferShares;
        int256 totalRewardsWei;
        int256 principalClBalanceWei;
        int256 unifiedClBalanceWei;
    }

    IAccounting private accounting;
    ILido private lido;
    ISecondOpinionOracleMock private secondOpinionOracle;
    IStakingRouter public stakingRouter;

    Ghost public ghost;
    LidoTransfer[] public ghost_lidoTransfers;

    address private accountingOracle;
    address private lidoExecutionLayerRewardVault;
    address private burner;
    LimitsList public limitList;

    constructor(
        address _accounting,
        address _lido,
        address _accountingOracle,
        LimitsList memory _limitList,
        address _lidoExecutionLayerRewardVault,
        address _secondOpinionOracle,
        address _burnerAddress,
        address _stakingRouter
    ) {
        accounting = IAccounting(_accounting);
        lido = ILido(_lido);
        accountingOracle = _accountingOracle;
        limitList = _limitList;
        lidoExecutionLayerRewardVault = _lidoExecutionLayerRewardVault;

        ghost = Ghost(0, 0, 0, 0, 0, 0, 0);
        secondOpinionOracle = ISecondOpinionOracleMock(_secondOpinionOracle);
        burner = _burnerAddress;
        stakingRouter = IStakingRouter(_stakingRouter);
    }

    function cutGwei(uint256 value) public returns (uint256) {
        return (value / 1 gwei) * 1 gwei;
    }

    function handleOracleReport(FuzzValues memory fuzz) external {
        uint256 _timeElapsed = 86_400;
        uint256 _timestamp = block.timestamp + _timeElapsed;

        // cheatCode for
        // if (_report.timestamp >= block.timestamp) revert IncorrectReportTimestamp(_report.timestamp, block.timestamp);
        vm.warp(_timestamp + 1);

        fuzz._lidoExecutionLayerRewardVaultWei = bound(fuzz._lidoExecutionLayerRewardVaultWei, 0, 1_000) * 1 ether;
        fuzz._elRewardsVaultBalanceWei = bound(
            fuzz._elRewardsVaultBalanceWei,
            0,
            fuzz._lidoExecutionLayerRewardVaultWei
        );

        fuzz._preClValidators = bound(fuzz._preClValidators, 250_000, 100_000_000_000);
        fuzz._preClBalanceWei = cutGwei(fuzz._preClValidators * stableBalanceWei);

        ghost.clValidators = int256(fuzz._preClValidators);

        fuzz._clValidators = bound(
            fuzz._clValidators,
            fuzz._preClValidators,
            fuzz._preClValidators + limitList.appearedValidatorsPerDayLimit
        );

        uint256 minBalancePerValidatorWei = fuzz._clValidators * (stableBalanceWei - maxLossPerOperatorWei);
        uint256 maxBalancePerValidatorWei = fuzz._clValidators * (stableBalanceWei + maxYieldPerOperatorWei);
        fuzz._clBalanceWei = bound(fuzz._clBalanceWei, minBalancePerValidatorWei, maxBalancePerValidatorWei);

        // depositedValidators is always greater or equal to beaconValidators
        // Todo: Upper extremum ?
        uint256 depositedValidators = bound(
            fuzz._preClValidators,
            fuzz._clValidators + 1,
            fuzz._clValidators + limitList.appearedValidatorsPerDayLimit
        );
        ghost.depositedValidators = int256(depositedValidators);

        vm.store(address(lido), keccak256("lido.Lido.depositedValidators"), bytes32(depositedValidators));
        vm.store(address(lido), keccak256("lido.Lido.beaconValidators"), bytes32(fuzz._preClValidators));
        vm.store(address(lido), keccak256("lido.Lido.beaconBalance"), bytes32(fuzz._preClBalanceWei));

        vm.deal(lidoExecutionLayerRewardVault, fuzz._lidoExecutionLayerRewardVaultWei);

        ReportValues memory currentReport = ReportValues({
            timestamp: _timestamp,
            timeElapsed: _timeElapsed,
            clValidators: fuzz._clValidators,
            clBalance: (fuzz._clBalanceWei / 1e9) * 1e9,
            elRewardsVaultBalance: fuzz._elRewardsVaultBalanceWei,
            withdrawalVaultBalance: 0,
            sharesRequestedToBurn: 0,
            withdrawalFinalizationBatches: new uint256[](0),
            vaultValues: new uint256[](0),
            netCashFlows: new int256[](0)
        });

        ghost.unifiedClBalanceWei = int256(fuzz._clBalanceWei + currentReport.withdrawalVaultBalance); // ?
        ghost.principalClBalanceWei = int256(
            fuzz._preClBalanceWei + (currentReport.clValidators - fuzz._preClValidators) * stableBalanceWei
        );

        ghost.totalRewardsWei =
            ghost.unifiedClBalanceWei -
            ghost.principalClBalanceWei +
            int256(fuzz._elRewardsVaultBalanceWei);

        secondOpinionOracle.mock__setReportValues(
            true,
            fuzz._clBalanceWei / 1e9,
            currentReport.withdrawalVaultBalance,
            uint256(ghost.depositedValidators),
            0
        );

        vm.prank(accountingOracle);

        delete ghost_lidoTransfers;
        vm.recordLogs();
        accounting.handleOracleReport(currentReport);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        bytes32 totalSharesSignature = keccak256("Mock__MintedTotalShares(uint256)");
        bytes32 transferSharesSignature = keccak256("TransferShares(address,address,uint256)");
        bytes32 lidoTransferSignature = keccak256("Transfer(address,address,uint256)");

        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == totalSharesSignature) {
                ghost.sharesMintAsFees = int256(abi.decode(abi.encodePacked(entries[i].topics[1]), (uint256)));
            }

            if (entries[i].topics[0] == transferSharesSignature) {
                ghost.transferShares = int256(abi.decode(entries[i].data, (uint256)));
            }

            if (entries[i].topics[0] == lidoTransferSignature) {
                if (entries[i].emitter == address(lido)) {
                    address from = abi.decode(abi.encodePacked(entries[i].topics[1]), (address));
                    address to = abi.decode(abi.encodePacked(entries[i].topics[2]), (address));

                    ghost_lidoTransfers.push(LidoTransfer({from: from, to: to}));
                }
            }
        }
    }

    function getGhost() public view returns (Ghost memory) {
        return ghost;
    }

    function getLidoTransfers() public view returns (LidoTransfer[] memory) {
        return ghost_lidoTransfers;
    }
}

contract AccountingTest is BaseProtocolTest {
    AccountingHandler private accountingHandler;

    uint256 private protocolStartBalance = 1 ether;

    address private rootAccount = address(0x123);
    address private userAccount = address(0x321);

    mapping(address => bool) public possibleLidoRecipients;

    function setUp() public {
        BaseProtocolTest.setUpProtocol(protocolStartBalance, rootAccount, userAccount);

        accountingHandler = new AccountingHandler(
            lidoLocator.accounting(),
            lidoLocator.lido(),
            lidoLocator.accountingOracle(),
            limitList,
            lidoLocator.elRewardsVault(),
            address(secondOpinionOracleMock),
            lidoLocator.burner(),
            lidoLocator.stakingRouter()
        );

        // Set target contract to the accounting handler
        targetContract(address(accountingHandler));

        vm.prank(userAccount);
        lidoContract.resume();

        possibleLidoRecipients[lidoLocator.burner()] = true;
        possibleLidoRecipients[lidoLocator.treasury()] = true;

        for (uint256 i = 0; i < accountingHandler.stakingRouter().getRecipients().length; i++) {
            possibleLidoRecipients[accountingHandler.stakingRouter().getRecipients()[i]] = true;
        }

        // Set target selectors to the accounting handler
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = accountingHandler.handleOracleReport.selector;

        targetSelector(FuzzSelector({addr: address(accountingHandler), selectors: selectors}));
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 128
     * forge-config: default.invariant.depth = 128
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_clValidatorNotDecreased() public view {
        ILido lido = ILido(lidoLocator.lido());
        (uint256 depositedValidators, uint256 clValidators, uint256 clBalance) = lido.getBeaconStat();

        // Should not be able to decrease validator number
        assertGe(clValidators, uint256(accountingHandler.getGhost().clValidators));
        assertEq(depositedValidators, uint256(accountingHandler.getGhost().depositedValidators));
    }

    /**
     *  0 OR 10% OF PROTOCOL FEES SHOULD BE REPORTED (Collect total fees from reports in handler)
     *  CLb + ELr <= 10%
     *
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 128
     * forge-config: default.invariant.depth = 128
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_NonNegativeRebase() public view {
        ILido lido = ILido(lidoLocator.lido());

        if (accountingHandler.getGhost().unifiedClBalanceWei > accountingHandler.getGhost().principalClBalanceWei) {
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
            int256 totalRewards = accountingHandler.getGhost().totalRewardsWei;

            if (totalRewards != 0) {
                int256 percents = (totalFees * 100) / totalRewards;

                assertTrue(percents <= 10, "all distributed rewards > 10%");
                assertTrue(percents >= 0, "all distributed rewards < 0%");
            }
        } else {
            console2.log("Negative rebase. Skipping report", accountingHandler.getGhost().totalRewardsWei / 1 ether);
        }
    }

    /**
     * Lido.Transfer from (0x00, to treasure or burner. Other -> collect and check what is it)
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 128
     * forge-config: default.invariant.depth = 128
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_LidoTransfers() public view {
        LidoTransfer[] memory lidoTransfers = accountingHandler.getLidoTransfers();

        for (uint256 i = 0; i < lidoTransfers.length; i++) {
            assertEq(lidoTransfers[i].from, address(0), "Lido.Transfer sender is not zero");
            assertTrue(
                possibleLidoRecipients[lidoTransfers[i].to],
                "Lido.Transfer recipient is not possibleLidoRecipients"
            );
        }
    }

    /**
     * solvency - stETH <> ETH = 1:1 - internal and total share rates are equal
     * vault params do not affect protocol share rate
     *
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 128
     * forge-config: default.invariant.depth = 128
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_vaultsDonAffectSharesRate() public view {
        ILido lido = ILido(lidoLocator.lido());

        uint256 totalShares = lido.getTotalShares();
        uint256 totalEth = lido.getBufferedEther();
        uint256 totalShareRate = totalEth / totalShares;

        console2.log("totalShares", totalShares);
        console2.log("totalEth", totalEth);
        console2.log("totalShareRate", totalShareRate);

        (uint256 depositedValidators, uint256 clValidators, uint256 clBalance) = lido.getBeaconStat();
        // clValidators can never be less than deposited ones.
        uint256 transientEther = (depositedValidators - clValidators) * 32 ether;
        console2.log("transientEther", transientEther);

        uint256 internalEther = totalEth + clBalance + transientEther;
        console2.log("internalEther", internalEther);
        uint256 internalShares = totalShares - lido.getExternalShares();
        console2.log("internalShares", internalShares);
        console2.log("getExternalShares", lido.getExternalShares());

        uint256 internalShareRate = internalEther / internalShares;

        console2.log("internalShareRate", internalShareRate);

        assertEq(totalShareRate, internalShareRate);
    }
}
