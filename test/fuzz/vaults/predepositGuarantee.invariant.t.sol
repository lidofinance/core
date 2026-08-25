// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

/**
 * @title  PDG Bond-Accounting Invariant Suite
 * @notice Local-only Foundry invariant test for PredepositGuarantee NO accounting.
 *
 *  Invariants verified:
 *    INV-1  locked <= total   for every tracked node operator
 *    INV-2  ETH conservation  address(pdg).balance == Σ(NO totals) + Σ(guarantor claimables)
 *    INV-3  Ghost sanity      ghost_sumTotals matches real Σ(NO totals)
 *    INV-4  Ghost sanity      ghost_sumClaimable matches real Σ(actor claimables)
 *
 *  Execution model:
 *    – 5 node operators (initially self-guarantors)
 *    – 3 external guarantors that may be assigned to NOs
 *    – Handler performs 4 state transitions:
 *        topUp, withdraw, changeGuarantor, claimRefund
 *    – No beacon-chain / EIP-4788 / BLS operations are exercised; those require
 *      fork-mode testing and are explicitly excluded per audit constraint.
 */

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";

import {GIndex} from "contracts/common/lib/GIndex.sol";
import {PredepositGuarantee} from "contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee.sol";

// ──────────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @dev  Wraps all accounting state transitions that are exercisable without
 *       a live beacon chain (no BLS, no EIP-4788 proof verification).
 *
 *       Ghost variables mirror every ETH movement so the invariant suite can
 *       cross-validate against the contract's on-chain state.
 */
