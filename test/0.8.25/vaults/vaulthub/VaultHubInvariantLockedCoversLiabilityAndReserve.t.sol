// SPDX-License-Identifier: UNLICENSED

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
    MockPredepositGuarantee, // never used but needed
    MockDepositContract // prevent conflict with different version
} from "./VaultHubInvariant.t.sol";

contract VaultHubLockedInvariantTest is Test {
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
    MockPredepositGuarantee public pdg; // never used
    MockDepositContract public depositContract;

    // Beacon and proxy infrastructure for StakingVault
    UpgradeableBeacon public vaultBeacon;

    // Test addresses
    address public vaultAddress;
    address public vaultOwner;
    address public nodeOperator;

    // Handler for invariant testing
    LockedHandler public handler;

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

        // Fund vault to ensure it starts with sufficient locked value
        vm.prank(vaultOwner);
        vaultHub.fund{value: 50 ether}(vaultAddress);
        _applyReport();

        // Deploy handler for invariant testing
        handler = new LockedHandler(
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
     * @notice INVARIANT: Locked value covers liability and reserve
     * @dev Core property from vaultLockedCoversLiabilityAndReserve (Accounting.spec line 37-99)
     *
     * Property: For any vault state:
     * locked(vault) * (TOTAL_BASIS_POINTS - reserveRatioBP) >= liabilityEth * TOTAL_BASIS_POINTS
     *
     * This ensures the vault always has sufficient locked value to cover both:
     * 1. The liability (stETH minted to users)
     * 2. The required reserve ratio
     *
     * forge-config: default.invariant.runs = 10000
     * forge-config: default.invariant.depth = 100
     * forge-config: default.invariant.fail-on-revert = false
     */
    function invariant_lockedCoversLiabilityAndReserve() public {
        uint256 locked = vaultHub.locked(vaultAddress);
        uint256 liabilityShares = vaultHub.liabilityShares(vaultAddress);
        uint256 liabilityEth = steth.getPooledEthByShares(liabilityShares);

        VaultHub.VaultConnection memory connection = vaultHub.vaultConnection(vaultAddress);
        uint256 reserveRatioBP = connection.reserveRatioBP;

        // locked * (TOTAL_BASIS_POINTS - reserveRatioBP) >= liabilityEth * TOTAL_BASIS_POINTS
        uint256 lhs = locked * (TOTAL_BASIS_POINTS - reserveRatioBP);
        uint256 rhs = liabilityEth * TOTAL_BASIS_POINTS;

        assertGe(lhs, rhs, "INVARIANT VIOLATED: locked amount does not cover liability and reserve");
    }

    /**
     * @notice Called after each invariant run - log statistics
     */
    function afterInvariant() external view {
        console.log("\n=== INVARIANT RUN STATISTICS ===");
        console.log("\n--- OPERATIONS (Success/Fail/Total) ---");

        uint256 fundSuccess = handler.ghost_fundCallCount();
        uint256 fundFail = handler.ghost_fundFailCount();
        console.log("Fund: %d / %d / %d", fundSuccess, fundFail, fundSuccess + fundFail);

        uint256 mintSuccess = handler.ghost_mintCallCount();
        uint256 mintFail = handler.ghost_mintFailCount();
        console.log("Mint: %d / %d / %d", mintSuccess, mintFail, mintSuccess + mintFail);

        uint256 withdrawSuccess = handler.ghost_withdrawCallCount();
        uint256 withdrawFail = handler.ghost_withdrawFailCount();
        console.log("Withdraw: %d / %d / %d", withdrawSuccess, withdrawFail, withdrawSuccess + withdrawFail);

        uint256 rebalanceSuccess = handler.ghost_rebalanceCallCount();
        uint256 rebalanceFail = handler.ghost_rebalanceFailCount();
        console.log("Rebalance: %d / %d / %d", rebalanceSuccess, rebalanceFail, rebalanceSuccess + rebalanceFail);

        uint256 burnSuccess = handler.ghost_burnSharesCallCount();
        uint256 burnFail = handler.ghost_burnSharesFailCount();
        console.log("Burn shares: %d / %d / %d", burnSuccess, burnFail, burnSuccess + burnFail);

        uint256 shareRateSuccess = handler.ghost_shareRateIncreaseCallCount();
        console.log("Share rate increase: %d / 0 / %d", shareRateSuccess, shareRateSuccess);

        uint256 updateSuccess = handler.ghost_updateConnectionCallCount();
        uint256 updateFail = handler.ghost_updateConnectionFailCount();
        console.log("Update connection: %d / %d / %d", updateSuccess, updateFail, updateSuccess + updateFail);

        uint256 liabilitySuccess = handler.ghost_setLiabilityTargetCallCount();
        uint256 liabilityFail = handler.ghost_setLiabilityTargetFailCount();
        console.log(
            "Set liability target: %d / %d / %d",
            liabilitySuccess,
            liabilityFail,
            liabilitySuccess + liabilityFail
        );

        uint256 reportSuccess = handler.ghost_applyReportCallCount();
        console.log("Apply report: %d / 0 / %d", reportSuccess, reportSuccess);

        uint256 settleSuccess = handler.ghost_settleFeesCallCount();
        uint256 settleFail = handler.ghost_settleFeesFailCount();
        console.log("Settle fees: %d / %d / %d", settleSuccess, settleFail, settleSuccess + settleFail);

        // Calculate success rates
        console.log("\n--- SUCCESS RATES ---");
        console.log("Fund: %d%%", _successRate(fundSuccess, fundFail));
        console.log("Mint: %d%%", _successRate(mintSuccess, mintFail));
        console.log("Withdraw: %d%%", _successRate(withdrawSuccess, withdrawFail));
        console.log("Rebalance: %d%%", _successRate(rebalanceSuccess, rebalanceFail));
        console.log("Burn shares: %d%%", _successRate(burnSuccess, burnFail));
        console.log("Update connection: %d%%", _successRate(updateSuccess, updateFail));
        console.log("Set liability target: %d%%", _successRate(liabilitySuccess, liabilityFail));
        console.log("Settle fees: %d%%", _successRate(settleSuccess, settleFail));
    }

    function _successRate(uint256 success, uint256 fail) internal pure returns (uint256) {
        uint256 total = success + fail;
        if (total == 0) return 0;
        return (success * 100) / total;
    }

    function _applyReport() internal {
        lazyOracle.refreshReportTimestamp();
        uint256 timestamp = lazyOracle.getTestReportTimestamp();

        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(vaultAddress);
        uint256 totalValue = vaultHub.totalValue(vaultAddress);

        // Get active inOutDelta
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
            0 // slashingReserve
        );
    }
}

