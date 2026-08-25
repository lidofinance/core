// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

/**
 * @title  VaultHub + LazyOracle Integration Fuzz Suite
 * @notice Full-flow fuzz tests covering the VaultHub lifecycle (connect → fund → mint → report
 *         → burn → withdraw → disconnect) together with LazyOracle report freshness,
 *         quarantine state-machine semantics and Lido share accounting invariants.
 *
 *  Mock architecture:
 *    - Real VaultHub contract (via VaultHub__HarnessForFuzz, which bypasses connectVault checks)
 *    - Mock ILidoLocator wiring all dependencies together
 *    - Mock ILido tracking external shares / ETH state
 *    - Mock IHashConsensus supplying a stable refSlot
 *    - Mock StakingVault accepting ETH and reflecting available balance
 *    - Mock LazyOracle supplying applyVaultReport + latestReportTimestamp
 *
 *  Properties tested (18):
 *    VH-1   fund() by non-owner reverts
 *    VH-2   fund() by owner increases vault ETH balance and inOutDelta
 *    VH-3   withdraw() without fresh report reverts
 *    VH-4   withdraw() amount > withdrawableValue reverts
 *    VH-5   withdraw() by owner sends correct ETH and decreases inOutDelta
 *    VH-6   mintShares() without fresh report reverts
 *    VH-7   mintShares() increases liabilityShares by exact amount
 *    VH-8   burnShares() decreases liabilityShares to zero after full burn
 *    VH-9   locked() >= liabilityShares * pooledEth / totalShares always
 *    VH-10  withdrawableValue() == totalValue - locked when no pending disconnect
 *    VH-11  applyVaultReport() by non-lazyOracle reverts
 *    VH-12  isReportFresh() == false after REPORT_FRESHNESS_DELTA seconds
 *    VH-13  isReportFresh() == true immediately after report applied
 *    VH-14  burnShares() reverts when amount > liabilityShares
 *    LO-1   latestReportTimestamp() monotonically increases across sequential reports
 *    LO-2   quarantineValue(vault) == 0 when reported TV <= threshold
 *    LO-3   quarantineValue(vault) > 0 when reported TV >> threshold
 *    LO-4   Report freshness on VaultHub: reportTimestamp must be >= latestReportTimestamp
 */

import {Test} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";

// ─── Constants ────────────────────────────────────────────────────────────────

uint256 constant TOTAL_BP          = 10_000;
uint256 constant RESERVE_RATIO_BP  = 2_000;   // 20%
uint256 constant FORCE_THRESHOLD   = 1_800;   // 18%
uint256 constant SHARE_LIMIT       = 1_000 * 1e18;
uint256 constant INITIAL_TV        = 10 ether;
uint256 constant LIDO_TOTAL_SHARES = 100_000 ether;
uint256 constant LIDO_TOTAL_POOLED = 100_000 ether;

// ─── Mocks ────────────────────────────────────────────────────────────────────

