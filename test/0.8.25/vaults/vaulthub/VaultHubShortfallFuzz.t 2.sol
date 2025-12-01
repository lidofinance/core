// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;


import "forge-std/Test.sol";
import "forge-std/console.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {OperatorGrid, TierParams} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {IDepositContract} from "contracts/common/interfaces/IDepositContract.sol";

// OpenZeppelin contracts for proxy pattern
import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {PinnedBeaconProxy} from "contracts/0.8.25/vaults/PinnedBeaconProxy.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts-v5.2/proxy/transparent/TransparentUpgradeableProxy.sol";

// Import test harnesses and mocks
import {LazyOracle__HarnessForVaultHub} from "./contracts/LazyOracle__HarnessForVaultHub.sol";
import {VaultFactory} from "contracts/0.8.25/vaults/VaultFactory.sol";
import {VaultFactoryWrapper} from "./contracts/VaultFactoryWrapper.sol";
import {MinimalDashboard} from "./contracts/MinimalDashboard.sol";
import {
    MockStETH,
    MockLidoLocator,
    MockHashConsensus,
    MockPredepositGuarantee,
    MockDepositContract
} from "./VaultHubInvariant.t.sol";

/**
 * @title VaultHubShortfallFuzzTest
 * @notice Fuzz testing for the shortfall calculation property
 * @dev This test validates that rebalancing by healthShortfallShares() makes vaults healthy
 */
