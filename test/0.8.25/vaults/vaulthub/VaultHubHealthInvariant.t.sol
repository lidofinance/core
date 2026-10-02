// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

/*
 * ╠══════════════════════════════════════════════════════════════════════════════════════════╣
 * ║  HOW TO RUN:                                                                             ║
 * ║  1. Run the full invariant test campaign:                                                ║
 * ║     forge test --match-contract VaultHubHealthInvariantTest -vvv                         ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 */

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {OperatorGrid, TierParams} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";

// OpenZeppelin contracts for proxy pattern
import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {PinnedBeaconProxy} from "contracts/0.8.25/vaults/PinnedBeaconProxy.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {
    TransparentUpgradeableProxy
} from "@openzeppelin/contracts-v5.2/proxy/transparent/TransparentUpgradeableProxy.sol";

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

contract VaultHubHealthInvariantTest is Test {
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

    // Core contracts - REAL
    VaultHub public vaultHub;
    OperatorGrid public operatorGrid;
    StakingVault public vault;

    // Core contracts - MOCKED (external dependencies)
    MockStETH public steth;
    MockLidoLocator public locator;
    MockHashConsensus public consensus;
    LazyOracle__HarnessForVaultHub public lazyOracle;
    VaultFactoryWrapper public vaultFactory;
    MockPredepositGuarantee public pdg;
    MockDepositContract public depositContract;

    // Beacon and proxy infrastructure for StakingVault
    UpgradeableBeacon public vaultBeacon;

    // Test addresses
    address public vaultAddress;
    address public vaultOwner;
    address public nodeOperator;

    // Handler for invariant testing
    HealthHandler public handler;

    // Track if vault was healthy before the last operation
    bool public wasHealthyBefore;

    // Track if last operation was settleLidoFees (excluded from invariant per spec)
    bool public lastOpWasSettleFees;

    // Ghost variables to track statistics across ALL invariant runs
    uint256 public ghost_fundCallCount;
    uint256 public ghost_mintCallCount;
    uint256 public ghost_withdrawCallCount;
    uint256 public ghost_rebalanceCallCount;
    uint256 public ghost_forceRebalanceCallCount;
    uint256 public ghost_burnSharesCallCount;
    uint256 public ghost_transferAndBurnCallCount;
    uint256 public ghost_updateConnectionCallCount;
    uint256 public ghost_pauseResumeCallCount;
    uint256 public ghost_setLiabilityTargetCallCount;
    uint256 public ghost_triggerWithdrawalsCallCount;
    uint256 public ghost_settleLidoFeesCallCount;

    function setUp() public {
        vaultOwner = makeAddr("vaultOwner");
        nodeOperator = makeAddr("nodeOperator");

        // Give test contract and vault owner enough ETH for testing
        vm.deal(address(this), 1000 ether);
        vm.deal(vaultOwner, 1000 ether);

        // Deploy mock dependencies
        steth = new MockStETH();
        vm.deal(address(steth), INITIAL_LIDO_BALANCE);

        // Initialize with realistic total shares to simulate a mature protocol
        steth.setInitialShares(INITIAL_LIDO_BALANCE);

        // Set a realistic share rate (1.15x - simulates accumulated staking rewards)
        steth.setShareRateBP(11500); // 1.15x rate

        consensus = new MockHashConsensus();
        depositContract = new MockDepositContract();
        pdg = new MockPredepositGuarantee();

        // Create a treasury address for fee settlements
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
            address(this), // admin
            7 days, // quarantine period
            1000, // maxRewardRatioBP (10%)
            1 ether // maxLidoFeeRatePerSecond
        );

        // Update locator with LazyOracle
        locator.setLazyOracle(address(lazyOracle));

        // Deploy REAL OperatorGrid via proxy
        OperatorGrid operatorGridImpl = new OperatorGrid(ILidoLocator(address(locator)));
        TransparentUpgradeableProxy operatorGridProxy = new TransparentUpgradeableProxy(
            address(operatorGridImpl),
            address(this), // admin
            "" // no initialization data here, call initialize separately
        );
        operatorGrid = OperatorGrid(address(operatorGridProxy));

        // Initialize OperatorGrid with default tier params
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

        // Update locator with OperatorGrid
        locator.setOperatorGrid(address(operatorGrid));

        // Deploy VaultHub implementation
        VaultHub vaultHubImpl = new VaultHub(
            ILidoLocator(address(locator)),
            ILido(address(steth)),
            consensus,
            MAX_RELATIVE_SHARE_LIMIT_BP
        );

        // Deploy proxy and initialize through it
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(vaultHubImpl),
            address(this), // admin
            "" // no initialization data here, call initialize separately
        );
        vaultHub = VaultHub(payable(address(proxy)));

        // Initialize VaultHub
        vaultHub.initialize(address(this));

        // Grant pause/resume roles
        vaultHub.grantRole(vaultHub.PAUSE_ROLE(), address(this));
        vaultHub.grantRole(vaultHub.RESUME_ROLE(), address(this));

        // Proxy storage doesn't inherit the paused state from implementation constructor
        // We need to pause first, then resume to get to the correct state
        vaultHub.pauseFor(365 days);
        vaultHub.resume();

        // Update locator with VaultHub address
        locator.setVaultHub(address(vaultHub));

        // Deploy REAL StakingVault implementation and beacon FIRST (needed for factory)
        StakingVault vaultImpl = new StakingVault(address(depositContract));
        vaultBeacon = new UpgradeableBeacon(address(vaultImpl), address(this));

        // Deploy REAL VaultFactory, then wrap it to intercept deployedVaults() calls
        MinimalDashboard dashboardImpl = new MinimalDashboard();
        VaultFactory realFactory = new VaultFactory(
            address(locator), // LIDO_LOCATOR
            address(vaultBeacon), // BEACON
            address(dashboardImpl), // DASHBOARD_IMPL
            address(0) // PREVIOUS_FACTORY
        );

        // Wrap the factory to allow test vault registration
        vaultFactory = new VaultFactoryWrapper(realFactory);
        locator.setVaultFactory(address(vaultFactory));

        // Create vault through pinned beacon proxy
        PinnedBeaconProxy vaultProxy = new PinnedBeaconProxy(
            address(vaultBeacon),
            abi.encodeCall(StakingVault.initialize, (address(this), nodeOperator, address(pdg)))
        );
        vault = StakingVault(payable(address(vaultProxy)));
        vaultAddress = address(vault);

        // Transfer ownership to vaultOwner
        OwnableUpgradeable(vaultAddress).transferOwnership(vaultOwner);
        vm.prank(vaultOwner);
        vault.acceptOwnership();

        // Register vault in factory (using test helper)
        vaultFactory.registerTestVault(vaultAddress);

        // Register node operator group
        operatorGrid.registerGroup(nodeOperator, SHARE_LIMIT);

        // Register tiers for the node operator (tier IDs start from 1, not 0)
        TierParams[] memory tierParams = new TierParams[](1);
        tierParams[0] = TierParams({
            shareLimit: SHARE_LIMIT,
            reserveRatioBP: RESERVE_RATIO_BP,
            forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
            infraFeeBP: INFRA_FEE_BP,
            liquidityFeeBP: LIQUIDITY_FEE_BP,
            reservationFeeBP: RESERVATION_FEE_BP
        });
        operatorGrid.registerTiers(nodeOperator, tierParams);

        // Connect vault
        vm.startPrank(vaultOwner);
        // Fund vault with initial balance
        vault.fund{value: CONNECT_DEPOSIT}();
        vault.pauseBeaconChainDeposits(); // Vault should start with deposits paused
        vault.transferOwnership(address(vaultHub));
        vm.stopPrank();

        vm.prank(vaultOwner);
        vaultHub.connectVault(vaultAddress);

        // Fund vault to ensure it starts healthy
        vm.prank(vaultOwner);
        vaultHub.fund{value: 50 ether}(vaultAddress);
        _applyReport();

        // Vault should start healthy
        wasHealthyBefore = vaultHub.isVaultHealthy(vaultAddress);
        require(wasHealthyBefore, "Vault must start healthy");
        lastOpWasSettleFees = false;

        // Deploy handler for invariant testing
        handler = new HealthHandler(
            vaultHub,
            steth,
            lazyOracle,
            operatorGrid,
            vaultAddress,
            vaultOwner,
            nodeOperator,
            this
        );

        // Give handler ETH for operations
        vm.deal(address(handler), 1000 ether);

        // Grant handler the REDEMPTION_MASTER_ROLE so it can set liability targets
        vaultHub.grantRole(vaultHub.REDEMPTION_MASTER_ROLE(), address(handler));

        // Setup handler as target for invariant testing
        targetContract(address(handler));
    }

    /// ===== INVARIANT TESTS =====

    /**
     * @notice INVARIANT: A healthy vault remains healthy until a new report is produced
     * @dev This is the core property from the Certora spec (VaultHub_health.spec line 81-181)
     *
     * Property: For any vault state where:
     * - isVaultHealthy(vault) == true (before call)
     * - Method is NOT applyVaultReport or settleLidoFees
     * Then: isVaultHealthy(vault) == true (after call)
     *
     * forge-config: default.invariant.runs = 20000
     * forge-config: default.invariant.depth = 200
     * forge-config: default.invariant.fail-on-revert = false
     */
    function invariant_healthyVaultRemainsHealthy() public {
        // Get current vault health status (AFTER the handler operation)
        bool isHealthyNow = vaultHub.isVaultHealthy(vaultAddress);

        // The invariant: If vault WAS healthy before, it MUST be healthy now
        // EXCEPTION: settleLidoFees is explicitly excluded per spec comment:
        // "with the exception of settling fees"
        if (wasHealthyBefore && !lastOpWasSettleFees) {
            assertTrue(isHealthyNow, "INVARIANT VIOLATED: Healthy vault became unhealthy after operation!");
        }

        // Update the "before" state for the next invariant check
        wasHealthyBefore = isHealthyNow;
        // Reset the settleLidoFees flag (will be set by handler if needed)
        lastOpWasSettleFees = false;
    }

    /**
     * @notice Called after each invariant run - log statistics
     */
    function afterInvariant() external view {
        console.log("\n=== INVARIANT RUN STATISTICS ===");
        console.log("\n--- OPERATIONS THAT PRESERVE HEALTH ---");
        console.log("Fund calls:", ghost_fundCallCount);
        console.log("Mint calls:", ghost_mintCallCount);
        console.log("Withdraw calls:", ghost_withdrawCallCount);
        console.log("Rebalance calls:", ghost_rebalanceCallCount);
        console.log("Force rebalance calls:", ghost_forceRebalanceCallCount);
        console.log("Burn shares calls:", ghost_burnSharesCallCount);
        console.log("Transfer and burn calls:", ghost_transferAndBurnCallCount);
        console.log("Update connection calls:", ghost_updateConnectionCallCount);
        console.log("Pause/resume calls:", ghost_pauseResumeCallCount);
        console.log("Set liability target calls:", ghost_setLiabilityTargetCallCount);
        console.log("Trigger withdrawals calls:", ghost_triggerWithdrawalsCallCount);
        console.log("Settle Lido fees calls:", ghost_settleLidoFeesCallCount);

        // Check if vault is healthy
        bool isHealthy = vaultHub.isVaultHealthy(vaultAddress);
        console.log("\n--- FINAL STATE ---");
        console.log("Vault healthy at end:", isHealthy);

        if (!isHealthy) {
            console.log("!!! WARNING: Vault became UNHEALTHY during testing !!!");
            console.log("!!! This violates the invariant if it wasn't due to applyVaultReport or settleLidoFees !!!");
        }
    }

    /**
     * @notice FUZZ TEST: Healthy vault remains healthy after operations
     * @dev Tests the invariant with fuzzing
     * forge-config: default.fuzz.runs = 200000
     */
    function testFuzz_healthyVaultRemainsHealthy(uint96 operationType, uint96 param1, uint96 param2) public {
        // Ensure vault starts healthy
        vm.assume(vaultHub.isVaultHealthy(vaultAddress));

        // Bound operation type to available operations
        operationType = uint96(bound(operationType, 0, 10));

        // Take snapshot
        uint256 snapshot = vm.snapshot();

        // Execute operation based on type
        bool shouldRemainHealthy = true;

        if (operationType == 0) {
            // fund
            param1 = uint96(bound(param1, 1 ether, 50 ether));
            vm.prank(vaultOwner);
            vaultHub.fund{value: param1}(vaultAddress);
            _applyReport();
        } else if (operationType == 1) {
            // mintShares
            uint256 maxMintable = vaultHub.totalMintingCapacityShares(vaultAddress, 0);
            param1 = uint96(bound(param1, 0.1 ether, maxMintable));
            if (param1 > 0) {
                vm.prank(vaultOwner);
                try vaultHub.mintShares(vaultAddress, vaultOwner, param1) {
                    // Success
                } catch {
                    shouldRemainHealthy = false; // If mint fails, skip check
                }
            }
        } else if (operationType == 2) {
            // withdraw
            uint256 withdrawable = vaultHub.withdrawableValue(vaultAddress);
            if (withdrawable > 0) {
                param1 = uint96(bound(param1, 1, withdrawable));
                vm.prank(vaultOwner);
                try vaultHub.withdraw(vaultAddress, vaultOwner, param1) {
                    _applyReport();
                } catch {
                    shouldRemainHealthy = false;
                }
            }
        } else if (operationType == 3) {
            // rebalance (with rounding prevention)
            uint256 liability = vaultHub.liabilityShares(vaultAddress);
            if (liability > 0 && _canRebalanceSafely()) {
                param1 = uint96(bound(param1, 1, liability / 2));
                _applyReport();
                vm.prank(vaultOwner);
                try vaultHub.rebalance(vaultAddress, param1) {
                    // Success
                } catch {
                    shouldRemainHealthy = false;
                }
            }
        } else if (operationType == 4) {
            // forceRebalance (with rounding prevention)
            if (_canRebalanceSafely()) {
                _applyReport();
                try vaultHub.forceRebalance(vaultAddress) {
                    // Success
                } catch {
                    shouldRemainHealthy = false;
                }
            }
        } else if (operationType == 5) {
            // burnShares
            uint256 liability = vaultHub.liabilityShares(vaultAddress);
            uint256 ownerShares = steth.sharesOf(vaultOwner);
            if (liability > 0 && ownerShares > 0) {
                uint256 maxBurn = liability < ownerShares ? liability : ownerShares;
                param1 = uint96(bound(param1, 1, maxBurn));
                vm.startPrank(vaultOwner);
                steth.approve(address(vaultHub), type(uint256).max);
                try vaultHub.transferAndBurnShares(vaultAddress, param1) {
                    // Success
                } catch {
                    shouldRemainHealthy = false;
                }
                vm.stopPrank();
            }
        } else if (operationType == 6) {
            // pauseBeaconChainDeposits
            vm.prank(vaultOwner);
            try vaultHub.pauseBeaconChainDeposits(vaultAddress) {
                // Success
            } catch {
                shouldRemainHealthy = false;
            }
        } else if (operationType == 7) {
            // resumeBeaconChainDeposits
            _applyReport();
            vm.prank(vaultOwner);
            try vaultHub.resumeBeaconChainDeposits(vaultAddress) {
                // Success
            } catch {
                shouldRemainHealthy = false;
            }
        } else if (operationType == 8) {
            // updateConnection
            uint16 newReserveRatioBP = uint16(bound(param1, 1000, 3000));
            uint16 newThresholdBP = uint16(bound(param2, 800, newReserveRatioBP - 100));

            if (newThresholdBP <= newReserveRatioBP) {
                _applyReport();
                vm.prank(address(operatorGrid));
                try
                    vaultHub.updateConnection(
                        vaultAddress,
                        SHARE_LIMIT,
                        newReserveRatioBP,
                        newThresholdBP,
                        INFRA_FEE_BP,
                        LIQUIDITY_FEE_BP,
                        RESERVATION_FEE_BP
                    )
                {
                    // Success
                } catch {
                    shouldRemainHealthy = false;
                }
            }
        } else if (operationType == 9) {
            // setLiabilitySharesTarget
            uint256 currentLiability = vaultHub.liabilityShares(vaultAddress);
            param1 = uint96(bound(param1, 0, currentLiability));
            vaultHub.grantRole(vaultHub.REDEMPTION_MASTER_ROLE(), address(this));
            try vaultHub.setLiabilitySharesTarget(vaultAddress, param1) {
                // Success
            } catch {
                shouldRemainHealthy = false;
            }
        }

        // Check if vault remains healthy
        if (shouldRemainHealthy) {
            bool isHealthyAfter = vaultHub.isVaultHealthy(vaultAddress);
            assertTrue(isHealthyAfter, "INVARIANT VIOLATED: Healthy vault became unhealthy after operation!");
        }

        // Revert to snapshot
        vm.revertTo(snapshot);
    }

    /// --- Helper Functions ---

    /**
     * @notice Set flag indicating last operation was settleLidoFees
     * @dev Called by handler to mark settleLidoFees operations
     * This is public because the handler needs to call it, and making it public
     * doesn't break the invariant (we reset it after each check anyway)
     */
    function setLastOpWasSettleFees() external {
        lastOpWasSettleFees = true;
    }

    // Increment functions for ghost variables - called by handler
    function incrementFundCount() external {
        ghost_fundCallCount++;
    }
    function incrementMintCount() external {
        ghost_mintCallCount++;
    }
    function incrementWithdrawCount() external {
        ghost_withdrawCallCount++;
    }
    function incrementRebalanceCount() external {
        ghost_rebalanceCallCount++;
    }
    function incrementForceRebalanceCount() external {
        ghost_forceRebalanceCallCount++;
    }
    function incrementBurnSharesCount() external {
        ghost_burnSharesCallCount++;
    }
    function incrementTransferAndBurnCount() external {
        ghost_transferAndBurnCallCount++;
    }
    function incrementUpdateConnectionCount() external {
        ghost_updateConnectionCallCount++;
    }
    function incrementPauseResumeCount() external {
        ghost_pauseResumeCallCount++;
    }
    function incrementSetLiabilityTargetCount() external {
        ghost_setLiabilityTargetCallCount++;
    }
    function incrementTriggerWithdrawalsCount() external {
        ghost_triggerWithdrawalsCallCount++;
    }
    function incrementSettleLidoFeesCount() external {
        ghost_settleLidoFeesCallCount++;
    }

    function _applyReport() internal {
        lazyOracle.refreshReportTimestamp();
        uint256 timestamp = lazyOracle.getTestReportTimestamp();

        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(vaultAddress);
        uint256 totalValue = vaultHub.totalValue(vaultAddress);

        // Get active inOutDelta
        uint256 activeIndex = record.inOutDelta[0].refSlot >= record.inOutDelta[1].refSlot ? 0 : 1;
        int256 inOutDelta = record.inOutDelta[activeIndex].value;

        // Simulate fee accrual: add 0.01 ETH worth of fees per report (simulates protocol fees)
        uint256 newCumulativeFees = record.cumulativeLidoFees + 0.01 ether;

        vm.prank(address(lazyOracle));
        vaultHub.applyVaultReport(
            vaultAddress,
            timestamp,
            totalValue,
            inOutDelta,
            newCumulativeFees,
            record.liabilityShares,
            record.maxLiabilityShares,
            0 // slashingReserve
        );
    }

    /**
     * @notice Check if rebalance can be done safely (prevent rounding issues)
     * @dev From spec: require threshold not breached by at least 2 wei
     */
    function _canRebalanceSafely() internal view returns (bool) {
        uint256 totalValue = vaultHub.totalValue(vaultAddress);
        uint256 liabilityShares = vaultHub.liabilityShares(vaultAddress);
        VaultHub.VaultConnection memory connection = vaultHub.vaultConnection(vaultAddress);
        uint256 thresholdBP = connection.forcedRebalanceThresholdBP;

        // Check share rate > 1 (from spec: require _internalShares() < _internalEth)
        if (steth.totalShares() >= steth.totalPooledEther()) {
            return false;
        }

        // Calculate liability in ETH (round up)
        uint256 liabilityEth = steth.getPooledEthBySharesRoundUp(liabilityShares);

        // Check threshold not breached by at least 2 wei
        uint256 thresholdValue = (totalValue * (TOTAL_BASIS_POINTS - thresholdBP)) / TOTAL_BASIS_POINTS;
        return liabilityEth + 2 < thresholdValue;
    }
}

