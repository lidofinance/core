// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

/**
 * @title  Lido External-Shares / stVaults Accounting Fuzz Suite
 * @notice Tests that VaultHub's mintShares/burnShares operations keep Lido's
 *         external-share accounting consistent and that the share-price invariant
 *         is maintained across every operation.
 *
 *  This suite uses the same VaultHub__FuzzHarness from the VaultHubLazyOracle suite
 *  but focuses exclusively on the Lido ↔ VaultHub share boundary.
 *
 *  Properties tested (8):
 *    LI-1   externalShares increases by exactly _amountOfShares after mintShares()
 *    LI-2   externalShares decreases by exactly _amountOfShares after burnShares()
 *    LI-3   externalShares never exceeds totalShares after any sequence of mints
 *    LI-4   liabilityShares(vault) == externalShares held by (vault owner) after mint
 *    LI-5   Round-trip mint then full burn returns externalShares to initial value
 *    LI-6   Share price getPooledEthByShares(getSharesByPooledEth(x)) >= x - 1 (rounding)
 *    LI-7   Multiple vaults: sum of all liabilityShares == total externalShares
 *    LI-8   burnShares larger than liabilityShares reverts (cannot overdraft)
 */

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";

// ─── Shared infrastructure (mirrors VaultHubLazyOracle.fuzz.t.sol) ───────────
// We redeclare the mocks here to keep each file self-contained and avoid
// cross-file compilation order issues.

uint256 constant LI_TOTAL_SHARES = 1_000_000 ether;
uint256 constant LI_TOTAL_POOLED = 1_000_000 ether;
uint256 constant LI_SHARE_LIMIT  = 50_000 * 1e18;
uint256 constant LI_INITIAL_TV   = 100 ether;
uint256 constant LI_RESERVE_BP   = 2_000;  // 20%
uint256 constant LI_FORCE_BP     = 1_800;  // 18%

// ─── Mocks ────────────────────────────────────────────────────────────────────

contract LI_MockLido {  // implements ILido surface used by VaultHub
    uint256 public totalPooledEther_ = LI_TOTAL_POOLED;
    uint256 public totalShares_      = LI_TOTAL_SHARES;
    uint256 public externalShares_;
    mapping(address => uint256) public shares_;

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
    function mintExternalShares(address recipient, uint256 amount) external {
        externalShares_ += amount;
        shares_[recipient] += amount;
    }
    function burnExternalShares(uint256 amount) external {
        require(externalShares_ >= amount, "burn overflow");
        externalShares_ -= amount;
    }
    function transferSharesFrom(address from, address to, uint256 amount) external returns (uint256) {
        require(shares_[from] >= amount, "xfer overflow");
        shares_[from] -= amount;
        shares_[to]   += amount;
        return amount;
    }
    function rebalanceExternalEtherToInternal(uint256 amount) external payable {
        require(externalShares_ >= amount);
        externalShares_ -= amount;
        totalPooledEther_ += msg.value;
    }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return true; }
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function allowance(address, address) external pure returns (uint256) { return type(uint256).max; }
    function totalSupply() external pure returns (uint256) { return LI_TOTAL_SHARES; }
    function sharesOf(address) external pure returns (uint256) { return 0; }
    function transferShares(address, uint256) external pure returns (uint256) { return 0; }
    function getBeaconStat() external pure returns (uint256, uint256, uint256) { return (0, 0, 0); }
    function processClStateUpdate(uint256, uint256, uint256, uint256) external {}
    function collectRewardsAndProcessWithdrawals(uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256) external {}
    function emitTokenRebase(uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256) external {}
    function mintShares(address, uint256) external {}
    function internalizeExternalBadDebt(uint256) external {}
    function getContractVersion() external pure returns (uint256) { return 1; }
}

contract LI_MockHashConsensus {  // implements IHashConsensus surface used by VaultHub
    function getCurrentFrame() external pure returns (uint256, uint256) { return (200_000, 200_100); }
    function getChainConfig() external pure returns (uint256, uint256, uint256) { return (0,0,0); }
    function getFrameConfig() external pure returns (uint256, uint256) { return (0, 225); }
    function getInitialRefSlot() external pure returns (uint256) { return 0; }
    function getIsMember(address) external pure returns (bool) { return false; }
}