contract VaultHubShortfallFuzzTest is Test {
    // Constants
    uint256 constant TOTAL_BASIS_POINTS = 10000;
    uint256 constant CONNECT_DEPOSIT = 1 ether;
    uint256 constant INITIAL_LIDO_BALANCE = 10000 ether;
    
    // Test parameters
    uint256 constant SHARE_LIMIT = 100 ether;
    uint256 constant RESERVE_RATIO_BP = 2000; // 20%
    uint256 constant FORCED_REBALANCE_THRESHOLD_BP = 1800; // 18%
    uint256 constant INFRA_FEE_BP = 500;
    uint256 constant LIQUIDITY_FEE_BP = 400;
    uint256 constant RESERVATION_FEE_BP = 100;
    uint256 constant MAX_RELATIVE_SHARE_LIMIT_BP = 1000; // 10%

    // Core contracts
    VaultHub public vaultHub;
    OperatorGrid public operatorGrid;
    StakingVault public vault;

    // Mock Part
    MockStETH public steth;
    MockLidoLocator public locator;
    MockHashConsensus public consensus;
    LazyOracle__HarnessForVaultHub public lazyOracle;
    VaultFactoryWrapper public vaultFactory;
    MockPredepositGuarantee public pdg;
    MockDepositContract public depositContract;
    UpgradeableBeacon public vaultBeacon;
    
    // Test addresses
    address public vaultAddress;
    address public vaultOwner;
    address public nodeOperator;

    function setUp() public {
        vaultOwner = makeAddr("vaultOwner");
        nodeOperator = makeAddr("nodeOperator");
        
        vm.deal(address(this), 1000 ether);
        vm.deal(vaultOwner, 1000 ether);
        
        // Deploy mocks
        steth = new MockStETH();
        vm.deal(address(steth), INITIAL_LIDO_BALANCE);
        steth.setInitialShares(INITIAL_LIDO_BALANCE);
        steth.setShareRateBP(10000); // 1.0x rate
        
        consensus = new MockHashConsensus();
        depositContract = new MockDepositContract();
        pdg = new MockPredepositGuarantee();
        
        address treasury = makeAddr("treasury");
        
        // Deploy locator (temporarily without OperatorGrid and LazyOracle)
        locator = new MockLidoLocator(
            address(steth),
            address(pdg),
            address(0), // lazyOracle - will be set later
            address(0), // operatorGrid - will be set later
            treasury,
            address(0) // accounting
        );

        // Deploy REAL LazyOracle via harness and proxy
        LazyOracle__HarnessForVaultHub lazyOracleImpl = new LazyOracle__HarnessForVaultHub(address(locator));
        TransparentUpgradeableProxy lazyOracleProxy = new TransparentUpgradeableProxy(
            address(lazyOracleImpl),
            address(this),
            ""
        );
        lazyOracle = LazyOracle__HarnessForVaultHub(address(lazyOracleProxy));

        // Initialize with sanity params
        lazyOracle.initialize(
            address(this),           // admin
            7 days,                  // quarantine period
            1000,                    // maxRewardRatioBP (10%)
            1 ether                  // maxLidoFeeRatePerSecond
        );
        
        // Update locator with LazyOracle
        locator.setLazyOracle(address(lazyOracle));
        
        // Deploy OperatorGrid
        OperatorGrid operatorGridImpl = new OperatorGrid(ILidoLocator(address(locator)));
        TransparentUpgradeableProxy operatorGridProxy = new TransparentUpgradeableProxy(
            address(operatorGridImpl),
            address(this), // admin
            "" // no initialization data here, call initialize separately
        );
        operatorGrid = OperatorGrid(address(operatorGridProxy));
        
        TierParams memory defaultTierParams = TierParams({
            shareLimit: SHARE_LIMIT,
            reserveRatioBP: RESERVE_RATIO_BP,
            forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
            infraFeeBP: INFRA_FEE_BP,
            liquidityFeeBP: LIQUIDITY_FEE_BP,
            reservationFeeBP: RESERVATION_FEE_BP
        });
        operatorGrid.initialize(address(this), defaultTierParams);
        operatorGrid.grantRole(operatorGrid.REGISTRY_ROLE(), address(this));
        
        locator.setOperatorGrid(address(operatorGrid));
        
        // Deploy VaultHub
        VaultHub vaultHubImpl = new VaultHub(
            ILidoLocator(address(locator)),
            ILido(address(steth)),
            consensus,
            MAX_RELATIVE_SHARE_LIMIT_BP
        );
        
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(vaultHubImpl),
            address(this), // admin
            "" // no initialization data here, call initialize separately
        );
        vaultHub = VaultHub(payable(address(proxy)));
        vaultHub.initialize(address(this));
        vaultHub.grantRole(vaultHub.PAUSE_ROLE(), address(this));
        vaultHub.grantRole(vaultHub.RESUME_ROLE(), address(this));
        vaultHub.pauseFor(365 days);
        vaultHub.resume();
        
        locator.setVaultHub(address(vaultHub));
        
        // Deploy REAL StakingVault implementation and beacon FIRST (needed for factory)
        StakingVault vaultImpl = new StakingVault(address(depositContract));
        vaultBeacon = new UpgradeableBeacon(address(vaultImpl), address(this));
        
        // Deploy REAL VaultFactory, then wrap it to intercept deployedVaults() calls
        MinimalDashboard dashboardImpl = new MinimalDashboard();
        VaultFactory realFactory = new VaultFactory(
            address(locator),           // LIDO_LOCATOR
            address(vaultBeacon),       // BEACON
            address(dashboardImpl),     // DASHBOARD_IMPL
            address(0)                  // PREVIOUS_FACTORY
        );
        
        // Wrap the factory to allow test vault registration
        vaultFactory = new VaultFactoryWrapper(realFactory);
        locator.setVaultFactory(address(vaultFactory));
        
        // Deploy StakingVault
        PinnedBeaconProxy vaultProxy = new PinnedBeaconProxy(
            address(vaultBeacon),
            abi.encodeCall(StakingVault.initialize, (address(this), nodeOperator, address(pdg)))
        );
        vault = StakingVault(payable(address(vaultProxy)));
        vaultAddress = address(vault);
        
        OwnableUpgradeable(vaultAddress).transferOwnership(vaultOwner);
        vm.prank(vaultOwner);
        vault.acceptOwnership();
        
        // Register vault in factory (using test helper)
        vaultFactory.registerTestVault(vaultAddress);
        operatorGrid.registerGroup(nodeOperator, SHARE_LIMIT);
        
        TierParams[] memory tierParams = new TierParams[](1);
        tierParams[0] = defaultTierParams;
        operatorGrid.registerTiers(nodeOperator, tierParams);
        
        // Connect vault
        vm.startPrank(vaultOwner);
        vault.fund{value: CONNECT_DEPOSIT}();
        vault.pauseBeaconChainDeposits();
        vault.transferOwnership(address(vaultHub));
        vm.stopPrank();
        
        vm.prank(vaultOwner);
        vaultHub.connectVault(vaultAddress);
        
        // CREATE UNHEALTHY INITIAL STATE
        console.log("\n=== Creating Unhealthy Initial State ===");
        
        vm.prank(vaultOwner);
        vaultHub.fund{value: 50 ether}(vaultAddress);
        _applyReport();
        
        uint256 maxMintable = vaultHub.totalMintingCapacityShares(vaultAddress, 0);
        uint256 toMint = (maxMintable * 97) / 100;
        
        vm.prank(vaultOwner);
        vaultHub.mintShares(vaultAddress, vaultOwner, toMint);
        
        steth.setShareRateBP(11500); // 1.15x - makes vault unhealthy
        _applyReport();
        
        bool isUnhealthy = !vaultHub.isVaultHealthy(vaultAddress);
        console.log("Vault starts unhealthy:", isUnhealthy);
        if (isUnhealthy) {
            console.log("Shortfall:", vaultHub.healthShortfallShares(vaultAddress));
        }
    }

    /**
     * @notice MAIN FUZZ TEST: Shortfall calculation on initial unhealthy state
     * @dev The vault STARTS unhealthy. This test verifies shortfall works across many scenarios.
     * forge-config: default.fuzz.runs = 1000000
     */
    function testFuzz_shortfallOnInitialUnhealthyState(uint96 extraFunding) public {
        extraFunding = uint96(bound(extraFunding, 0, 50 ether));
        
        if (extraFunding > 0) {
            vm.prank(vaultOwner);
            vaultHub.fund{value: extraFunding}(vaultAddress);
            _applyReport();
        }
        
        bool isHealthy = vaultHub.isVaultHealthy(vaultAddress);
        if (isHealthy) return; // Extra funding made it healthy, skip
        
        uint256 shortfall = vaultHub.healthShortfallShares(vaultAddress);
        if (shortfall == type(uint256).max || shortfall == 0) return;
        
        uint256 liabilityBefore = vaultHub.liabilityShares(vaultAddress);
        require(liabilityBefore >= shortfall, "Shortfall exceeds liability");
        
        uint256 snapshot = vm.snapshot();
        _applyReport();
        
        vm.prank(vaultOwner);
        vaultHub.rebalance(vaultAddress, shortfall);
        
        bool isHealthyAfter = vaultHub.isVaultHealthy(vaultAddress);
        vm.revertTo(snapshot);
        
        assertTrue(
            isHealthyAfter,
            "SHORTFALL FAILED: Rebalancing by shortfall did not make vault healthy!"
        );
    }

    /**
     * @notice Fuzz test with varying share rates
     * forge-config: default.fuzz.runs = 1000000
     */
    function testFuzz_shortfallWithShareRateVariation(
        uint16 newShareRateBP,
        uint96 extraFunding
    ) public {
        newShareRateBP = uint16(bound(newShareRateBP, 11000, 16000)); // 1.1x to 1.3x
        extraFunding = uint96(bound(extraFunding, 0, 30 ether));
        
        // Change share rate
        steth.setShareRateBP(newShareRateBP);
        _applyReport();
        
        if (extraFunding > 0) {
            vm.prank(vaultOwner);
            vaultHub.fund{value: extraFunding}(vaultAddress);
            _applyReport();
        }
        
        bool isHealthy = vaultHub.isVaultHealthy(vaultAddress);
        if (isHealthy) return;
        
        uint256 shortfall = vaultHub.healthShortfallShares(vaultAddress);
        if (shortfall == type(uint256).max || shortfall == 0) return;
        
        uint256 liabilityBefore = vaultHub.liabilityShares(vaultAddress);
        if (liabilityBefore < shortfall) return;
        
        uint256 snapshot = vm.snapshot();
        _applyReport();
        
        vm.prank(vaultOwner);
        vaultHub.rebalance(vaultAddress, shortfall);
        
        bool isHealthyAfter = vaultHub.isVaultHealthy(vaultAddress);
        vm.revertTo(snapshot);
        
        assertTrue(isHealthyAfter, "Shortfall calculation failed with share rate variation");
    }

    function _applyReport() internal {
        lazyOracle.refreshReportTimestamp();
        uint256 timestamp = lazyOracle.getTestReportTimestamp();
        
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(vaultAddress);
        uint256 totalValue = vaultHub.totalValue(vaultAddress);
        
        uint256 activeIndex = record.inOutDelta[0].refSlot >= record.inOutDelta[1].refSlot ? 0 : 1;
        int256 inOutDelta = record.inOutDelta[activeIndex].value;
        
        vm.prank(address(lazyOracle));
        vaultHub.applyVaultReport(
            vaultAddress,
            timestamp,
            totalValue,
            inOutDelta,
            record.cumulativeLidoFees,
            record.liabilityShares,
            record.maxLiabilityShares,
            0
        );
    }
}