contract PDGHandler is CommonBase, StdCheats, StdUtils {

    PredepositGuarantee public pdg;

    /// 5 fixed node operators
    address[5] public nos;
    /// 3 external guarantors that may be assigned to NOs
    address[3] public extGuarantors;

    // ── Ghost ledger ─────────────────────────────────────────────────────────
    /// Sum of nodeOperatorBalance[no].total across all 5 NOs
    uint256 public ghost_sumTotals;
    /// Sum of guarantorClaimableEther[actor] across all 8 actors
    uint256 public ghost_sumClaimable;

    // ─────────────────────────────────────────────────────────────────────────
    constructor(
        PredepositGuarantee _pdg,
        address[5] memory _nos,
        address[3] memory _extGuarantors
    ) {
        pdg = _pdg;
        nos = _nos;
        extGuarantors = _extGuarantors;
    }

    // ── Action 1: top-up NO balance ①②③④⑤ ──────────────────────────────────
    /**
     * @dev  The guarantor (initially the NO itself) sends ether to back the NO.
     *       Amount is bounded to [1, 50] ETH in whole-ether increments
     *       (PredepositGuarantee.PREDEPOSIT_AMOUNT = 1 ether, amounts must be
     *       multiples thereof).
     */
    function handler_topUp(uint256 noIdx, uint8 etherMultiple) external {
        noIdx = bound(noIdx, 0, 4);
        uint256 amount = uint256(bound(uint256(etherMultiple), 1, 50)) * 1 ether;

        address no = nos[noIdx];
        address guarantor = pdg.nodeOperatorGuarantor(no);

        // Fund the guarantor and execute the call as them
        vm.deal(guarantor, guarantor.balance + amount);
        vm.prank(guarantor);
        try pdg.topUpNodeOperatorBalance{value: amount}(no) {
            ghost_sumTotals += amount;
        } catch {
            // Unexpected revert – ghost NOT updated so INV-3 will detect the
            // discrepancy if contract state changed without our knowledge.
        }
    }

    // ── Action 2: withdraw unlocked balance ──────────────────────────────────
    /**
     * @dev  Guarantor withdraws a whole-ether amount from the unlocked portion
     *       of an NO's balance.  Skips silently when there is nothing to withdraw.
     */
    function handler_withdraw(uint256 noIdx, uint8 etherMultiple) external {
        noIdx = bound(noIdx, 0, 4);
        address no = nos[noIdx];

        PredepositGuarantee.NodeOperatorBalance memory bal = pdg.nodeOperatorBalance(no);
        uint256 unlocked = bal.total - bal.locked;
        if (unlocked < 1 ether) return;

        uint256 maxMultiple = unlocked / 1 ether;
        uint256 multiple = bound(uint256(etherMultiple), 1, maxMultiple);
        uint256 amount = multiple * 1 ether;

        address guarantor = pdg.nodeOperatorGuarantor(no);
        vm.prank(guarantor);
        // Recipient is the guarantor itself – ETH leaves pdg, ghost adjusts
        try pdg.withdrawNodeOperatorBalance(no, amount, guarantor) {
            ghost_sumTotals -= amount;
        } catch {}
    }

    // ── Action 3: change NO's guarantor ──────────────────────────────────────
    /**
     * @dev  The NO reassigns their guarantor to one of the 8 known actors
     *       (5 NOs + 3 ext-guarantors).  Requires locked == 0.
     *       If the NO had a non-zero total, that ether moves from total to the
     *       previous guarantor's claimable.
     */
    function handler_changeGuarantor(uint256 noIdx, uint256 newGuarantorIdx) external {
        noIdx = bound(noIdx, 0, 4);
        address no = nos[noIdx];

        // Cannot change guarantor when any balance is locked
        PredepositGuarantee.NodeOperatorBalance memory bal = pdg.nodeOperatorBalance(no);
        if (bal.locked != 0) return;

        // Build candidate set: 5 NOs + 3 extGuarantors
        address[8] memory candidates;
        for (uint256 i = 0; i < 5; i++) candidates[i] = nos[i];
        for (uint256 i = 0; i < 3; i++) candidates[5 + i] = extGuarantors[i];

        newGuarantorIdx = bound(newGuarantorIdx, 0, 7);
        address newGuarantor = candidates[newGuarantorIdx];

        address currentGuarantor = pdg.nodeOperatorGuarantor(no);
        // Guard against SameGuarantor revert (also covers the initial self-guarantor case)
        if (newGuarantor == currentGuarantor) return;

        vm.prank(no);
        try pdg.setNodeOperatorGuarantor(newGuarantor) {
            // When total > 0 the contract zeroes the NO's total and credits the
            // previous guarantor's claimable.
            if (bal.total > 0) {
                ghost_sumTotals    -= bal.total;
                ghost_sumClaimable += bal.total;
            }
        } catch {}
    }

    // ── Action 4: claim guarantor refund ─────────────────────────────────────
    /**
     * @dev  Any of the 8 actors can claim their pending refund (if they have one).
     *       ETH leaves pdg and ghost adjusts.
     */
    function handler_claimRefund(uint256 actorIdx) external {
        // Build same 8-actor set
        address[8] memory candidates;
        for (uint256 i = 0; i < 5; i++) candidates[i] = nos[i];
        for (uint256 i = 0; i < 3; i++) candidates[5 + i] = extGuarantors[i];

        actorIdx = bound(actorIdx, 0, 7);
        address actor = candidates[actorIdx];

        uint256 claimable = pdg.claimableRefund(actor);
        if (claimable == 0) return;

        vm.prank(actor);
        try pdg.claimGuarantorRefund(actor) {
            ghost_sumClaimable -= claimable;
        } catch {}
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// Real-time Σ(total) across all 5 NOs (used by invariant suite)
    function realSumTotals() external view returns (uint256 s) {
        for (uint256 i = 0; i < 5; i++) s += pdg.nodeOperatorBalance(nos[i]).total;
    }

    /// Real-time Σ(claimable) across all 8 actors (used by invariant suite)
    function realSumClaimable() external view returns (uint256 s) {
        for (uint256 i = 0; i < 5; i++) s += pdg.claimableRefund(nos[i]);
        for (uint256 i = 0; i < 3; i++) s += pdg.claimableRefund(extGuarantors[i]);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Invariant test
// ──────────────────────────────────────────────────────────────────────────────

contract PDGInvariantTest is Test {

    PredepositGuarantee pdg;
    PDGHandler          handler;

    address[5] nos;
    address[3] extGuarantors;

    // ── Deployment ───────────────────────────────────────────────────────────

    function setUp() public {
        // Create deterministic actor addresses
        for (uint256 i = 0; i < 5; i++) {
            nos[i] = makeAddr(string.concat("no_", vm.toString(i)));
        }
        for (uint256 i = 0; i < 3; i++) {
            extGuarantors[i] = makeAddr(string.concat("extG_", vm.toString(i)));
        }

        address admin = makeAddr("admin");

        // Deploy implementation.
        // pivotSlot = 0, giZero = bytes32(0) → safe placeholder for accounting-only tests
        // (GIndex is never dereferenced in the accounting code paths we exercise).
        GIndex giZero = GIndex.wrap(bytes32(0));
        PredepositGuarantee impl = new PredepositGuarantee(
            bytes4(0),  // genesisForkVersion – irrelevant for local accounting tests
            giZero,
            giZero,
            0           // pivotSlot
        );

        // Wrap in an ERC-1967 transparent proxy and initialise
        bytes memory initData = abi.encodeCall(PredepositGuarantee.initialize, (admin));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        pdg = PredepositGuarantee(payable(proxy));

        // The proxy storage starts in the unpaused state (the constructor's
        // _pauseUntil runs against the implementation's storage, not the proxy's).
        // Nothing to resume — the contract is already live through the proxy.
        // We only need DEFAULT_ADMIN_ROLE so the test can grant further roles if needed.

        // Deploy handler and register as the sole invariant target
        handler = new PDGHandler(pdg, nos, extGuarantors);
        targetContract(address(handler));

        // Restrict the fuzzer to only the 4 meaningful handler functions
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = PDGHandler.handler_topUp.selector;
        selectors[1] = PDGHandler.handler_withdraw.selector;
        selectors[2] = PDGHandler.handler_changeGuarantor.selector;
        selectors[3] = PDGHandler.handler_claimRefund.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ── INV-1: locked <= total for every node operator ───────────────────────

    /**
     * @notice  Locked balance can never exceed total balance.
     *          Violated if PDG double-counts a lock or forgets to reduce `locked`
     *          when reducing `total`.
     */
    function invariant_lockedLteTotal() external view {
        for (uint256 i = 0; i < 5; i++) {
            PredepositGuarantee.NodeOperatorBalance memory bal =
                pdg.nodeOperatorBalance(nos[i]);
            assertLe(
                bal.locked,
                bal.total,
                string.concat("INV-1 violated: locked > total for NO ", vm.toString(i))
            );
        }
    }

    // ── INV-2: ETH conservation ──────────────────────────────────────────────

    /**
     * @notice  Every wei that enters pdg is accounted for as either a node-operator
     *          total or a guarantor claimable.  Violated if an accounting update is
     *          skipped or applied twice.
     *
     *          address(pdg).balance == Σ nodeOperatorBalance[no].total
     *                                + Σ guarantorClaimableEther[actor]
     *
     *          The sum covers all 5 NOs + all 3 external guarantors — the complete
     *          set of actors the handler can assign or claim from.
     */
    function invariant_ethConservation() external view {
        uint256 sumTotals   = handler.realSumTotals();
        uint256 sumClaimable = handler.realSumClaimable();

        assertEq(
            address(pdg).balance,
            sumTotals + sumClaimable,
            "INV-2 violated: ETH conservation broken"
        );
    }

    // ── INV-3: Ghost sum of totals matches on-chain state ────────────────────

    /**
     * @notice  Meta-invariant verifying that `ghost_sumTotals` in the handler
     *          faithfully mirrors the real contract storage.  A divergence would
     *          indicate a bug in the handler's ghost-tracking logic.
     */
    function invariant_ghostMatchesTotals() external view {
        assertEq(
            handler.ghost_sumTotals(),
            handler.realSumTotals(),
            "INV-3 violated: ghost_sumTotals diverged from real sum"
        );
    }

    // ── INV-4: Ghost sum of claimables matches on-chain state ────────────────

    /**
     * @notice  Meta-invariant verifying that `ghost_sumClaimable` faithfully mirrors
     *          the sum of all tracked actors' claimable balances on-chain.
     */
    function invariant_ghostMatchesClaimable() external view {
        assertEq(
            handler.ghost_sumClaimable(),
            handler.realSumClaimable(),
            "INV-4 violated: ghost_sumClaimable diverged from real sum"
        );
    }
}
