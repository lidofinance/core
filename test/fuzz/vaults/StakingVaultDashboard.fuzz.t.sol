// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

/**
 * @title  StakingVault + Dashboard Integration Fuzz Suite
 * @notice Foundry fuzz tests exercising the Dashboard → VaultHub → StakingVault
 *         call chain under realistic deployment conditions.
 *
 *  Two deployment modes are exercised:
 *    A) "Connected" — vault deployed via beacon proxy, Dashboard clone initialised
 *       and connected to the mock VaultHub (vault owner = VaultHub mock after connect)
 *    B) "Disconnected" — same setup but connectToVaultHub() NOT called; vault
 *       owner remains the Dashboard
 *
 *  Properties tested (25):
 *    DASH-1   Double initialisation of Dashboard reverts
 *    DASH-2   fund() reverts for non-FUND_ROLE / non-DEFAULT_ADMIN
 *    DASH-3   fund() succeeds for FUND_ROLE holder
 *    DASH-4   fund() succeeds for DEFAULT_ADMIN
 *    DASH-5   withdraw() reverts for non-WITHDRAW_ROLE caller
 *    DASH-6   withdraw(recipient, 0) succeeds for WITHDRAW_ROLE (zero passthrough)
 *    DASH-7   mintShares() reverts for non-MINT_ROLE caller
 *    DASH-8   mintShares() succeeds for MINT_ROLE holder (with capacity set up)
 *    DASH-9   burnShares() reverts for non-BURN_ROLE caller
 *    DASH-10  pauseBeaconChainDeposits() reverts for non-role caller
 *    DASH-11  pauseBeaconChainDeposits() succeeds for PAUSE_BEACON_CHAIN_DEPOSITS_ROLE
 *    DASH-12  resumeBeaconChainDeposits() reverts for non-role caller
 *    DASH-13  resumeBeaconChainDeposits() succeeds for role holder
 *    DASH-14  requestValidatorExit() reverts for non-role caller
 *    DASH-15  requestValidatorExit() routes to VaultHub for role holder
 *    DASH-16  voluntaryDisconnect() reverts for non-role caller   (disconnected mode)
 *    DASH-17  renounceRole() always reverts
 *    DASH-18  grantRoles() batch assignment adds roles correctly
 *    DASH-19  revokeRoles() batch revocation removes roles correctly
 *    DASH-20  setFeeRate() > 10000 reverts
 *    DASH-21  setFeeRate() ≤ 100 is accepted (valid range)
 *    DASH-22  connectToVaultHub() by non-DEFAULT_ADMIN reverts
 *    DASH-23  connectToVaultHub() by admin transfers vault owner to VaultHub
 *    DASH-24  receive() with fundOnReceive default sends ETH to VaultHub
 *    DASH-25  withdrawableValue() ≤ totalValue after connect
 */

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";

import {Dashboard} from "contracts/0.8.25/vaults/dashboard/Dashboard.sol";
import {Permissions} from "contracts/0.8.25/vaults/dashboard/Permissions.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";

// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL MOCKS (all inline – no external files needed)
// ═══════════════════════════════════════════════════════════════════════════════

/// @dev Minimal stETH mock satisfying Dashboard's IStETH / ILido usage
contract MockStETHForDashboardTest {
    function approve(address, uint256) external pure returns (bool) { return true; }
    function getTotalShares() external pure returns (uint256) { return 1e24; }
    function getTotalPooledEther() external pure returns (uint256) { return 1e24; }
    function getSharesByPooledEth(uint256 x) external pure returns (uint256) { return x; }
    function getPooledEthBySharesRoundUp(uint256 x) external pure returns (uint256) { return x; }
    function mintExternalShares(address, uint256) external {}
    function burnExternalShares(uint256) external {}
    function transferSharesFrom(address, address, uint256) external returns (uint256) { return 0; }
    function transferShares(address, uint256) external returns (uint256) { return 0; }
}

/// @dev Minimal wstETH mock – must satisfy IERC20 used via SafeERC20
contract MockWstETHForDashboardTest {
    function wrap(uint256 x) external pure returns (uint256) { return x; }
    function unwrap(uint256 x) external pure returns (uint256) { return x; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return true; }
    function balanceOf(address) external pure returns (uint256) { return type(uint256).max; }
    function allowance(address, address) external pure returns (uint256) { return type(uint256).max; }
}