contract LI_MockLazyOracle {
    uint256 public latestReportTimestamp;
    address public vaultHub;

    constructor(address _vaultHub) { vaultHub = _vaultHub; }

    function setLatestReportTimestamp(uint256 ts) external { latestReportTimestamp = ts; }

    function applyReport(
        address _vault, uint256 _ts, uint256 _tv, int256 _ioD,
        uint256 _fees, uint256 _liab, uint256 _maxLiab, uint256 _slash
    ) external {
        VaultHub(payable(vaultHub)).applyVaultReport(
            _vault, _ts, _tv, _ioD, _fees, _liab, _maxLiab, _slash
        );
    }

    function removeVaultQuarantine(address) external {}
    function vaultQuarantine(address) external pure returns (bool, uint256, uint256, uint256, uint256) {
        return (false, 0, 0, 0, 0);
    }
}

contract LI_MockVault {
    address public owner_;
    constructor(address _owner) { owner_ = _owner; }
    receive() external payable {}

    function owner()          external view returns (address) { return owner_; }
    function pendingOwner()   external pure returns (address) { return address(0); }
    function nodeOperator()   external pure returns (address) { return address(1); }
    function depositor()      external pure returns (address) { return address(1); }
    function isOssified()     external pure returns (bool)    { return false; }
    function stagedBalance()  external pure returns (uint256) { return 0; }
    function availableBalance() external view returns (uint256) { return address(this).balance; }
    function beaconChainDepositsPaused() external pure returns (bool) { return false; }

    function fund() external payable {}
    function withdraw(address recipient, uint256 amount) external { payable(recipient).transfer(amount); }
    function transferOwnership(address) external {}
    function acceptOwnership() external {}
    function pauseBeaconChainDeposits()  external {}
    function resumeBeaconChainDeposits() external {}
    function requestValidatorExit(bytes calldata) external {}
    function collectERC20(address, address, uint256) external {}
}

contract LI_MockLocator {
    address immutable public lazyOracle_;
    address immutable public operatorGrid_;
    address immutable public treasury_;

    constructor(address _lazyOracle, address _operatorGrid, address _treasury) {
        lazyOracle_   = _lazyOracle;
        operatorGrid_ = _operatorGrid;
        treasury_     = _treasury;
    }

    function lazyOracle()          external view returns (address) { return lazyOracle_; }
    function operatorGrid()        external view returns (address) { return operatorGrid_; }
    function treasury()            external view returns (address) { return treasury_; }
    function accountingOracle()    external pure returns (address) { return address(0); }
    function predepositGuarantee() external pure returns (address) { return address(0); }
    function vaultFactory()        external pure returns (address) { return address(0); }
    function accounting()          external pure returns (address) { return address(0); }
    function wstETH()              external pure returns (address) { return address(0); }
    function vaultHub()            external pure returns (address) { return address(0); }
    function lido()                external pure returns (address) { return address(0); }
    function depositSecurityModule() external pure returns (address) { return address(0); }
    function elRewardsVault()       external pure returns (address) { return address(0); }
    function oracleReportSanityChecker() external pure returns (address) { return address(0); }
    function burner()               external pure returns (address) { return address(0); }
    function stakingRouter()        external pure returns (address) { return address(0); }
    function validatorsExitBusOracle() external pure returns (address) { return address(0); }
    function withdrawalQueue()      external pure returns (address) { return address(0); }
    function withdrawalVault()      external pure returns (address) { return address(0); }
    function postTokenRebaseReceiver() external pure returns (address) { return address(0); }
    function oracleDaemonConfig()   external pure returns (address) { return address(0); }
    function coreComponents() external pure returns (address,address,address,address,address) {
        return (address(0),address(0),address(0),address(0),address(0));
    }
    function oracleReportComponents() external pure returns (address,address,address,address,address,address,address) {
        return (address(0),address(0),address(0),address(0),address(0),address(0),address(0));
    }
}