/**
 * @title LockedHandler
 * @notice Handler contract for invariant testing of locked value coverage
 * @dev This handler manages state transitions that should preserve the locked invariant
 */
contract LockedHandler is Test {
    VaultHub public vaultHub;
    MockStETH public steth;
    LazyOracle__HarnessForVaultHub public lazyOracle;
    OperatorGrid public operatorGrid;
    address public vaultAddress;
    address public vaultOwner;
    address public nodeOperator;
    VaultHubLockedInvariantTest public testContract;

    uint256 constant TOTAL_BASIS_POINTS = 10000;
    uint256 constant SHARE_LIMIT = 100 ether;
    uint256 constant INFRA_FEE_BP = 500;
    uint256 constant LIQUIDITY_FEE_BP = 400;
    uint256 constant RESERVATION_FEE_BP = 100;

    // Ghost variables to track successes
    uint256 public ghost_fundCallCount;
    uint256 public ghost_mintCallCount;
    uint256 public ghost_withdrawCallCount;
    uint256 public ghost_rebalanceCallCount;
    uint256 public ghost_burnSharesCallCount;
    uint256 public ghost_shareRateIncreaseCallCount;
    uint256 public ghost_updateConnectionCallCount;
    uint256 public ghost_setLiabilityTargetCallCount;
    uint256 public ghost_applyReportCallCount;
    uint256 public ghost_settleFeesCallCount;

    // Ghost variables to track failures
    uint256 public ghost_fundFailCount;
    uint256 public ghost_mintFailCount;
    uint256 public ghost_withdrawFailCount;
    uint256 public ghost_rebalanceFailCount;
    uint256 public ghost_burnSharesFailCount;
    uint256 public ghost_updateConnectionFailCount;
    uint256 public ghost_setLiabilityTargetFailCount;
    uint256 public ghost_settleFeesFailCount;

    constructor(
        VaultHub _vaultHub,
        MockStETH _steth,
        LazyOracle__HarnessForVaultHub _lazyOracle,
        OperatorGrid _operatorGrid,
        address _vaultAddress,
        address _vaultOwner,
        address _nodeOperator,
        VaultHubLockedInvariantTest _testContract
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

    /// ========== OPERATIONS THAT MUST PRESERVE LOCKED INVARIANT ==========

    /**
     * @notice Fund the vault with ETH
     */
    function fund(uint96 amount) external {
        amount = uint96(bound(amount, 1 ether, 50 ether));

        vm.prank(vaultOwner);
        try vaultHub.fund{value: amount}(vaultAddress) {
            _applyReport();
            ghost_fundCallCount++;
        } catch {
            ghost_fundFailCount++;
        }
    }

    /**
     * @notice Mint shares from the vault
     */
    function mintShares(uint96 shares) external {
        shares = uint96(bound(shares, 0.1 ether, 10 ether));

        uint256 maxMintable = vaultHub.totalMintingCapacityShares(vaultAddress, 0);
        if (shares > maxMintable) shares = uint96(maxMintable);
        if (shares == 0) {
            ghost_mintFailCount++;
            return;
        }

        vm.prank(vaultOwner);
        try vaultHub.mintShares(vaultAddress, vaultOwner, shares) {
            ghost_mintCallCount++;
        } catch {
            ghost_mintFailCount++;
        }
    }

    /**
     * @notice Withdraw funds from the vault
     */
    function withdraw(uint96 amount) external {
        uint256 withdrawable = vaultHub.withdrawableValue(vaultAddress);
        if (withdrawable == 0) {
            ghost_withdrawFailCount++;
            return;
        }

        amount = uint96(bound(amount, 1, withdrawable));

        vm.prank(vaultOwner);
        try vaultHub.withdraw(vaultAddress, vaultOwner, amount) {
            _applyReport();
            ghost_withdrawCallCount++;
        } catch {
            ghost_withdrawFailCount++;
        }
    }

    /**
     * @notice Rebalance vault (reduces liability)
     */
    function rebalance(uint96 shares) external {
        uint256 liability = vaultHub.liabilityShares(vaultAddress);
        if (liability == 0) {
            ghost_rebalanceFailCount++;
            return;
        }

        shares = uint96(bound(shares, 1, liability / 2));

        _applyReport();

        vm.prank(vaultOwner);
        try vaultHub.rebalance(vaultAddress, shares) {
            ghost_rebalanceCallCount++;
        } catch {
            ghost_rebalanceFailCount++;
        }
    }

    /**
     * @notice Burn shares - reduces liability
     */
    function burnShares(uint96 shares) external {
        uint256 liability = vaultHub.liabilityShares(vaultAddress);
        uint256 ownerShares = steth.sharesOf(vaultOwner);

        if (liability == 0 || ownerShares == 0) {
            ghost_burnSharesFailCount++;
            return;
        }

        uint256 maxBurn = liability < ownerShares ? liability : ownerShares;
        shares = uint96(bound(shares, 1, maxBurn));

        vm.startPrank(vaultOwner);
        steth.approve(address(vaultHub), type(uint256).max);
        try vaultHub.transferAndBurnShares(vaultAddress, shares) {
            ghost_burnSharesCallCount++;
        } catch {
            ghost_burnSharesFailCount++;
        }
        vm.stopPrank();
    }

    /**
     * @notice Simulate external share rate increase (rebalancing)
     * @dev This simulates the effect of Lido protocol rebalancing
     */
    function simulateShareRateIncrease(uint96 ethAmount) external {
        ethAmount = uint96(bound(ethAmount, 0.1 ether, 10 ether));

        steth.simulateRebalanceRateIncrease(ethAmount);
        ghost_shareRateIncreaseCallCount++;
    }

    /**
     * @notice Update vault connection parameters
     */
    function updateConnection(uint16 newReserveRatioBP) external {
        newReserveRatioBP = uint16(bound(newReserveRatioBP, 1000, 3000)); // 10% to 30%

        _applyReport();

        // Check if vault would be healthy with new ratio
        uint256 totalValue = vaultHub.totalValue(vaultAddress);
        uint256 liability = vaultHub.liabilityShares(vaultAddress);
        bool wouldBeHealthy = !_isThresholdBreached(totalValue, liability, newReserveRatioBP);

        if (!wouldBeHealthy) {
            ghost_updateConnectionFailCount++;
            return;
        }

        vm.prank(address(operatorGrid));
        try
            vaultHub.updateConnection(
                vaultAddress,
                SHARE_LIMIT,
                newReserveRatioBP,
                newReserveRatioBP - 200, // forcedRebalanceThreshold slightly less
                INFRA_FEE_BP,
                LIQUIDITY_FEE_BP,
                RESERVATION_FEE_BP
            )
        {
            ghost_updateConnectionCallCount++;
        } catch {
            ghost_updateConnectionFailCount++;
        }
    }

    /**
     * @notice Set liability shares target (redemption mechanism)
     */
    function setLiabilitySharesTarget(uint96 target) external {
        uint256 currentLiability = vaultHub.liabilityShares(vaultAddress);
        target = uint96(bound(target, 0, currentLiability));

        try vaultHub.setLiabilitySharesTarget(vaultAddress, target) {
            ghost_setLiabilityTargetCallCount++;
        } catch {
            ghost_setLiabilityTargetFailCount++;
        }
    }

    /**
     * @notice Apply vault report with current state
     */
    function applyReport() external {
        _applyReport();
        ghost_applyReportCallCount++;
    }

    /**
     * @notice Settle Lido fees
     */
    function settleFees() external {
        _applyReport();

        // Check if there are unsettled fees first
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(vaultAddress);
        uint256 unsettledFees = record.cumulativeLidoFees - record.settledLidoFees;

        if (unsettledFees == 0) {
            ghost_settleFeesFailCount++;
            return;
        }

        if (vaultHub.settleableLidoFeesValue(vaultAddress) == 0) {
            ghost_settleFeesFailCount++;
            return;
        }

        try vaultHub.settleLidoFees(vaultAddress) {
            ghost_settleFeesCallCount++;
        } catch {
            ghost_settleFeesFailCount++;
        }
    }

    /**
     * @notice Helper to check if liability would breach threshold
     */
    function _isThresholdBreached(
        uint256 _vaultTotalValue,
        uint256 _vaultLiabilityShares,
        uint256 _thresholdBP
    ) internal view returns (bool) {
        uint256 liability = steth.getPooledEthBySharesRoundUp(_vaultLiabilityShares);
        return liability > (_vaultTotalValue * (TOTAL_BASIS_POINTS - _thresholdBP)) / TOTAL_BASIS_POINTS;
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