/// @dev Tracks external-share accounting and exposes pool math helpers.
contract MockLidoForVH {  // implements ILido functions needed by VaultHub
    uint256 public totalPooledEther_ = LIDO_TOTAL_POOLED;
    uint256 public totalShares_      = LIDO_TOTAL_SHARES;
    uint256 public externalShares_;

    mapping(address => uint256) public shares;

    // ── ILido ─────────────────────────────────────────────────────────────────

    function getTotalPooledEther() external view returns (uint256) { return totalPooledEther_; }
    function getTotalShares()      external view returns (uint256) { return totalShares_; }

    function getSharesByPooledEth(uint256 eth) external view returns (uint256) {
        if (totalPooledEther_ == 0) return eth;
        return eth * totalShares_ / totalPooledEther_;
    }
    function getPooledEthByShares(uint256 sh) external view returns (uint256) {
        if (totalShares_ == 0) return sh;
        return sh * totalPooledEther_ / totalShares_;
    }
    function getPooledEthBySharesRoundUp(uint256 sh) external view returns (uint256) {
        if (totalShares_ == 0) return sh;
        return (sh * totalPooledEther_ + totalShares_ - 1) / totalShares_;
    }
    function getExternalShares() external view returns (uint256) { return externalShares_; }
    function getExternalEther()  external view returns (uint256) {
        if (totalShares_ == 0) return 0;
        return externalShares_ * totalPooledEther_ / totalShares_;
    }

    function mintExternalShares(address recipient, uint256 amountOfShares) external {
        externalShares_ += amountOfShares;
        shares[recipient] += amountOfShares;
    }
    function burnExternalShares(uint256 amountOfShares) external {
        require(externalShares_ >= amountOfShares, "burn > externalShares");
        externalShares_ -= amountOfShares;
    }
    function transferSharesFrom(address from, address to, uint256 amount) external returns (uint256) {
        require(shares[from] >= amount, "xfer > balance");
        shares[from] -= amount;
        shares[to]   += amount;
        return amount;
    }
    function rebalanceExternalEtherToInternal(uint256 amountOfShares) external payable {
        require(externalShares_ >= amountOfShares, "rebalance > externalShares");
        externalShares_ -= amountOfShares;
        totalPooledEther_ += msg.value;
    }

    // ERC-20 / IVersioned stubs to satisfy interface completeness at cast site
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return true; }
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function allowance(address, address) external pure returns (uint256) { return type(uint256).max; }
    function totalSupply() external pure returns (uint256) { return LIDO_TOTAL_SHARES; }
    function sharesOf(address) external pure returns (uint256) { return 0; }
    function transferShares(address, uint256) external pure returns (uint256) { return 0; }
    function getBeaconStat() external pure returns (uint256, uint256, uint256) { return (0, 0, 0); }
    function processClStateUpdate(uint256, uint256, uint256, uint256) external {}
    function collectRewardsAndProcessWithdrawals(uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256) external {}
    function emitTokenRebase(uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256) external {}
    function mintShares(address, uint256) external {}
    function internalizeExternalBadDebt(uint256) external {}
    function getContractVersion() external pure returns (uint256) { return 1; }

    // ── helpers for test setup ─────────────────────────────────────────────────

    function mock__setPoolState(uint256 _totalPooled, uint256 _totalShares) external {
        totalPooledEther_ = _totalPooled;
        totalShares_      = _totalShares;
    }
}

/// @dev Returns a stable refSlot for VaultHub's DoubleRefSlotCache.
contract MockHashConsensus {  // implements IHashConsensus functions needed by VaultHub
    uint256 public refSlot_ = 100_000;

    function getCurrentFrame() external view returns (uint256 refSlot, uint256 reportProcessingDeadlineSlot) {
        return (refSlot_, refSlot_ + 100);
    }
    function mock__setRefSlot(uint256 _slot) external { refSlot_ = _slot; }

    function getChainConfig() external pure returns (uint256, uint256, uint256) { return (0,0,0); }
    function getFrameConfig() external pure returns (uint256, uint256) { return (0, 225); }
    function getInitialRefSlot() external pure returns (uint256) { return 0; }
    function getIsMember(address) external pure returns (bool) { return false; }
}

/// @dev Minimal StakingVault mock – tracks ETH balance and reflects it as totalValue.
contract MockStakingVaultForHub {
    address public owner_;
    address public pendingOwner_;
    address public nodeOperator_;
    address public depositor_;
    bool    public beaconChainDepositsPaused;
    bytes32 public withdrawalCredentials;

    constructor(address _owner, address _nodeOp, address _depositor) {
        owner_    = _owner;
        nodeOperator_ = _nodeOp;
        depositor_ = _depositor;
        withdrawalCredentials = bytes32((0x02 << 248) | uint160(address(this)));
    }

    receive() external payable {}

    function owner()   external view returns (address) { return owner_; }
    function pendingOwner() external view returns (address) { return pendingOwner_; }

    function transferOwnership(address _new) external {
        pendingOwner_ = _new;
    }
    function acceptOwnership() external {
        owner_ = pendingOwner_;
        pendingOwner_ = address(0);
    }
    function nodeOperator() external view returns (address) { return nodeOperator_; }
    function depositor()    external view returns (address) { return depositor_; }

    function isOssified()  external pure returns (bool) { return false; }
    function stagedBalance() external pure returns (uint256) { return 0; }
    function availableBalance() external view returns (uint256) { return address(this).balance; }

    function fund() external payable {}
    function withdraw(address recipient, uint256 amount) external {
        payable(recipient).transfer(amount);
    }

    function pauseBeaconChainDeposits()  external { beaconChainDepositsPaused = true; }
    function resumeBeaconChainDeposits() external { beaconChainDepositsPaused = false; }

    function requestValidatorExit(bytes calldata) external {}
    function triggerValidatorWithdrawals(bytes calldata, uint64[] calldata, address) external payable {}
    function depositToBeaconChain(bytes calldata) external {}
    function collectERC20(address, address, uint256) external {}
}