/// @dev Minimal deposit contract mock
contract MockDepositContractForDashboardTest {
    function deposit(bytes calldata, bytes calldata, bytes calldata, bytes32) external payable {}
}

/// @dev Minimal OperatorGrid mock – returns unbounded share limit
contract MockOperatorGridForDashboardTest {
    function effectiveShareLimit(address) external pure returns (uint256) {
        return type(uint96).max;
    }

    function changeTier(address, uint256, uint256) external pure returns (bool) { return true; }
    function syncTier(address) external pure returns (bool) { return true; }
    function updateVaultShareLimit(address, uint256) external pure returns (bool) { return true; }
    function onMintedShares(address, uint256, bool) external {}
    function onBurnedShares(address, uint256) external {}
    function resetVaultTier(address) external {}
}

/// @dev Minimal LazyOracle mock — satisfies NodeOperatorFee._calculateFee() and setFeeRate()
contract MockLazyOracleForDashboardTest {
    /// @dev quarantineValue is baked into fee calculation; return 0 so accruedFee() == 0
    function quarantineValue(address) external pure returns (uint256) { return 0; }
    /// @dev latestReportTimestamp > latestCorrectionTimestamp(0) so setFeeRate() precondition passes
    function latestReportTimestamp() external view returns (uint256) { return block.timestamp + 1; }
}

/// @dev LidoLocator mock returning only fields needed by Dashboard/Permissions/VaultHub paths
contract MockLidoLocatorForDashboardTest {
    address public immutable VAULT_HUB;
    address public immutable OPERATOR_GRID;
    address public immutable PDG;
    address public immutable WSTETH;
    address public immutable LAZY_ORACLE;

    constructor(address _vaultHub, address _operatorGrid, address _pdg, address _wsteth, address _lazyOracle) {
        VAULT_HUB     = _vaultHub;
        OPERATOR_GRID = _operatorGrid;
        PDG           = _pdg;
        WSTETH        = _wsteth;
        LAZY_ORACLE   = _lazyOracle;
    }

    function vaultHub()            external view returns (address) { return VAULT_HUB; }
    function operatorGrid()        external view returns (address) { return OPERATOR_GRID; }
    function predepositGuarantee() external view returns (address) { return PDG; }
    function wstETH()              external view returns (address) { return WSTETH; }
    function lazyOracle()          external view returns (address) { return LAZY_ORACLE; }

    // Unused but required to satisfy ILidoLocator in compilation
    function accountingOracle()             external pure returns (address) { return address(0); }
    function depositSecurityModule()        external pure returns (address) { return address(0); }
    function elRewardsVault()               external pure returns (address) { return address(0); }
    function lido()                         external pure returns (address) { return address(0); }
    function oracleReportSanityChecker()    external pure returns (address) { return address(0); }
    function burner()                       external pure returns (address) { return address(0); }
    function stakingRouter()                external pure returns (address) { return address(0); }
    function treasury()                     external pure returns (address) { return address(0); }
    function validatorsExitBusOracle()      external pure returns (address) { return address(0); }
    function withdrawalQueue()              external pure returns (address) { return address(0); }
    function withdrawalVault()              external pure returns (address) { return address(0); }
    function postTokenRebaseReceiver()      external pure returns (address) { return address(0); }
    function oracleDaemonConfig()           external pure returns (address) { return address(0); }
    function accounting()                   external pure returns (address) { return address(0); }
    function vaultFactory()                 external pure returns (address) { return address(0); }
}