contract LI_MockOperatorGrid {
    uint256 public shareLimit_ = LI_SHARE_LIMIT;

    function vaultTierInfo(address) external view returns (
        address, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) {
        return (address(1), 0, shareLimit_, LI_RESERVE_BP, LI_FORCE_BP, 100, 50, 50);
    }
    function onMintedShares(address, uint256, bool) external {}
    function onBurnedShares(address, uint256) external {}
    function effectiveShareLimit(address) external view returns (uint256) { return shareLimit_; }
    function resetVaultTier(address) external {}
}

// ─── VaultHub harness (minimal clone for this file) ──────────────────────────

contract LI_VaultHubHarness is VaultHub {
    constructor(
        ILidoLocator _locator,
        ILido _lido,
        IHashConsensus _consensus,
        uint256 _maxShareLimitBP
    ) VaultHub(_locator, _lido, _consensus, _maxShareLimitBP) {}

    function harness_connect(
        address _vault,
        address _owner,
        uint256 _shareLimit,
        uint256 _reserveBP,
        uint256 _forceThreshBP,
        uint256 _initTV
    ) external {
        VaultHub.Storage storage $ = _s();
        $.connections[_vault] = VaultHub.VaultConnection({
            owner:                     _owner,
            shareLimit:                uint96(_shareLimit),
            vaultIndex:                uint96($.vaults.length),
            disconnectInitiatedTs:     DISCONNECT_NOT_INITIATED,
            reserveRatioBP:            uint16(_reserveBP),
            forcedRebalanceThresholdBP:uint16(_forceThreshBP),
            infraFeeBP:                100,
            liquidityFeeBP:            50,
            reservationFeeBP:          50,
            beaconChainDepositsPauseIntent: false
        });
        VaultHub.VaultRecord memory r;
        r.report = VaultHub.Report({
            totalValue: uint104(_initTV),
            inOutDelta:  int104(int256(_initTV)),
            timestamp:   uint48(block.timestamp)
        });
        r.inOutDelta[0] = DoubleRefSlotCache.Int104WithCache({
            value:          int104(int256(_initTV)),
            valueOnRefSlot: int104(int256(_initTV)),
            refSlot:        0
        });
        r.inOutDelta[1] = DoubleRefSlotCache.Int104WithCache({
            value:          int104(int256(_initTV)),
            valueOnRefSlot: int104(int256(_initTV)),
            refSlot:        0
        });
        r.minimalReserve = uint128(1 ether);
        $.records[_vault] = r;
        $.vaults.push(_vault);
    }

    function _s() private pure returns (VaultHub.Storage storage $) {
        assembly { $.slot := 0x9eb73ffa4c77d08d5d1746cf5a5e50a47018b610ea5d728ea9bd9e399b76e200 }
    }
}

// ─── Test Contract ─────────────────────────────────────────────────────────────