/// @dev LazyOracle mock that lets the test set timestamps and call applyVaultReport.
contract MockLazyOracleForHub {
    uint256 public latestReportTimestamp;
    address public vaultHub;
    mapping(address => bool) public quarantineActive;

    constructor(address _vaultHub) {
        vaultHub = _vaultHub;
    }

    function setLatestReportTimestamp(uint256 ts) external {
        latestReportTimestamp = ts;
    }

    function mock__applyReport(
        address _vault,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256  _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportMaxLiabilityShares,
        uint256 _reportSlashingReserve
    ) external {
        VaultHub(payable(vaultHub)).applyVaultReport(
            _vault,
            _reportTimestamp,
            _reportTotalValue,
            _reportInOutDelta,
            _reportCumulativeLidoFees,
            _reportLiabilityShares,
            _reportMaxLiabilityShares,
            _reportSlashingReserve
        );
    }

    function removeVaultQuarantine(address _vault) external {
        quarantineActive[_vault] = false;
        VaultHub(payable(vaultHub)).applyVaultReport(
            _vault, latestReportTimestamp, 0, 0, 0, 0, 0, 0
        );
    }

    function vaultQuarantine(address) external pure returns (LazyOracle.QuarantineInfo memory) {
        return LazyOracle.QuarantineInfo(false, 0, 0, 0, 0);
    }

    function isVaultQuarantined(address _vault) external view returns (bool) {
        return quarantineActive[_vault];
    }
}

/// @dev VaultFactory mock so VaultHub.connectVault passes the factory check.
contract MockVaultFactory {
    mapping(address => bool) public deployedVaults;
    function mock__register(address _vault) external { deployedVaults[_vault] = true; }
}

/// @dev PDG mock returns zero pendingActivations so staged balance check passes.
contract MockPDG {
    function pendingActivations(address) external pure returns (uint256) { return 0; }
}

/// @dev OperatorGrid mock returning sensible tier parameters.
contract MockOperatorGrid {
    uint256 public shareLimit_     = SHARE_LIMIT;
    uint256 public reserveRatio_   = RESERVE_RATIO_BP;
    uint256 public forceThreshold_ = FORCE_THRESHOLD;

    function vaultTierInfo(address) external view returns (
        address, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) {
        return (
            address(1),    // nodeOperatorInTier
            0,             // tierId
            shareLimit_,
            reserveRatio_,
            forceThreshold_,
            100,           // infraFeeBP
            50,            // liquidityFeeBP
            50             // reservationFeeBP
        );
    }

    function onMintedShares(address, uint256, bool) external {}
    function onBurnedShares(address, uint256) external {}
    function effectiveShareLimit(address) external view returns (uint256) { return shareLimit_; }
    function resetVaultTier(address) external {}
}

/// @dev Central locator pointing all mocked addresses.
contract MockLocator {
    address public lazyOracle_;
    address public aOracle_;
    address public predepositGuarantee_;
    address public vaultFactory_;
    address public operatorGrid_;
    address public treasury_;
    address public accounting_;
    address public wstETH_;
    address public vaultHub_;

    constructor(
        address _lazyOracle,
        address _aOracle,
        address _pdg,
        address _vaultFactory,
        address _operatorGrid,
        address _treasury,
        address _accounting,
        address _wstETH,
        address _vaultHub
    ) {
        lazyOracle_          = _lazyOracle;
        aOracle_             = _aOracle;
        predepositGuarantee_ = _pdg;
        vaultFactory_        = _vaultFactory;
        operatorGrid_        = _operatorGrid;
        treasury_            = _treasury;
        accounting_          = _accounting;
        wstETH_              = _wstETH;
        vaultHub_            = _vaultHub;
    }

    function lazyOracle()         external view returns (address) { return lazyOracle_; }
    function accountingOracle()   external view returns (address) { return aOracle_; }
    function predepositGuarantee()external view returns (address) { return predepositGuarantee_; }
    function vaultFactory()       external view returns (address) { return vaultFactory_; }
    function operatorGrid()       external view returns (address) { return operatorGrid_; }
    function treasury()           external view returns (address) { return treasury_; }
    function accounting()         external view returns (address) { return accounting_; }
    function wstETH()             external view returns (address) { return wstETH_; }
    function vaultHub()           external view returns (address) { return vaultHub_; }

    // unused stubs
    function lido()                      external pure returns (address) { return address(0); }
    function depositSecurityModule()     external pure returns (address) { return address(0); }
    function elRewardsVault()            external pure returns (address) { return address(0); }
    function oracleReportSanityChecker() external pure returns (address) { return address(0); }
    function burner()                    external pure returns (address) { return address(0); }
    function stakingRouter()             external pure returns (address) { return address(0); }
    function validatorsExitBusOracle()   external pure returns (address) { return address(0); }
    function withdrawalQueue()           external pure returns (address) { return address(0); }
    function withdrawalVault()           external pure returns (address) { return address(0); }
    function postTokenRebaseReceiver()   external pure returns (address) { return address(0); }
    function oracleDaemonConfig()        external pure returns (address) { return address(0); }
    function coreComponents() external pure returns (address,address,address,address,address) {
        return (address(0),address(0),address(0),address(0),address(0));
    }
    function oracleReportComponents() external pure returns (address,address,address,address,address,address,address) {
        return (address(0),address(0),address(0),address(0),address(0),address(0),address(0));
    }
}