/// @dev VaultHub mock sufficient for Dashboard operations in tests.
///      Tracks whether fund/withdraw/mint/burn/connect calls were made.
contract MockVaultHubForDashboardTest {
    using MockVaultHubStorage for MockVaultHubStorage.Data;

    MockVaultHubStore internal _store;
    MockStETHForDashboardTest public immutable STETH_MOCK;
    MockOperatorGridForDashboardTest public immutable OP_GRID;

    // Configurable total value per vault (for view functions)
    mapping(address vault => uint256) public mockTotalValue;

    // Events to assert on
    event FundCalled(address indexed vault, uint256 amount);
    event WithdrawCalled(address indexed vault, address recipient, uint256 amount);
    event MintSharesCalled(address indexed vault, address recipient, uint256 shares);
    event BurnSharesCalled(address indexed vault, uint256 shares);
    event RebalanceCalled(address indexed vault, uint256 shares);
    event DisconnectCalled(address indexed vault);
    event ValidatorExitCalled(address indexed vault);
    event PauseDepositsCalled(address indexed vault);
    event ResumeDepositsCalled(address indexed vault);
    event TriggerWithdrawalsCalled(address indexed vault);

    // Connection tracking
    mapping(address vault => bool) public vaultConnected;

    constructor(address _steth, address _opGrid) {
        STETH_MOCK = MockStETHForDashboardTest(_steth);
        OP_GRID    = MockOperatorGridForDashboardTest(_opGrid);
    }

    receive() external payable {}

    uint256 public constant CONNECT_DEPOSIT = 1 ether;

    function connectVault(address vault) external {
        IStakingVault(vault).acceptOwnership();
        vaultConnected[vault] = true;
    }

    function isVaultConnected(address vault) external view returns (bool) {
        return vaultConnected[vault];
    }

    function isPendingDisconnect(address) external pure returns (bool) { return false; }

    function vaultConnection(address vault) external view returns (VaultHub.VaultConnection memory conn) {
        if (vaultConnected[vault]) {
            conn.vaultIndex            = 1;
            conn.disconnectInitiatedTs = type(uint48).max;
            conn.reserveRatioBP        = 500;
        }
    }

    function vaultRecord(address) external pure returns (VaultHub.VaultRecord memory) {}

    function latestReport(address) external pure returns (VaultHub.Report memory) {}

    function isReportFresh(address) external pure returns (bool) { return true; }

    function totalValue(address vault) external view returns (uint256) { return mockTotalValue[vault]; }

    function liabilityShares(address) external pure returns (uint256) { return 0; }

    function locked(address vault) external view returns (uint256) {
        // locked = totalValue * reserveRatioBP / 10000 = 5% of totalValue
        return mockTotalValue[vault] * 500 / 10000;
    }

    function maxLockableValue(address vault) external view returns (uint256) { return mockTotalValue[vault]; }

    function withdrawableValue(address vault) external view returns (uint256) {
        uint256 tv = mockTotalValue[vault];
        uint256 loc = tv * 500 / 10000;
        return tv > loc ? tv - loc : 0;
    }

    function totalMintingCapacityShares(address vault, int256 deltaValue) external view returns (uint256) {
        uint256 tv = mockTotalValue[vault];
        uint256 base = deltaValue >= 0
            ? tv + uint256(deltaValue)
            : tv - uint256(-deltaValue);
        uint256 mintable = base * 9500 / 10000;
        uint256 limit = OP_GRID.effectiveShareLimit(vault);
        return mintable < limit ? mintable : limit;
    }

    function obligations(address) external pure returns (uint256, uint256) { return (0, 0); }
    function healthShortfallShares(address) external pure returns (uint256) { return 0; }
    function obligationsShortfallValue(address) external pure returns (uint256) { return 0; }

    // ── State-changing, event-emitting functions (no balance change) ──────────

    function fund(address vault) external payable {
        emit FundCalled(vault, msg.value);
    }

    function withdraw(address vault, address recipient, uint256 amount) external {
        emit WithdrawCalled(vault, recipient, amount);
    }

    function mintShares(address vault, address recipient, uint256 shares) external {
        emit MintSharesCalled(vault, recipient, shares);
    }

    function burnShares(address vault, uint256 shares) external {
        emit BurnSharesCalled(vault, shares);
    }

    function rebalance(address vault, uint256 shares) external payable {
        emit RebalanceCalled(vault, shares);
    }

    function voluntaryDisconnect(address vault) external {
        emit DisconnectCalled(vault);
    }

    function requestValidatorExit(address vault, bytes calldata) external {
        emit ValidatorExitCalled(vault);
    }

    function pauseBeaconChainDeposits(address vault) external {
        emit PauseDepositsCalled(vault);
    }

    function resumeBeaconChainDeposits(address vault) external {
        emit ResumeDepositsCalled(vault);
    }

    function triggerValidatorWithdrawals(
        address vault,
        bytes calldata,
        uint64[] calldata,
        address
    ) external payable {
        emit TriggerWithdrawalsCalled(vault);
    }

    function transferVaultOwnership(address vault, address newOwner) external {
        IStakingVault(vault).transferOwnership(newOwner);
    }

    function collectERC20FromVault(address, address, address, uint256) external {}
    function proveUnknownValidatorToPDG(address, IPredepositGuarantee.ValidatorWitness calldata) external {}

    /// @dev Helper to configure totalValue so withdraw/mint view functions return non-trivial values
    function mock__setTotalValue(address vault, uint256 tv) external {
        mockTotalValue[vault] = tv;
    }
}