contract LidoIntegrationFuzzTest is Test {
    address internal admin    = makeAddr("LI_admin");
    address internal owner1   = makeAddr("LI_owner1");
    address internal owner2   = makeAddr("LI_owner2");
    address internal treasury = makeAddr("LI_treasury");

    LI_VaultHubHarness  internal hub;
    LI_MockLido         internal lido;
    LI_MockLazyOracle   internal oracle;
    LI_MockVault        internal vault1;
    LI_MockVault        internal vault2;

    function setUp() public {
        lido = new LI_MockLido();
        LI_MockHashConsensus consensus = new LI_MockHashConsensus();
        LI_MockOperatorGrid og = new LI_MockOperatorGrid();

        // Placeholder locator; patched after hub deploy
        LI_MockLocator tempLoc = new LI_MockLocator(address(0), address(og), treasury);

        // Hub: deploy implementation, wrap in ERC1967Proxy.
        // _disableInitializers() + _pauseUntil(PAUSE_INFINITELY) run on impl storage only;
        // the proxy starts with fresh (uninitialised, unpaused) storage.
        LI_VaultHubHarness impl = new LI_VaultHubHarness(
            ILidoLocator(address(tempLoc)),
            ILido(address(lido)),
            IHashConsensus(address(consensus)),
            1000  // 10% max share limit
        );
        ERC1967Proxy hubProxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VaultHub.initialize, (admin))
        );
        hub = LI_VaultHubHarness(payable(address(hubProxy)));

        oracle = new LI_MockLazyOracle(address(hub));

        // Build real locator and etch it
        LI_MockLocator realLoc = new LI_MockLocator(address(oracle), address(og), treasury);
        vm.etch(address(tempLoc), address(realLoc).code);
        for (uint256 i = 0; i < 3; i++) {
            vm.store(address(tempLoc), bytes32(i), vm.load(address(realLoc), bytes32(i)));
        }

        // Deploy vault mocks and fund them
        vault1 = new LI_MockVault(owner1);
        vault2 = new LI_MockVault(owner2);
        deal(address(vault1), LI_INITIAL_TV);
        deal(address(vault2), LI_INITIAL_TV);

        // Connect vaults
        hub.harness_connect(address(vault1), owner1, LI_SHARE_LIMIT, LI_RESERVE_BP, LI_FORCE_BP, LI_INITIAL_TV);
        hub.harness_connect(address(vault2), owner2, LI_SHARE_LIMIT, LI_RESERVE_BP, LI_FORCE_BP, LI_INITIAL_TV);

        // Fresh reports
        oracle.setLatestReportTimestamp(block.timestamp);
        oracle.applyReport(address(vault1), block.timestamp, LI_INITIAL_TV, int256(LI_INITIAL_TV), 0, 0, 0, 0);
        oracle.applyReport(address(vault2), block.timestamp, LI_INITIAL_TV, int256(LI_INITIAL_TV), 0, 0, 0, 0);
        oracle.setLatestReportTimestamp(block.timestamp);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _ensureFresh() internal {
        oracle.setLatestReportTimestamp(block.timestamp);
        oracle.applyReport(address(vault1), block.timestamp, LI_INITIAL_TV, int256(LI_INITIAL_TV), 0, 0, 0, 0);
        oracle.setLatestReportTimestamp(block.timestamp);
    }

    function _maxMintable(address _vault) internal view returns (uint256) {
        return hub.totalMintingCapacityShares(_vault, 0);
    }

    // ── LI-1: externalShares increases exactly by amountOfShares after mint ──

    function testFuzz_LI1_mintIncreasesExternalShares(uint96 amount) external {
        vm.assume(amount > 0);

        _ensureFresh();

        uint256 cap = _maxMintable(address(vault1));
        vm.assume(amount <= cap && amount <= LI_SHARE_LIMIT);

        uint256 extBefore = lido.externalShares_();

        vm.prank(owner1);
        hub.mintShares(address(vault1), owner1, amount);

        assertEq(lido.externalShares_(), extBefore + amount, "LI-1: external shares delta mismatch");
    }

    // ── LI-2: externalShares decreases exactly by amountOfShares after burn ──

    function testFuzz_LI2_burnDecreasesExternalShares(uint96 amount) external {
        vm.assume(amount > 0);

        _ensureFresh();
        uint256 cap = _maxMintable(address(vault1));
        vm.assume(amount <= cap && amount <= LI_SHARE_LIMIT);

        vm.prank(owner1);
        hub.mintShares(address(vault1), owner1, amount);

        uint256 extAfterMint = lido.externalShares_();

        vm.prank(owner1);
        hub.burnShares(address(vault1), amount);

        assertEq(lido.externalShares_(), extAfterMint - amount, "LI-2: external shares not reduced");
    }

    // ── LI-3: externalShares never exceeds totalShares ────────────────────────

    function testFuzz_LI3_externalSharesCapEqualsTotalShares(uint96 amount1, uint96 amount2) external {
        _ensureFresh();

        uint256 cap = _maxMintable(address(vault1));
        uint256 m1  = bound(amount1, 0, cap < LI_SHARE_LIMIT ? cap : LI_SHARE_LIMIT);
        uint256 m2  = bound(amount2, 0, cap < LI_SHARE_LIMIT ? cap : LI_SHARE_LIMIT);

        if (m1 > 0) {
            vm.prank(owner1);
            hub.mintShares(address(vault1), owner1, m1);
        }
        if (m2 > 0) {
            vm.prank(owner2);
            hub.mintShares(address(vault2), owner2, m2);
        }

        assertLe(lido.externalShares_(), lido.getTotalShares(), "LI-3: external > totalShares");
    }

    // ── LI-4: liabilityShares(vault) == shares held by vault owner after mint ─

    function testFuzz_LI4_liabilitySharesMatchHolderBalance(uint96 amount) external {
        vm.assume(amount > 0);

        _ensureFresh();
        uint256 cap = _maxMintable(address(vault1));
        vm.assume(amount <= cap && amount <= LI_SHARE_LIMIT);

        vm.prank(owner1);
        hub.mintShares(address(vault1), owner1, amount);

        assertEq(
            hub.liabilityShares(address(vault1)),
            lido.shares_(owner1),
            "LI-4: liabilityShares != holder balance"
        );
    }

    // ── LI-5: Round-trip mint→full burn returns externalShares to initial ─────

    function testFuzz_LI5_mintBurnRoundTrip(uint96 amount) external {
        vm.assume(amount > 0);

        _ensureFresh();
        uint256 cap = _maxMintable(address(vault1));
        vm.assume(amount <= cap && amount <= LI_SHARE_LIMIT);

        uint256 extBefore = lido.externalShares_();
        uint256 liabBefore = hub.liabilityShares(address(vault1));

        vm.prank(owner1);
        hub.mintShares(address(vault1), owner1, amount);

        vm.prank(owner1);
        hub.burnShares(address(vault1), amount);

        assertEq(lido.externalShares_(), extBefore,  "LI-5: externalShares not restored");
        assertEq(hub.liabilityShares(address(vault1)), liabBefore, "LI-5: liabilityShares not restored");
    }

    // ── LI-6: Share price round-trip getPooledEthByShares(getSharesByPooledEth(x)) >= x-1 ─

    function testFuzz_LI6_sharePriceRoundTrip(uint96 ethAmount) external view {
        vm.assume(ethAmount > 0 && ethAmount < 1_000_000 ether);

        uint256 shares    = lido.getSharesByPooledEth(ethAmount);
        uint256 ethBack   = lido.getPooledEthByShares(shares);

        // Due to floor division, ethBack may be 1 wei less than ethAmount
        assertGe(uint256(ethAmount) + 1, ethBack, "LI-6: round-trip lost too much");
        assertGe(ethBack + 1, uint256(ethAmount), "LI-6: round-trip gained too much");
    }

    // ── LI-7: sum(liabilityShares) == externalShares across two vaults ────────

    function testFuzz_LI7_sumLiabilityEqExternalShares(uint96 a1, uint96 a2) external {
        _ensureFresh();

        uint256 cap = _maxMintable(address(vault1));
        uint256 m1  = bound(a1, 1, cap < LI_SHARE_LIMIT ? cap : LI_SHARE_LIMIT);
        uint256 m2  = bound(a2, 1, cap < LI_SHARE_LIMIT ? cap : LI_SHARE_LIMIT);

        vm.prank(owner1);
        hub.mintShares(address(vault1), owner1, m1);

        // Refresh report for vault2
        oracle.setLatestReportTimestamp(block.timestamp);
        oracle.applyReport(address(vault2), block.timestamp, LI_INITIAL_TV, int256(LI_INITIAL_TV), 0, 0, 0, 0);
        oracle.setLatestReportTimestamp(block.timestamp);

        vm.prank(owner2);
        hub.mintShares(address(vault2), owner2, m2);

        uint256 sumLiab = hub.liabilityShares(address(vault1)) + hub.liabilityShares(address(vault2));
        assertEq(lido.externalShares_(), sumLiab, "LI-7: sum liabilityShares != externalShares");
    }

    // ── LI-8: burnShares > liabilityShares reverts ────────────────────────────

    function testFuzz_LI8_burnOverLiabilityReverts(uint96 amount, uint96 excess) external {
        vm.assume(amount > 0 && excess > 0 && excess < type(uint96).max - amount);

        _ensureFresh();
        uint256 cap = _maxMintable(address(vault1));
        vm.assume(amount <= cap && amount <= LI_SHARE_LIMIT);

        vm.prank(owner1);
        hub.mintShares(address(vault1), owner1, amount);

        vm.prank(owner1);
        vm.expectRevert();
        hub.burnShares(address(vault1), uint256(amount) + excess);
    }
}