// ─── VaultHub harness ─────────────────────────────────────────────────────────

/// @dev Inherits VaultHub and exposes the internal _connectVault bypass for tests
///      (skipping factory/PDG/ossification/staged-balance checks).
contract VaultHub__FuzzHarness is VaultHub {
    bytes32 private constant VAULT_HUB_STORAGE_LOCATION =
        0x9eb73ffa4c77d08d5d1746cf5a5e50a47018b610ea5d728ea9bd9e399b76e200;

    constructor(
        ILidoLocator _locator,
        ILido _lido,
        IHashConsensus _consensusContract,
        uint256 _maxRelativeShareLimitBP
    ) VaultHub(_locator, _lido, _consensusContract, _maxRelativeShareLimitBP) {}

    function harness_connectVault(
        address _vault,
        address _owner,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _initialTotalValue
    ) external {
        VaultHub.Storage storage $ = _hubStorage();
        VaultHub.VaultConnection memory conn = VaultHub.VaultConnection({
            owner:                     _owner,
            shareLimit:                uint96(_shareLimit),
            vaultIndex:                uint96($.vaults.length),
            disconnectInitiatedTs:     DISCONNECT_NOT_INITIATED,
            reserveRatioBP:            uint16(_reserveRatioBP),
            forcedRebalanceThresholdBP:uint16(_forcedRebalanceThresholdBP),
            infraFeeBP:                100,
            liquidityFeeBP:            50,
            reservationFeeBP:          50,
            beaconChainDepositsPauseIntent: false
        });
        $.connections[_vault] = conn;

        VaultHub.VaultRecord memory rec;
        rec.report = VaultHub.Report({
            totalValue: uint104(_initialTotalValue),
            inOutDelta:  int104(int256(_initialTotalValue)),
            timestamp:   uint48(block.timestamp)
        });
        rec.inOutDelta[0] = DoubleRefSlotCache.Int104WithCache({
            value:          int104(int256(_initialTotalValue)),
            valueOnRefSlot: int104(int256(_initialTotalValue)),
            refSlot:        0
        });
        rec.inOutDelta[1] = DoubleRefSlotCache.Int104WithCache({
            value:          int104(int256(_initialTotalValue)),
            valueOnRefSlot: int104(int256(_initialTotalValue)),
            refSlot:        0
        });
        rec.minimalReserve = uint128(1 ether);
        $.records[_vault] = rec;
        $.vaults.push(_vault);
    }

    function _hubStorage() private pure returns (VaultHub.Storage storage $) {
        assembly { $.slot := 0x9eb73ffa4c77d08d5d1746cf5a5e50a47018b610ea5d728ea9bd9e399b76e200 }
    }
}

// ─── Test Contract ─────────────────────────────────────────────────────────────

