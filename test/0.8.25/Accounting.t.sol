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

interface ILido {
    function getTotalShares() external view returns (uint256);
}

interface IAccounting {
    function initialize(address _admin) external;

    function handleOracleReport(ReportValues memory _report) external;

    function simulateOracleReport(ReportValues memory _report, uint256 _withdrawalShareRate) external;
}

contract AccountingHandler is CommonBase, StdCheats, StdUtils {
    IAccounting private accounting;
    ILido private lido;
    ReportValues[] public reports;
    address private accountingOracle;

    constructor(address _lido, address _accounting, address _accountingOracle, ReportValues memory _refReport) {
        lido = ILido(_lido);
        accounting = IAccounting(_accounting);
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

        _sharesRequestedToBurn = bound(_sharesRequestedToBurn, 0, lido.getTotalShares());

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
        accounting.handleOracleReport(currentReport);

        reports.push(currentReport);
    }
}

contract AccountingTest is BaseProtocolTest {
    AccountingHandler private accountingHandler;

    uint256 private protocolStartBalance = 15_000 ether;

    address private rootAccount = address(0x123);
    address private userAccount = address(0x321);

    address private depositContract = address(0x4242424242424242424242424242424242424242);
    function setUp() public {
        BaseProtocolTest.setUpProtocol(protocolStartBalance, rootAccount, userAccount);

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

        // Add accounting contract with handler to the protocol
        address accountingImpl = deployCode(
            "Accounting.sol:Accounting",
            abi.encode([address(lidoLocator), lidoLocator.lido()])
        );
        accountingHandler = new AccountingHandler(
            address(lidoContract),
            accountingImpl,
            lidoLocator.accountingOracle(),
            refReport
        );

        deployCodeTo(
            "AccountingOracle.sol:AccountingOracle",
            abi.encode(
                address(lidoLocator),
                lidoLocator.legacyOracle(),
                12, // secondsPerSlot
                1695902400 // genesisTime
            ),
            lidoLocator.accountingOracle()
        );

        deployCodeTo(
            "OssifiableProxy.sol:OssifiableProxy",
            abi.encode(accountingHandler, rootAccount, new bytes(0)),
            lidoLocator.accounting()
        );

        // Add burner contract to the protocol
        deployCodeTo(
            "Burner.sol:Burner",
            abi.encode(rootAccount, address(lidoLocator), lidoLocator.lido(), 0, 0),
            lidoLocator.burner()
        );

        // Add staking router contract to the protocol
        deployCodeTo("StakingRouter.sol:StakingRouter", abi.encode(depositContract), lidoLocator.stakingRouter());

        // Add oracle report sanity checker contract to the protocol
        deployCodeTo(
            "OracleReportSanityChecker.sol:OracleReportSanityChecker",
            abi.encode(address(lidoLocator), rootAccount, [1500, 1500, 1000, 2000, 8, 24, 128, 5000000, 1000, 101, 50]),
            lidoLocator.oracleReportSanityChecker()
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
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_fuzzTotalShares() public {
        assertEq(accountingHandler.length(), 1); // TODO: add real invariant, this is just a placeholder
    }
}