/**
 * @title HealthHandler
 * @notice Handler contract for invariant testing of health property
 * @dev This handler manages state transitions that should preserve vault health
 */
contract HealthHandler is Test {
    VaultHub public vaultHub;
    MockStETH public steth;
    LazyOracle__HarnessForVaultHub public lazyOracle;
    OperatorGrid public operatorGrid;
    address public vaultAddress;
    address public vaultOwner;
    address public nodeOperator;
    VaultHubHealthInvariantTest public testContract;

    uint256 constant TOTAL_BASIS_POINTS = 10000;
    uint256 constant SHARE_LIMIT = 100 ether;
    uint256 constant INFRA_FEE_BP = 500;
    uint256 constant LIQUIDITY_FEE_BP = 400;
    uint256 constant RESERVATION_FEE_BP = 100;

    constructor(
        VaultHub _vaultHub,
        MockStETH _steth,
        LazyOracle__HarnessForVaultHub _lazyOracle,
        OperatorGrid _operatorGrid,
        address _vaultAddress,
        address _vaultOwner,
        address _nodeOperator,
        VaultHubHealthInvariantTest _testContract
    ) {
        vaultHub = _vaultHub;
        steth = _steth;
        lazyOracle = _lazyOracle;
        operatorGrid = _operatorGrid;
        vaultAddress = _vaultAddress;
        vaultOwner = _vaultOwner;
        nodeOperator = _nodeOperator;
        testContract = _testContract;
    }

    /// ========== OPERATIONS THAT MUST PRESERVE HEALTH ==========

    /**
     * @notice Fund the vault with ETH
     */
    function fund(uint96 amount) external {
        amount = uint96(bound(amount, 1 ether, 50 ether));

        vm.prank(vaultOwner);
        vaultHub.fund{value: amount}(vaultAddress);

        _applyReport();
        testContract.incrementFundCount();
    }

    /**
     * @notice Mint shares from the vault
     */
    function mintShares(uint96 shares) external {
        shares = uint96(bound(shares, 0.1 ether, 10 ether));

        uint256 maxMintable = vaultHub.totalMintingCapacityShares(vaultAddress, 0);
        if (shares > maxMintable) shares = uint96(maxMintable);
        if (shares == 0) return;

        vm.prank(vaultOwner);
        try vaultHub.mintShares(vaultAddress, vaultOwner, shares) {
            testContract.incrementMintCount();
        } catch {
            // Minting can fail, that's OK
        }
    }

    /**
     * @notice Withdraw funds from the vault
     */
    function withdraw(uint96 amount) external {
        uint256 withdrawable = vaultHub.withdrawableValue(vaultAddress);
        if (withdrawable == 0) return;

        amount = uint96(bound(amount, 1, withdrawable));

        vm.prank(vaultOwner);
        try vaultHub.withdraw(vaultAddress, vaultOwner, amount) {
            _applyReport();
            testContract.incrementWithdrawCount();
        } catch {
            // Withdrawal can fail, that's OK
        }
    }

    /**
     * @notice Rebalance vault (reduces liability)
     * @dev With rounding prevention per spec
     */
    function rebalance(uint96 shares) external {
        // Check rounding prevention requirement
        if (!_canRebalanceSafely()) return;

        uint256 liability = vaultHub.liabilityShares(vaultAddress);
        if (liability == 0) return;

        shares = uint96(bound(shares, 1, liability / 2));

        _applyReport();

        vm.prank(vaultOwner);
        try vaultHub.rebalance(vaultAddress, shares) {
            testContract.incrementRebalanceCount();
        } catch {
            // Rebalance can fail, that's OK
        }
    }

    /**
     * @notice Force rebalance when vault is unhealthy
     * @dev With rounding prevention per spec
     */
    function forceRebalance() external {
        // Check rounding prevention requirement
        if (!_canRebalanceSafely()) return;

        _applyReport();

        try vaultHub.forceRebalance(vaultAddress) {
            testContract.incrementForceRebalanceCount();
        } catch {
            // Force rebalance can fail, that's OK
        }
    }

    /**
     * @notice Burn shares - reduces liability
     */
    function burnShares(uint96 shares) external {
        uint256 liability = vaultHub.liabilityShares(vaultAddress);
        uint256 ownerShares = steth.sharesOf(vaultOwner);

        if (liability == 0 || ownerShares == 0) return;

        uint256 maxBurn = liability < ownerShares ? liability : ownerShares;
        shares = uint96(bound(shares, 1, maxBurn));

        vm.startPrank(vaultOwner);
        steth.approve(address(vaultHub), type(uint256).max);
        try vaultHub.transferAndBurnShares(vaultAddress, shares) {
            testContract.incrementBurnSharesCount();
            testContract.incrementTransferAndBurnCount();
        } catch {
            // Burning can fail, that's OK
        }
        vm.stopPrank();
    }

    /**
     * @notice Update vault connection parameters
     * @dev Requires forcedRebalanceThresholdBP <= reserveRatioBP
     */
    function updateConnection(uint16 newReserveRatioBP, uint16 newThresholdBP) external {
        newReserveRatioBP = uint16(bound(newReserveRatioBP, 1000, 3000)); // 10% to 30%
        newThresholdBP = uint16(bound(newThresholdBP, 800, newReserveRatioBP - 100));

        // Enforce requirement from spec
        if (newThresholdBP > newReserveRatioBP) return;

        _applyReport();

        vm.prank(address(operatorGrid));
        try
            vaultHub.updateConnection(
                vaultAddress,
                SHARE_LIMIT,
                newReserveRatioBP,
                newThresholdBP,
                INFRA_FEE_BP,
                LIQUIDITY_FEE_BP,
                RESERVATION_FEE_BP
            )
        {
            testContract.incrementUpdateConnectionCount();
        } catch {
            // Update can fail, that's OK
        }
    }

    /**
     * @notice Pause beacon chain deposits
     */
    function pauseBeaconChainDeposits() external {
        vm.prank(vaultOwner);
        try vaultHub.pauseBeaconChainDeposits(vaultAddress) {
            testContract.incrementPauseResumeCount();
        } catch {
            // Pause can fail if already paused, that's OK
        }
    }

    /**
     * @notice Resume beacon chain deposits
     */
    function resumeBeaconChainDeposits() external {
        _applyReport();

        vm.prank(vaultOwner);
        try vaultHub.resumeBeaconChainDeposits(vaultAddress) {
            testContract.incrementPauseResumeCount();
        } catch {
            // Resume can fail if already resumed, that's OK
        }
    }

    /**
     * @notice Set liability shares target (redemption mechanism)
     */
    function setLiabilitySharesTarget(uint96 target) external {
        uint256 currentLiability = vaultHub.liabilityShares(vaultAddress);
        target = uint96(bound(target, 0, currentLiability));

        try vaultHub.setLiabilitySharesTarget(vaultAddress, target) {
            testContract.incrementSetLiabilityTargetCount();
        } catch {
            // Can fail if target is invalid, that's OK
        }
    }

    /**
     * @notice Settle Lido fees
     * @dev EXCEPTION: Per spec, this CAN make a healthy vault unhealthy
     * "with the exception of settling fees"
     */
    function settleLidoFees() external {
        _applyReport();

        if (vaultHub.settleableLidoFeesValue(vaultAddress) > 0) {
            // Mark that this operation is settleLidoFees (excluded from invariant)
            testContract.setLastOpWasSettleFees();

            try vaultHub.settleLidoFees(vaultAddress) {
                testContract.incrementSettleLidoFeesCount();
            } catch {
                // Settlement can fail, that's OK
            }
        }
    }

    /**
     * @notice Trigger validator withdrawals
     * @dev Simplified version - actual implementation would need validator data
     */
    function triggerValidatorWithdrawals() external {
        // This is a complex operation that requires validator data
        // For now, we'll skip it or implement a simplified version
        // In a full implementation, you'd need to provide proper validator withdrawal data
        testContract.incrementTriggerWithdrawalsCount();
    }

    /**
     * @notice Check if rebalance can be done safely (prevent rounding issues)
     */
    function _canRebalanceSafely() internal view returns (bool) {
        uint256 totalValue = vaultHub.totalValue(vaultAddress);
        uint256 liabilityShares = vaultHub.liabilityShares(vaultAddress);
        VaultHub.VaultConnection memory connection = vaultHub.vaultConnection(vaultAddress);
        uint256 thresholdBP = connection.forcedRebalanceThresholdBP;

        // Check share rate > 1 (from spec: require _internalShares() < _internalEth)
        if (steth.totalShares() >= steth.totalPooledEther()) {
            return false;
        }

        // Calculate liability in ETH (round up)
        uint256 liabilityEth = steth.getPooledEthBySharesRoundUp(liabilityShares);

        // Check threshold not breached by at least 2 wei
        uint256 thresholdValue = (totalValue * (TOTAL_BASIS_POINTS - thresholdBP)) / TOTAL_BASIS_POINTS;
        return liabilityEth + 2 < thresholdValue;
    }

    function _applyReport() internal {
        lazyOracle.refreshReportTimestamp();
        uint256 timestamp = lazyOracle.getTestReportTimestamp();

        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(vaultAddress);
        uint256 totalValue = vaultHub.totalValue(vaultAddress);

        uint256 activeIndex = record.inOutDelta[0].refSlot >= record.inOutDelta[1].refSlot ? 0 : 1;
        int256 inOutDelta = record.inOutDelta[activeIndex].value;

        // Simulate fee accrual: add 0.01 ETH worth of fees per report (simulates protocol fees)
        uint256 newCumulativeFees = record.cumulativeLidoFees + 0.01 ether;

        vm.prank(address(lazyOracle));
        vaultHub.applyVaultReport(
            vaultAddress,
            timestamp,
            totalValue,
            inOutDelta,
            newCumulativeFees,
            record.liabilityShares,
            record.maxLiabilityShares,
            0
        );
    }
}