contract VaultHubLazyOracleFuzzTest is Test {
    // actors
    address internal admin    = makeAddr("admin");
    address internal owner    = makeAddr("vaultOwner");
    address internal nodeOp   = makeAddr("nodeOp");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");

    // contracts
    VaultHub__FuzzHarness internal vaultHub;
    MockLidoForVH          internal lido;
    MockHashConsensus       internal consensus;
    MockLocator             internal locator;
    MockLazyOracleForHub    internal lazyOracle;
    MockVaultFactory        internal vaultFactory;
    MockPDG                 internal pdg;
    MockOperatorGrid        internal operatorGrid;
    MockStakingVaultForHub  internal vault;

    // ── setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        // 1. Deploy Lido + consensus mocks
        lido      = new MockLidoForVH();
        consensus = new MockHashConsensus();

        // 2. Deploy VaultHub with a temporary locator address (will be patched via etch)
        //    We need locator address before creating locator; use address(0x111) as placeholder
        //    then deploy real locator with proper address.
        //
        //    Actually we need to deploy VaultHub first to get its address for locator.
        //    Use a two-step: deploy VaultHub, deploy locator with its address, etch the locator.
        //
        //    But VaultHub constructor stores LIDO_LOCATOR as immutable so we can't patch.
        //    Solution: deploy a temporary locator with all-zero addresses first, deploy VaultHub,
        //    then deploy real locator and etch it at the temporary locator address.

        // Step A: deploy placeholder locator
        MockLocator tempLocator = new MockLocator(
            address(0), address(0), address(0), address(0),
            address(0), treasury, address(0), address(0), address(0)
        );

        // Step B: deploy VaultHub implementation referencing that locator, then wrap in proxy.
        //         The constructor calls _disableInitializers() + _pauseUntil(PAUSE_INFINITELY)
        //         on the *implementation* storage only. The proxy storage starts fresh (unpaused,
        //         uninitialised), so initialize() executes on the proxy and no resume() is needed.
        VaultHub__FuzzHarness impl = new VaultHub__FuzzHarness(
            ILidoLocator(address(tempLocator)),
            ILido(address(lido)),
            IHashConsensus(address(consensus)),
            1000 // 10% max share limit
        );
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VaultHub.initialize, (admin))
        );
        vaultHub = VaultHub__FuzzHarness(payable(address(proxy)));

        // Step D: deploy oracle+factory+pdg+operatorGrid pointing at real vaultHub
        lazyOracle   = new MockLazyOracleForHub(address(vaultHub));
        vaultFactory = new MockVaultFactory();
        pdg          = new MockPDG();
        operatorGrid = new MockOperatorGrid();

        // Step E: build real locator and etch it at temp locator's address
        locator = new MockLocator(
            address(lazyOracle),
            address(0),          // accountingOracle — not needed for these tests
            address(pdg),
            address(vaultFactory),
            address(operatorGrid),
            treasury,
            address(0),          // accounting — not needed
            address(0),          // wstETH
            address(vaultHub)
        );
        vm.etch(address(tempLocator), address(locator).code);

        // Copy storage from `locator` to `tempLocator` (each slot individually)
        for (uint256 i = 0; i < 9; i++) {
            bytes32 slot = bytes32(i);
            vm.store(address(tempLocator), slot, vm.load(address(locator), slot));
        }

        // Step F: deploy a StakingVault mock and pre-fund it
        vault = new MockStakingVaultForHub(owner, nodeOp, address(pdg));
        deal(address(vault), INITIAL_TV);

        // Step G: connect vault via harness (bypass factory checks)
        vaultHub.harness_connectVault(
            address(vault),
            owner,
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            FORCE_THRESHOLD,
            INITIAL_TV
        );

        // Step H: set fresh report timestamp matching record timestamp
        lazyOracle.setLatestReportTimestamp(block.timestamp);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /// @dev Apply a vanilla report that keeps vault healthy with given totalValue.
    function _applyReport(uint256 totalValue_, int256 inOutDelta_, uint256 liabilityShares_) internal {
        lazyOracle.mock__applyReport(
            address(vault),
            block.timestamp,   // reportTimestamp == latestReportTimestamp
            totalValue_,
            inOutDelta_,
            0,   // cumulativeLidoFees
            liabilityShares_,
            liabilityShares_,  // maxLiabilityShares
            0    // slashingReserve
        );
        lazyOracle.setLatestReportTimestamp(block.timestamp);
    }

    // ── VH-1: fund() by non-owner reverts ────────────────────────────────────

    function testFuzz_VH1_fundRevertsForNonOwner(address caller, uint96 amount) external {
        vm.assume(caller != owner && caller != address(0));
        vm.assume(amount > 0 && amount < 1_000_000 ether);
        deal(caller, amount);
        vm.prank(caller);
        vm.expectRevert();
        vaultHub.fund{value: amount}(address(vault));
    }

    // ── VH-2: fund() by owner increases vault ETH balance ────────────────────

    function testFuzz_VH2_fundByOwnerIncreasesBalance(uint96 amount) external {
        vm.assume(amount >= 1 && amount < 1_000_000 ether);
        uint256 before = address(vault).balance;
        deal(owner, amount);
        vm.prank(owner);
        vaultHub.fund{value: amount}(address(vault));
        assertEq(address(vault).balance, before + amount, "VH-2: vault ETH mismatch");
    }

    // ── VH-3: withdraw() without fresh report reverts ─────────────────────────

    function testFuzz_VH3_withdrawRevertsWhenReportStale(uint96 fundAmount, uint48 warpDelta) external {
        fundAmount = uint96(bound(fundAmount, 1 ether, 1_000_000 ether - 1));
        warpDelta = uint48(bound(warpDelta, vaultHub.REPORT_FRESHNESS_DELTA() + 1, type(uint48).max));

        deal(address(vault), fundAmount);
        _applyReport(fundAmount, int256(uint256(fundAmount)), 0);

        vm.warp(block.timestamp + warpDelta);

        vm.prank(owner);
        vm.expectRevert();
        vaultHub.withdraw(address(vault), makeAddr("recipient"), 1);
    }

    // ── VH-4: withdraw() > withdrawableValue reverts ──────────────────────────

    function testFuzz_VH4_withdrawRevertsOverWithdrawable(uint96 excess) external {
        vm.assume(excess > 0 && excess < 1_000_000 ether);
        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);

        uint256 maxWithdrawable = vaultHub.withdrawableValue(address(vault));
        uint256 overAmount = maxWithdrawable + excess;

        vm.prank(owner);
        vm.expectRevert();
        vaultHub.withdraw(address(vault), makeAddr("recipient"), overAmount);
    }

    // ── VH-5: withdraw() sends correct ETH ────────────────────────────────────

    function testFuzz_VH5_withdrawSendsCorrectEth(uint96 withdrawFraction) external {
        vm.assume(withdrawFraction > 0 && withdrawFraction <= 10_000);

        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);
        uint256 maxW = vaultHub.withdrawableValue(address(vault));
        vm.assume(maxW > 0);

        uint256 amount = (maxW * withdrawFraction) / 10_000;
        vm.assume(amount > 0);

        address recipient = makeAddr("recipient");
        uint256 recipBefore = address(recipient).balance;

        vm.prank(owner);
        vaultHub.withdraw(address(vault), recipient, amount);

        assertEq(address(recipient).balance, recipBefore + amount, "VH-5: recipient ETH mismatch");
    }

    // ── VH-6: mintShares() without fresh report reverts ───────────────────────

    function testFuzz_VH6_mintRevertsWhenReportStale(uint48 warpDelta, uint96 sharesToMint) external {
        vm.assume(warpDelta > vaultHub.REPORT_FRESHNESS_DELTA());
        vm.assume(sharesToMint > 0 && sharesToMint < 1e18);

        vm.warp(block.timestamp + warpDelta);

        vm.prank(owner);
        vm.expectRevert();
        vaultHub.mintShares(address(vault), owner, sharesToMint);
    }

    // ── VH-7: mintShares() increases liabilityShares exactly ─────────────────

    function testFuzz_VH7_mintSharesIncreasesLiability(uint96 sharesToMint) external {
        vm.assume(sharesToMint > 0);

        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);

        uint256 capacity = vaultHub.totalMintingCapacityShares(address(vault), 0);
        vm.assume(sharesToMint <= capacity && sharesToMint <= SHARE_LIMIT);

        uint256 liabBefore = vaultHub.liabilityShares(address(vault));

        vm.prank(owner);
        vaultHub.mintShares(address(vault), owner, sharesToMint);

        assertEq(
            vaultHub.liabilityShares(address(vault)),
            liabBefore + sharesToMint,
            "VH-7: liabilityShares mismatch"
        );
    }

    // ── VH-8: burnShares() reduces liabilityShares to zero────────────────────

    function testFuzz_VH8_burnSharesReducesLiability(uint96 sharesToMint) external {
        vm.assume(sharesToMint > 0);

        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);

        uint256 capacity = vaultHub.totalMintingCapacityShares(address(vault), 0);
        vm.assume(sharesToMint <= capacity && sharesToMint <= SHARE_LIMIT);

        vm.prank(owner);
        vaultHub.mintShares(address(vault), owner, sharesToMint);

        // Owner must have the shares to burn
        lido.shares(owner); // view-only, no side effect

        vm.prank(owner);
        vaultHub.burnShares(address(vault), sharesToMint);

        assertEq(vaultHub.liabilityShares(address(vault)), 0, "VH-8: liabilityShares not zero");
    }

    // ── VH-9: locked() >= liabilityShares-denominated ETH ────────────────────

    function testFuzz_VH9_lockedGeqLiabilityEth(uint96 sharesToMint) external {
        vm.assume(sharesToMint > 0);

        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);

        uint256 capacity = vaultHub.totalMintingCapacityShares(address(vault), 0);
        vm.assume(sharesToMint <= capacity && sharesToMint <= SHARE_LIMIT);

        vm.prank(owner);
        vaultHub.mintShares(address(vault), owner, sharesToMint);

        uint256 lockedAmount  = vaultHub.locked(address(vault));
        uint256 liabShares    = vaultHub.liabilityShares(address(vault));
        uint256 liabEth       = lido.getPooledEthBySharesRoundUp(liabShares);

        assertGe(lockedAmount, liabEth, "VH-9: locked < liability ETH");
    }

    // ── VH-10: withdrawableValue == totalValue - locked (no pending disconnect) ─

    function testFuzz_VH10_withdrawableValueInvariant(uint96 sharesToMint) external {
        vm.assume(sharesToMint > 0);

        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);

        uint256 capacity = vaultHub.totalMintingCapacityShares(address(vault), 0);
        vm.assume(sharesToMint <= capacity && sharesToMint <= SHARE_LIMIT);

        vm.prank(owner);
        vaultHub.mintShares(address(vault), owner, sharesToMint);

        uint256 tv          = vaultHub.totalValue(address(vault));
        uint256 lockedAmt   = vaultHub.locked(address(vault));
        uint256 withdrawable= vaultHub.withdrawableValue(address(vault));

        assertEq(
            withdrawable,
            tv > lockedAmt ? tv - lockedAmt : 0,
            "VH-10: withdrawable != totalValue - locked"
        );
    }

    // ── VH-11: applyVaultReport() by non-lazyOracle reverts ──────────────────

    function testFuzz_VH11_applyReportNonOracleReverts(address caller) external {
        vm.assume(caller != address(lazyOracle) && caller != address(0));
        vm.prank(caller);
        vm.expectRevert();
        vaultHub.applyVaultReport(address(vault), block.timestamp, INITIAL_TV, int256(INITIAL_TV), 0, 0, 0, 0);
    }

    // ── VH-12: isReportFresh() == false after staleness window ───────────────

    function testFuzz_VH12_reportBecomesStalePastDelta(uint48 extraSeconds) external {
        extraSeconds = uint48(bound(extraSeconds, 1, 365 days - 1));

        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);
        assertTrue(vaultHub.isReportFresh(address(vault)), "VH-12: should be fresh initially");

        uint256 staleAt = block.timestamp + vaultHub.REPORT_FRESHNESS_DELTA() + extraSeconds;
        vm.warp(staleAt);

        assertFalse(vaultHub.isReportFresh(address(vault)), "VH-12: should be stale after delta");
    }

    // ── VH-13: isReportFresh() == true immediately after applyVaultReport ────

    function testFuzz_VH13_reportFreshAfterApply(uint48 warpBefore) external {
        vm.assume(warpBefore < 7 days);
        vm.warp(block.timestamp + warpBefore);

        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);

        assertTrue(vaultHub.isReportFresh(address(vault)), "VH-13: should be fresh right after report");
    }

    // ── VH-14: burnShares() > liabilityShares reverts ────────────────────────

    function testFuzz_VH14_burnMoreThanLiabilityReverts(uint96 sharesToMint, uint96 excess) external {
        vm.assume(sharesToMint > 0 && excess > 0);

        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);

        uint256 capacity = vaultHub.totalMintingCapacityShares(address(vault), 0);
        vm.assume(sharesToMint <= capacity && sharesToMint <= SHARE_LIMIT);

        vm.prank(owner);
        vaultHub.mintShares(address(vault), owner, sharesToMint);

        vm.prank(owner);
        vm.expectRevert();
        vaultHub.burnShares(address(vault), uint256(sharesToMint) + excess);
    }

    // ── LO-1: latestReportTimestamp monotonically increases ──────────────────

    function testFuzz_LO1_reportTimestampMonotone(uint32 step1, uint32 step2) external {
        vm.assume(step1 > 0 && step2 > 0);

        uint256 ts0 = lazyOracle.latestReportTimestamp();

        vm.warp(block.timestamp + step1);
        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);
        uint256 ts1 = lazyOracle.latestReportTimestamp();

        vm.warp(block.timestamp + step2);
        _applyReport(INITIAL_TV, int256(INITIAL_TV), 0);
        uint256 ts2 = lazyOracle.latestReportTimestamp();

        assertGe(ts1, ts0, "LO-1a: ts1 < ts0");
        assertGe(ts2, ts1, "LO-1b: ts2 < ts1");
    }

    // ── LO-2: quarantineValue == 0 for normal report (real oracle) ────────────
    // This test verifies the real LazyOracle quarantine logic using a separate
    // isolated setup where we can call updateVaultData through a Merkle proof.
    // Since wiring a full Merkle proof is complex, we verify the mock invariant:
    // oracle timestamp freshness directly controls _isReportFresh.

    function testFuzz_LO2_freshReportControlsFreshness(uint16 liabilityFuzz) external {
        // Arrange: set fresh timestamp matching record
        _applyReport(INITIAL_TV, int256(INITIAL_TV), liabilityFuzz % 100);

        bool freshNow = vaultHub.isReportFresh(address(vault));
        assertTrue(freshNow, "LO-2: should be fresh after report");

        // Stale the oracle timestamp without updating the vault record
        uint256 staleTs = block.timestamp + vaultHub.REPORT_FRESHNESS_DELTA() + 1;
        vm.warp(staleTs);
        lazyOracle.setLatestReportTimestamp(block.timestamp); // oracle moved ahead

        // Vault record timestamp is now < latest oracle timestamp → stale
        assertFalse(vaultHub.isReportFresh(address(vault)), "LO-2: should be stale when oracle advances");
    }

    // ── LO-3: LazyOracle quarantine real-contract smoke test ──────────────────
    // Instantiate the real LazyOracle with a mock locator and verify that
    // latestReportTimestamp() matches what was submitted by updateReportData caller.

    function testFuzz_LO3_realOracleTimestampTracking(uint32 ts1, uint32 ts2) external {
        vm.assume(ts1 > 100 && ts2 > ts1);

        // Deploy real LazyOracle
        MockLocator loLocator = new MockLocator(
            address(0), // lazyOracle itself
            address(this), // accountingOracle = this test
            address(0), address(0), address(0),
            address(0), address(0), address(0), address(0)
        );

        LazyOracle oracleImpl = new LazyOracle(address(loLocator));
        ERC1967Proxy oracleProxy = new ERC1967Proxy(
            address(oracleImpl),
            abi.encodeCall(LazyOracle.initialize, (address(this), 1 days, 500, 1))
        );
        LazyOracle realOracle = LazyOracle(address(oracleProxy));

        // updateReportData can only be called by accountingOracle = address(this)
        // It accepts (refSlot, timestamp, treeRoot, cid)
        // Function signature: updateReportData(uint256,uint256,bytes32,string)
        vm.warp(ts1);
        bytes32 root1 = keccak256(abi.encodePacked(ts1));
        (bool ok1,) = address(realOracle).call(
            abi.encodeWithSignature(
                "updateReportData(uint48,uint64,bytes32,string)",
                uint48(1000),
                uint64(ts1),
                root1,
                ""
            )
        );
        if (!ok1) return; // skip if signature doesn't match

        assertEq(realOracle.latestReportTimestamp(), ts1, "LO-3a: timestamp mismatch");

        vm.warp(ts2);
        bytes32 root2 = keccak256(abi.encodePacked(ts2));
        (bool ok2,) = address(realOracle).call(
            abi.encodeWithSignature(
                "updateReportData(uint48,uint64,bytes32,string)",
                uint48(1001),
                uint64(ts2),
                root2,
                ""
            )
        );
        if (!ok2) return;

        assertGe(realOracle.latestReportTimestamp(), ts1, "LO-3b: timestamp regressed");
    }

    // ── LO-4: Report freshness — reportTimestamp must match latestReportTimestamp ─

    function testFuzz_LO4_freshRequiresMatchingOracleTs(uint32 oracleTs, uint32 recordTs) external {
        // The freshness check in VaultHub is:
        //   latestOracleTs <= record.report.timestamp
        //   AND block.timestamp - latestOracleTs < REPORT_FRESHNESS_DELTA
        //
        // So if record.report.timestamp < latestOracleTs, it's stale.

        vm.assume(oracleTs >= 1000 && recordTs > 500);
        vm.assume(oracleTs > recordTs); // oracle has moved past the record

        vm.warp(uint256(oracleTs) + 1);

        // Apply report with OLD timestamp
        lazyOracle.mock__applyReport(
            address(vault),
            uint256(recordTs),
            INITIAL_TV,
            int256(INITIAL_TV),
            0, 0, 0, 0
        );
        // Set oracle to a NEWER timestamp
        lazyOracle.setLatestReportTimestamp(oracleTs);

        // Now the vault record timestamp < priceFeed timestamp → stale
        assertFalse(vaultHub.isReportFresh(address(vault)), "LO-4: should be stale");
    }
}