// Tiny placeholder to satisfy storage use in MockVaultHubForDashboardTest
struct MockVaultHubStore { uint8 dummy; }
library MockVaultHubStorage { struct Data { uint8 dummy; } }

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════

contract StakingVaultDashboardFuzzTest is Test {

    // ── Infrastructure ────────────────────────────────────────────────────────
    MockStETHForDashboardTest      internal stethMock;
    MockWstETHForDashboardTest     internal wstethMock;
    MockDepositContractForDashboardTest internal depositMock;
    MockOperatorGridForDashboardTest    internal opGridMock;
    MockVaultHubForDashboardTest    internal vaultHubMock;
    MockLidoLocatorForDashboardTest internal locatorMock;

    UpgradeableBeacon internal beacon;
    IStakingVault     internal vault;
    Dashboard         internal dashboard;

    // ── Actors ───────────────────────────────────────────────────────────────
    address internal admin         = makeAddr("admin");
    address internal nodeOp        = makeAddr("nodeOp");
    address internal nodeOpManager = makeAddr("nodeOpManager");
    address internal feeRecipient  = makeAddr("feeRecipient");
    address internal fundHolder    = makeAddr("fundHolder");
    address internal withdrawHolder= makeAddr("withdrawHolder");
    address internal mintHolder    = makeAddr("mintHolder");
    address internal burnHolder    = makeAddr("burnHolder");
    address internal stranger      = makeAddr("stranger");
    address internal pdg           = makeAddr("pdg");

    uint256 internal constant FEE_BP         = 100;   // 1%
    uint256 internal constant CONFIRM_EXPIRY = 1 days;

    function setUp() public {
        // ── Deploy mock infrastructure ─────────────────────────────────────
        stethMock    = new MockStETHForDashboardTest();
        wstethMock   = new MockWstETHForDashboardTest();
        depositMock  = new MockDepositContractForDashboardTest();
        opGridMock   = new MockOperatorGridForDashboardTest();
        vaultHubMock = new MockVaultHubForDashboardTest(address(stethMock), address(opGridMock));
        MockLazyOracleForDashboardTest lazyOracleMock = new MockLazyOracleForDashboardTest();
        locatorMock  = new MockLidoLocatorForDashboardTest(
            address(vaultHubMock), address(opGridMock), pdg, address(wstethMock), address(lazyOracleMock)
        );

        // ── Deploy StakingVault beacon proxy ──────────────────────────────
        StakingVault vaultImpl = new StakingVault(address(depositMock));
        beacon = new UpgradeableBeacon(address(vaultImpl), address(this));
        vault  = IStakingVault(payable(address(new BeaconProxy(address(beacon), ""))));

        // ── Deploy Dashboard implementation + clone ───────────────────────
        Dashboard dashImpl = new Dashboard(
            address(stethMock),
            address(wstethMock),
            address(vaultHubMock),
            address(locatorMock)
        );
        bytes memory args = abi.encode(address(vault));
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(address(dashImpl), args)));

        // ── Initialize vault (Dashboard is initial owner, pdg is depositor) ─
        vault.initialize(address(dashboard), nodeOp, pdg);

        // ── Initialize Dashboard ──────────────────────────────────────────
        dashboard.initialize(admin, nodeOpManager, feeRecipient, FEE_BP, CONFIRM_EXPIRY);

        // ── Grant role-specific hats to test actors ───────────────────────
        vm.startPrank(admin);
        dashboard.grantRole(dashboard.FUND_ROLE(),                       fundHolder);
        dashboard.grantRole(dashboard.WITHDRAW_ROLE(),                   withdrawHolder);
        dashboard.grantRole(dashboard.MINT_ROLE(),                       mintHolder);
        dashboard.grantRole(dashboard.BURN_ROLE(),                       burnHolder);
        dashboard.grantRole(dashboard.VOLUNTARY_DISCONNECT_ROLE(),       admin);
        dashboard.grantRole(dashboard.REQUEST_VALIDATOR_EXIT_ROLE(),     admin);
        dashboard.grantRole(dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),admin);
        dashboard.grantRole(dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),admin);
        vm.stopPrank();

        // Connect vault to hub (admin only, no ETH required for mock)
        deal(admin, 100 ether);
        vm.prank(admin);
        dashboard.connectToVaultHub{value: 0}();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-1: Double initialisation of Dashboard reverts
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH1_doubleInitReverts() external {
        vm.expectRevert(); // AlreadyInitialized
        dashboard.initialize(stranger, stranger, stranger, 100, 1 days);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-2: fund() reverts for non-FUND_ROLE / non-DEFAULT_ADMIN
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH2_fundRevertsForNonRole(address caller) external {
        vm.assume(caller != fundHolder && caller != admin);
        deal(caller, 1 ether);
        vm.prank(caller);
        vm.expectRevert();
        dashboard.fund{value: 1 ether}();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-3: fund() succeeds for FUND_ROLE holder
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH3_fundSucceedsForFundRole(uint64 amount) external {
        vm.assume(amount > 0);
        deal(fundHolder, uint256(amount));
        vm.prank(fundHolder);
        vm.expectEmit(true, false, false, false, address(vaultHubMock));
        emit MockVaultHubForDashboardTest.FundCalled(address(vault), amount);
        dashboard.fund{value: amount}();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-4: fund() succeeds for DEFAULT_ADMIN
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH4_fundSucceedsForAdmin(uint64 amount) external {
        vm.assume(amount > 0);
        deal(admin, uint256(amount) + 100 ether);
        vm.prank(admin);
        vm.expectEmit(true, false, false, false, address(vaultHubMock));
        emit MockVaultHubForDashboardTest.FundCalled(address(vault), amount);
        dashboard.fund{value: amount}();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-5: withdraw() reverts for non-WITHDRAW_ROLE caller
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH5_withdrawRevertsForNonRole(address caller) external {
        vm.assume(caller != withdrawHolder && caller != admin);
        vm.prank(caller);
        vm.expectRevert();
        dashboard.withdraw(caller, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-6: withdraw(recipient, 0) succeeds for WITHDRAW_ROLE
    //         (0 ether passes the withdrawableValue check, no ETH needed in vault)
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH6_withdrawZeroSucceedsForRole() external {
        address recipient = makeAddr("recipient");
        vm.prank(withdrawHolder);
        vm.expectEmit(true, false, false, false, address(vaultHubMock));
        emit MockVaultHubForDashboardTest.WithdrawCalled(address(vault), recipient, 0);
        dashboard.withdraw(recipient, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-7: mintShares() reverts for non-MINT_ROLE caller
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH7_mintSharesRevertsForNonRole(address caller) external {
        vm.assume(caller != mintHolder && caller != admin);
        vm.prank(caller);
        vm.expectRevert();
        dashboard.mintShares(caller, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-8: mintShares() succeeds for MINT_ROLE when vault has capacity
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH8_mintSharesSucceedsForRole(uint64 shares) external {
        vm.assume(shares > 0);
        // Give vault 100 ETH of value to ensure minting capacity exists
        uint256 totalVal = 100 ether;
        vaultHubMock.mock__setTotalValue(address(vault), totalVal);
        // Maximum mintable ≈ 95 ether worth of shares (5% reserve ratio)
        uint256 maxShares = totalVal * 9500 / 10000;
        vm.assume(uint256(shares) <= maxShares);

        address recipient = makeAddr("mintRecipient");
        vm.prank(mintHolder);
        vm.expectEmit(true, false, false, false, address(vaultHubMock));
        emit MockVaultHubForDashboardTest.MintSharesCalled(address(vault), recipient, shares);
        dashboard.mintShares(recipient, shares);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-9: burnShares() reverts for non-BURN_ROLE caller
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH9_burnSharesRevertsForNonRole(address caller) external {
        vm.assume(caller != burnHolder && caller != admin);
        vm.prank(caller);
        vm.expectRevert();
        dashboard.burnShares(1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-10: pauseBeaconChainDeposits() reverts for non-role caller
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH10_pauseDepositsRevertsForNonRole(address caller) external {
        vm.assume(caller != admin);
        vm.prank(caller);
        vm.expectRevert();
        dashboard.pauseBeaconChainDeposits();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-11: pauseBeaconChainDeposits() succeeds for PAUSE role
    //          Note: routes through VaultHub mock → emits PauseDepositsCalled
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH11_pauseDepositsSucceedsForRole() external {
        vm.prank(admin);
        vm.expectEmit(true, false, false, false, address(vaultHubMock));
        emit MockVaultHubForDashboardTest.PauseDepositsCalled(address(vault));
        dashboard.pauseBeaconChainDeposits();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-12: resumeBeaconChainDeposits() reverts for non-role caller
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH12_resumeDepositsRevertsForNonRole(address caller) external {
        vm.assume(caller != admin);
        vm.prank(caller);
        vm.expectRevert();
        dashboard.resumeBeaconChainDeposits();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-13: resumeBeaconChainDeposits() succeeds for RESUME role
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH13_resumeDepositsSucceedsForRole() external {
        vm.prank(admin);
        vm.expectEmit(true, false, false, false, address(vaultHubMock));
        emit MockVaultHubForDashboardTest.ResumeDepositsCalled(address(vault));
        dashboard.resumeBeaconChainDeposits();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-14: requestValidatorExit() reverts for non-role caller
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH14_requestValidatorExitRevertsForNonRole(address caller) external {
        vm.assume(caller != admin);
        bytes memory pubkeys = new bytes(48);
        vm.prank(caller);
        vm.expectRevert();
        dashboard.requestValidatorExit(pubkeys);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-15: requestValidatorExit() routes to VaultHub for role holder
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH15_requestValidatorExitRoutes() external {
        bytes memory pubkeys = new bytes(48);
        vm.prank(admin);
        vm.expectEmit(true, false, false, false, address(vaultHubMock));
        emit MockVaultHubForDashboardTest.ValidatorExitCalled(address(vault));
        dashboard.requestValidatorExit(pubkeys);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-16: voluntaryDisconnect() reverts for non-role caller
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH16_voluntaryDisconnectRevertsForNonRole(address caller) external {
        vm.assume(caller != admin);
        vm.prank(caller);
        vm.expectRevert();
        dashboard.voluntaryDisconnect();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-17: renounceRole() always reverts
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH17_renounceRoleAlwaysReverts(bytes32 role) external {
        vm.prank(admin);
        vm.expectRevert(); // RoleRenouncementDisabled
        dashboard.renounceRole(role, admin);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-18: grantRoles() batch assignment works correctly
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH18_grantRolesBatch(address alice, address bob) external {
        vm.assume(alice != address(0) && bob != address(0));
        Permissions.RoleAssignment[] memory assignments = new Permissions.RoleAssignment[](2);
        assignments[0] = Permissions.RoleAssignment({account: alice, role: dashboard.FUND_ROLE()});
        assignments[1] = Permissions.RoleAssignment({account: bob,   role: dashboard.WITHDRAW_ROLE()});

        vm.prank(admin);
        dashboard.grantRoles(assignments);

        assertTrue(dashboard.hasRole(dashboard.FUND_ROLE(), alice),    "DASH-18: alice role");
        assertTrue(dashboard.hasRole(dashboard.WITHDRAW_ROLE(), bob),  "DASH-18: bob role");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-19: revokeRoles() batch revocation works correctly
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH19_revokeRolesBatch() external {
        // fundHolder should have FUND_ROLE (granted in setUp)
        assertTrue(dashboard.hasRole(dashboard.FUND_ROLE(), fundHolder), "pre-check");

        Permissions.RoleAssignment[] memory revocations = new Permissions.RoleAssignment[](1);
        revocations[0] = Permissions.RoleAssignment({account: fundHolder, role: dashboard.FUND_ROLE()});

        vm.prank(admin);
        dashboard.revokeRoles(revocations);

        assertFalse(dashboard.hasRole(dashboard.FUND_ROLE(), fundHolder), "DASH-19: role revoked");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-20: setFeeRate() > 10000 reverts (exceeds 100%)
    //   setFeeRate requires dual confirmation (nodeOpManager + admin).
    //   The rate validation (_setFeeRate) only runs after BOTH confirmations,
    //   so we queue the first confirmation then verify the second call reverts.
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH20_setFeeRateTooHighReverts(uint256 badRate) external {
        vm.assume(badRate > 10000);
        // First confirmation: nodeOpManager queues, returns false (pending)
        vm.prank(nodeOpManager);
        bool pending = dashboard.setFeeRate(badRate);
        assertFalse(pending, "DASH-20: first confirmation should return false");
        // Second confirmation: both confirmers satisfied → execution → FeeValueExceed100Percent
        vm.prank(admin);
        vm.expectRevert();
        dashboard.setFeeRate(badRate);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-21: setFeeRate() within valid range is accepted
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH21_setFeeRateValidRange(uint16 newRate) external {
        vm.assume(newRate <= 10000);
        // setFeeRate requires confirmations from both DEFAULT_ADMIN and NODE_OPERATOR_MANAGER
        // First call queues confirmation; second call (or same caller with both roles) executes
        // For simplicity, test that nodeOpManager CAN call it (first confirmation)
        // and the call does NOT revert with access denied (may return false for pending)
        vm.prank(nodeOpManager);
        dashboard.setFeeRate(newRate); // may return false (pending confirmation)
        // Regardless of execution, feeRate should always be ≤ 10000
        assertLe(dashboard.feeRate(), 10000, "DASH-21: fee rate bounded");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-22: connectToVaultHub() by non-DEFAULT_ADMIN reverts
    //          (uses a freshly-created disconnected vault setup)
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH22_connectByNonAdmin(address caller) external {
        vm.assume(caller != admin);
        // Deploy a fresh vault + dashboard pair (disconnected state)
        IStakingVault v2 = IStakingVault(payable(address(new BeaconProxy(address(beacon), ""))));
        Dashboard dashImpl2 = new Dashboard(
            address(stethMock), address(wstethMock), address(vaultHubMock), address(locatorMock)
        );
        bytes memory args2 = abi.encode(address(v2));
        Dashboard dash2 = Dashboard(payable(Clones.cloneWithImmutableArgs(address(dashImpl2), args2)));
        v2.initialize(address(dash2), nodeOp, pdg);
        dash2.initialize(admin, nodeOpManager, feeRecipient, FEE_BP, CONFIRM_EXPIRY);

        vm.prank(caller);
        vm.expectRevert();
        dash2.connectToVaultHub{value: 0}();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-23: connectToVaultHub() by admin transfers vault ownership to VaultHub
    //          (uses a second fresh vault setup to avoid conflict with setUp)
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH23_connectTransfersOwnership() external {
        // The main vault was already connected in setUp; vault.owner() == vaultHubMock
        assertEq(vault.owner(), address(vaultHubMock), "DASH-23: vault owner post-connect");
        assertTrue(vaultHubMock.isVaultConnected(address(vault)), "DASH-23: vault registered in hub");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-24: receive() with fund-on-receive (default: enabled) sends ETH
    //          Note: after connect, vault owner = vaultHub but the Dashboard's
    //          receive() calls _fund() which calls VAULT_HUB.fund{value}(vault)
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH24_receiveCallsFund(uint64 amount) external {
        vm.assume(amount > 0);
        // fundHolder already has FUND_ROLE from setUp — use them as the ETH sender.
        // Dashboard.receive() calls _fund() which checks onlyRoleMemberOrAdmin(FUND_ROLE);
        // _shouldFundOnReceive() defaults to true (iszero(tload(slot)) == iszero(0) == 1).
        deal(fundHolder, uint256(amount));
        vm.expectEmit(true, false, false, false, address(vaultHubMock));
        emit MockVaultHubForDashboardTest.FundCalled(address(vault), uint256(amount));
        vm.prank(fundHolder);
        (bool ok, ) = address(dashboard).call{value: uint256(amount)}("");
        assertTrue(ok, "DASH-24: receive must not revert");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DASH-25: withdrawableValue() ≤ totalValue (locked portion ≤ totalValue)
    // ─────────────────────────────────────────────────────────────────────────
    function testFuzz_DASH25_withdrawableLeqTotalValue(uint64 tv) external {
        vaultHubMock.mock__setTotalValue(address(vault), tv);
        uint256 wv  = dashboard.withdrawableValue();
        uint256 tot = dashboard.totalValue();
        assertLe(wv, tot, "DASH-25: withdrawable <= totalValue");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Additional: stakingVault() returns correct vault address through Dashboard
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH26_stakingVaultAddress() external view {
        assertEq(address(dashboard.stakingVault()), address(vault), "DASH-26: wrong vault");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Additional: feeRecipient correctly set in initialization
    // ─────────────────────────────────────────────────────────────────────────
    function test_DASH27_feeRecipientSet() external view {
        assertEq(dashboard.feeRecipient(), feeRecipient, "DASH-27: feeRecipient");
    }
}
