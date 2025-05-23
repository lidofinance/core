// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "../VaultHub.sol";
import {Permissions} from "./Permissions.sol";

/**
 * @title NodeOperatorFee
 * @author Lido
 * @notice An accounting contract for a vault's node operator fee:  
 *   • Calculates the node operator’s share of each reward period,  
 *   • Ignores any vault value changes that aren’t true rewards,  
 *   • Permissionless on-demand fee disbursement,  
 *   • Critical parameter changes require vault-owner<>node operator approval.
 */
contract NodeOperatorFee is Permissions {
    /**
     * @notice Total basis points; 1bp = 0.01%, 100_00bp = 100.00%.
     */
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;

    /**
     * @notice Maximum value that can be set via manual adjustment
     */
    uint128 public constant MANUAL_REWARDS_ADJUSTMENT_LIMIT = 10_000_000 ether;

    /**
     * @notice Node operator manager role:
     * - confirms confirm expiry;
     * - confirms node operator fee changes;
     * - confirms the transfer of the StakingVault ownership;
     * - is the admin role for NODE_OPERATOR_FEE_RECIPIENT_SET_ROLE.
     */
    bytes32 public constant NODE_OPERATOR_MANAGER_ROLE = keccak256("vaults.NodeOperatorFee.NodeOperatorManagerRole");

    /**
     * @notice Sets the node operator fee recipient.
     */
    bytes32 public constant NODE_OPERATOR_FEE_RECIPIENT_SET_ROLE =
        keccak256("vaults.NodeOperatorFee.SetFeeRecipientRole");

    /**
     * @notice Adjusts rewards to allow fee correction during side deposits or consolidations
     */
    bytes32 public constant NODE_OPERATOR_REWARDS_ADJUST_ROLE = keccak256("vaults.NodeOperatorFee.RewardsAdjustRole");

    /**
     * @notice Node operator fee in basis points; cannot exceed 100.00%.
     * The node operator's disburseable fee in ether is returned by `nodeOperatorDisburseableFee()`.
     */
    uint256 public nodeOperatorFeeBP;

    /**
     * @notice The last report for which node operator fee was disbursed. Updated on each disbursement.
     */
    VaultHub.Report public feePeriodStartReport;

    /**
     * @notice The address of the node operator fee recipient.
     */
    address public nodeOperatorFeeRecipient;

    struct RewardsAdjustment {
        uint128 amount;
        uint64 latestAdjustmentTimestamp;
    }

    /**
     * @notice Adjustment to allow fee correction during side deposits or consolidations.
     *          - can be increased manually by `increaseRewardsAdjustment` by NODE_OPERATOR_REWARDS_ADJUST_ROLE
     *          - can be set via `setRewardsAdjustment` by `confirmingRoles()`
     *          - increased automatically with `unguaranteedDepositToBeaconChain` by total ether amount of deposits
     *          - reset to zero after `disburseNodeOperatorFee`
     *        This amount will be deducted from rewards during NO fee calculation and can be used effectively write off NO's accrued fees.
     *
     */
    RewardsAdjustment public rewardsAdjustment;

    /**
     * @notice Passes the address of the vault hub up the inheritance chain.
     * @param _vaultHub The address of the vault hub.
     * @param _lidoLocator The address of the Lido locator.
     */
    constructor(address _vaultHub, address _lidoLocator) Permissions(_vaultHub, _lidoLocator) {}

    /**
     * @dev Calls the parent's initializer, sets the node operator fee, assigns the node operator manager role,
     * and makes the node operator manager the admin for the node operator roles.
     * @param _defaultAdmin The address of the default admin
     * @param _nodeOperatorManager The address of the node operator manager
     * @param _nodeOperatorFeeBP The node operator fee in basis points
     * @param _confirmExpiry The confirmation expiry time in seconds
     */
    function _initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) internal {
        if (_nodeOperatorManager == address(0)) revert ZeroArgument("_nodeOperatorManager");

        super._initialize(_defaultAdmin, _confirmExpiry);

        _setNodeOperatorFeeBP(_nodeOperatorFeeBP);
        _setNodeOperatorFeeRecipient(_nodeOperatorManager);

        _grantRole(NODE_OPERATOR_MANAGER_ROLE, _nodeOperatorManager);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_FEE_RECIPIENT_SET_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_REWARDS_ADJUST_ROLE, NODE_OPERATOR_MANAGER_ROLE);
    }

    /**
     * @notice Returns the roles that can:
     * - change the confirm expiry;
     * - set the node operator fee;
     * - set a new owner of the StakingVault.
     * @return roles is an array of roles that form the confirming roles.
     */
    function confirmingRoles() public pure override returns (bytes32[] memory roles) {
        roles = new bytes32[](2);
        roles[0] = DEFAULT_ADMIN_ROLE;
        roles[1] = NODE_OPERATOR_MANAGER_ROLE;
    }

    /**
     * @notice Returns the latest report data containing the total value and in-out delta.
     * @return report The latest report.
     */
    function latestReport() public view returns (VaultHub.Report memory) {
        return VAULT_HUB.latestReport(address(_stakingVault()));
    }

    /**
     * @notice Calculates the node operator's disburseable fee.
     * ═════════════════════════════════════════════════════════════════════════════
     *                    nodeOperatorDisburseableFee — Calculation Logic
     * ═════════════════════════════════════════════════════════════════════════════
     * Return the amount of ether presently owed to the node-operator,
     * computed as a proportion of *net* staking rewards accrued between
     *   • `feePeriodStartReport`, and
     *   • `latestReport()`.
     *
     * ─────────────────────────────────────────────────────────────────────────────
     * Staking-rewards for an accounting interval are derived as:
     *
     * rewards = Δ(totalValue) − Δ(inOutDelta) − rewardsAdjustment
     *
     * where
     *  • Δ(totalValue)     — change in totalValue (CL + EL balances) between reports;
     *  • Δ(inOutDelta)     — net funds/withdrawals in the same interval;
     *  • rewardsAdjustment — rewards offset that excludes side deposits and consolidations
     *                        (e.g. CL topups that are not subject to node operator fee).
     * 
     * If the rewards are negative, for the purposes of fee calculation, they are considered to be zero.
     * The node-operator’s fee is therefore
     *
     *     fee = max(0, rewards) × nodeOperatorFeeBP / TOTAL_BASIS_POINTS
     *
     * ═════════════════════════════════════════════════════════════════════════════
     * @return fee The node operator's disburseable fee.
     */
    function nodeOperatorDisburseableFee() public view returns (uint256) {
        VaultHub.Report memory latestReport_ = latestReport();
        VaultHub.Report storage _lastDisbursedReport = feePeriodStartReport;

        // cast down safely clamping to int128.max
        int128 adjustment = _toSignedClamped(rewardsAdjustment.amount);

        int128 adjustedRewards = int128(latestReport_.totalValue) -
            int128(_lastDisbursedReport.totalValue) -
            (latestReport_.inOutDelta - _lastDisbursedReport.inOutDelta) -
            adjustment;

        return adjustedRewards > 0 ? (uint256(uint128(adjustedRewards)) * nodeOperatorFeeBP) / TOTAL_BASIS_POINTS : 0;
    }

    /**
     * @notice Transfers the node-operator’s accrued fee (if any) and rolls the
     *         accounting period forward.
     * ═════════════════════════════════════════════════════════════════════════════
     *                         disburseNodeOperatorFee — Logic
     * ═════════════════════════════════════════════════════════════════════════════
     *  General flow
     *  ─────────────
     *  • Compute the current fee via `nodeOperatorDisburseableFee()`.
     *  • Always move `feePeriodStartReport` to `latestReport()`,
     *    thus closing the reward period.
     *  • Always zero `rewardsAdjustment` (no matter whether the report includes the adjustment
     *    because it will eventually be settled).
     *  • Transfer `fee` wei to `nodeOperatorFeeRecipient` IF `fee > 0`.
     *
     *  The function is intentionally oblivious to whether the oracle’s most
     *  recent report already reflects the adjustment that neutralises side
     *  deposits. In case it does not, there are two scenarios:
     *
     *  ────────────────────────────────────────────────────────────────────────────
     *  Case (i)  R ≤ A   — rewards cannot yet cover the adjustment
     *  ────────────────────────────────────────────────────────────────────────────
     *      adjustedRewards = R − A ≤ 0  ⇒  fee = 0
     *      • No ether is sent.
     *      • Snapshot still occurs; `rewardsAdjustment` is reset to 0.
     *      • When the next oracle report arrives, it will include the top-up
     *        that created A, converting the previously missing amount into
     *        positive rewards.  With A now zero, the operator will then receive
     *        the fee that was deferred.
     *
     *  ────────────────────────────────────────────────────────────────────────────
     *  Case (ii) R > A   — rewards exceed the adjustment
     *  ────────────────────────────────────────────────────────────────────────────
     *      adjustedRewards = R − A > 0  ⇒  fee = (R − A) × BP / TOTAL_BASIS_POINTS
     *      • The surplus portion (R − A) is paid out immediately.
     *      • Snapshot + adjustment reset still execute, preventing the same
     *        rewards from being charged twice.
     *      • The forthcoming oracle report will now incorporate the side
     *        deposit in `totalValue`.  Because A is already cleared, any
     *        remaining genuine rewards flow to the operator in the standard
     *        fashion.
     *
     *  In both cases:
     *      1.  The fee period start is advanced, eliminating double-count risk.
     *      2.  `rewardsAdjustment` is cleared, guaranteeing one-time use.
     *
     *  No timestamp gate is required here: the design is eventually consistent
     *  and ensures the operator is never over- or under-paid across successive
     *  disbursements.
     * ═════════════════════════════════════════════════════════════════════════════
     */
    function disburseNodeOperatorFee() public {
        uint256 fee = nodeOperatorDisburseableFee();

        feePeriodStartReport = latestReport();
        if (rewardsAdjustment.amount != 0) _setRewardsAdjustment(0);

        if (fee > 0) {
            VAULT_HUB.withdraw(address(_stakingVault()), nodeOperatorFeeRecipient, fee);
            emit NodeOperatorFeeDisbursed(msg.sender, fee);
        }
    }

    /**
     * @notice Updates the node-operator’s fee rate (basis-points share). 
     * ═════════════════════════════════════════════════════════════════════════════
     *                         setNodeOperatorFeeBP Logic
     * ═════════════════════════════════════════════════════════════════════════════
     *  General flow
     *  ─────────────
     *  • Verify all guards (upper-bound, fresh report, adjustment-inclusion).  
     *  • Settle any pending rewards at the *old* rate via `disburseNodeOperatorFee()`.  
     *  • Write `_newNodeOperatorFeeBP` to storage.  
     *  • Emit `NodeOperatorFeeBPSet`.  
     *  Every call requires dual confirmation within `confirmExpiry`.
     *
     *  Preconditions
     *  ─────────────
     *  (a) `_newNodeOperatorFeeBP ≤ TOTAL_BASIS_POINTS`  
     *      ↳ else `FeeValueExceed100Percent()`  
     *
     *  (b) `VAULT_HUB.isReportFresh(stakingVault) == true`  
     *      ↳ blocks rate changes against stale oracle data.  
     *
     *  (c) `rewardsAdjustment.timestamp ≥ latestVaultReportTimestamp(stakingVault)`  
     *      ↳ guarantees the oracle already captured any pending offset;  
     *        otherwise `ReportStale()` prevents a retroactive fee hike.  
     *
     *  Why disburse *before* writing?
     *  • Ensures the old rate never applies to future rewards.  
     *  • Prevents the new rate from touching historical rewards.  
     *
     *  Schematic timeline
     *  ──────────────────
     *
     *         time  ─────────────────────────────────────────────────────────▶
     *
     *         ┌──────┐  ┌────────┐  ┌───────┐  ┌────────────┐  ┌───────┐
     *         │Rpt n │──│Adj set │──│Rpt n+1│──│setFeeBP()  │──│Rpt n+2│
     *         └──────┘  └────────┘  └───────┘  └────────────┘  └───────┘
     *                          │           │           │
     *          A timestamp─────┘           │           │  old fee settled
     *                                      │           └─ new BP stored
     *                                      │
     *          Latest report includes A────┘
     *
     *  The adjustment-inclusion fence blocks `_setNodeOperatorFeeBP()` if attempted between
     *  *Adj set* and the first report that reflects the side deposit, removing
     *  any retroactive-fee attack surface.
     * ═════════════════════════════════════════════════════════════════════════════
     * @param _newNodeOperatorFeeBP The new node operator fee in basis points.
     */
    function setNodeOperatorFeeBP(uint256 _newNodeOperatorFeeBP) external onlyConfirmed(confirmingRoles()) {
        _setNodeOperatorFeeBP(_newNodeOperatorFeeBP);
    }

    /**
     * @notice Sets the confirm expiry.
     * Confirm expiry is a period during which the confirm is counted. Once the period is over,
     * the confirm is considered expired, no longer counts and must be recasted.
     * @param _newConfirmExpiry The new confirm expiry in seconds.
     */
    function setConfirmExpiry(uint256 _newConfirmExpiry) external onlyConfirmed(confirmingRoles()) {
        _setConfirmExpiry(_newConfirmExpiry);
    }

    /**
     * @notice Sets the node operator fee recipient.
     * @param _newNodeOperatorFeeRecipient The address of the new node operator fee recipient.
     */
    function setNodeOperatorFeeRecipient(
        address _newNodeOperatorFeeRecipient
    ) external onlyRole(NODE_OPERATOR_FEE_RECIPIENT_SET_ROLE) {
        _setNodeOperatorFeeRecipient(_newNodeOperatorFeeRecipient);
    }

    /**
     * @notice Increases rewards adjustment to correct fee calculation due to non-rewards ether on CL
     * @param _adjustmentIncrease amount to increase adjustment by
     * @dev will revert if final adjustment is more than `MANUAL_REWARDS_ADJUSTMENT_LIMIT`
     */
    function increaseRewardsAdjustment(
        uint256 _adjustmentIncrease
    ) external onlyRole(NODE_OPERATOR_REWARDS_ADJUST_ROLE) {
        uint256 newAdjustment = rewardsAdjustment.amount + _adjustmentIncrease;
        // sanity check, though value will be cast safely during fee calculation
        if (newAdjustment > MANUAL_REWARDS_ADJUSTMENT_LIMIT) revert IncreasedOverLimit();
        _setRewardsAdjustment(uint128(newAdjustment));
    }

    /**
     * @notice set `rewardsAdjustment` to a new proposed value if `confirmingRoles()` agree
     * @param _newAdjustment new adjustment amount
     * @param _currentAdjustment current adjustment value for invalidating old confirmations
     * @dev will revert if new adjustment is more than `MANUAL_REWARDS_ADJUSTMENT_LIMIT`
     */
    function setRewardsAdjustment(
        uint256 _newAdjustment,
        uint256 _currentAdjustment
    ) external onlyConfirmed(confirmingRoles()) {
        if (rewardsAdjustment.amount != _currentAdjustment)
            revert InvalidatedAdjustmentVote(rewardsAdjustment.amount, _currentAdjustment);
        if (_newAdjustment > MANUAL_REWARDS_ADJUSTMENT_LIMIT) revert IncreasedOverLimit();
        _setRewardsAdjustment(uint128(_newAdjustment));
    }

    function _setNodeOperatorFeeBP(uint256 _newNodeOperatorFeeBP) internal {
        if (_newNodeOperatorFeeBP > TOTAL_BASIS_POINTS) revert FeeValueExceed100Percent();
        // the report must be fresh in order to prevent retroactive fees
        if (!VAULT_HUB.isReportFresh(address(_stakingVault()))) revert ReportStale();

        // To change the fee, we must wait for the report FOLLOWING the adjustment (i.e. next report)
        // to make sure that the adjustment is included in the total value.
        // The adjustment is guaranteed in the next report because oracle includes both active validator balances
        // and valid pending deposits, and pending deposits are observable from the very block they are submitted in.
        if (rewardsAdjustment.latestAdjustmentTimestamp < VAULT_HUB.latestVaultReportTimestamp(address(_stakingVault())))
            revert ReportStale();

        disburseNodeOperatorFee();

        uint256 oldNodeOperatorFeeBP = nodeOperatorFeeBP;
        nodeOperatorFeeBP = _newNodeOperatorFeeBP;

        emit NodeOperatorFeeBPSet(msg.sender, oldNodeOperatorFeeBP, _newNodeOperatorFeeBP);
    }

    function _setNodeOperatorFeeRecipient(address _newNodeOperatorFeeRecipient) internal {
        if (_newNodeOperatorFeeRecipient == address(0)) revert ZeroArgument("nodeOperatorFeeRecipient");
        nodeOperatorFeeRecipient = _newNodeOperatorFeeRecipient;
    }

    /**
     * @notice sets InOut adjustment for correct fee calculation
     * @param _newAdjustment new adjustment value
     */
    function _setRewardsAdjustment(uint128 _newAdjustment) internal {
        uint256 oldAdjustment = rewardsAdjustment.amount;

        if (_newAdjustment == oldAdjustment) revert SameAdjustment();

        rewardsAdjustment.amount = _newAdjustment;
        rewardsAdjustment.latestAdjustmentTimestamp = uint64(block.timestamp);

        emit RewardsAdjustmentSet(_newAdjustment, oldAdjustment);
    }

    function _toSignedClamped(uint128 _adjustment) internal pure returns (int128) {
        if (_adjustment > uint128(type(int128).max)) return type(int128).max;
        return int128(_adjustment);
    }

    // ==================== Events ====================

    /**
     * @dev Emitted when the node operator fee is set.
     * @param oldNodeOperatorFeeBP The old node operator fee.
     * @param newNodeOperatorFeeBP The new node operator fee.
     */
    event NodeOperatorFeeBPSet(address indexed sender, uint256 oldNodeOperatorFeeBP, uint256 newNodeOperatorFeeBP);

    /**
     * @dev Emitted when the node operator fee is disbursed.
     * @param fee the amount of disbursed fee.
     */
    event NodeOperatorFeeDisbursed(address indexed sender, uint256 fee);

    /**
     * @dev Emitted when the new rewards adjustment is set.
     * @param newAdjustment the new adjustment value
     * @param oldAdjustment previous adjustment value
     */
    event RewardsAdjustmentSet(uint256 newAdjustment, uint256 oldAdjustment);

    // ==================== Errors ====================

    /**
     * @dev Error emitted when the combined feeBPs exceed 100%.
     */
    error FeeValueExceed100Percent();

    /**
     * @dev Error emitted when the increased adjustment exceeds the `MANUAL_REWARDS_ADJUSTMENT_LIMIT`.
     */
    error IncreasedOverLimit();

    /**
     * @dev Error emitted when the adjustment setting vote is not valid due to changed state
     */
    error InvalidatedAdjustmentVote(uint256 currentAdjustment, uint256 currentAtPropositionAdjustment);

    /**
     * @dev Error emitted when trying to set same value for adjustment
     */
    error SameAdjustment();

    /**
     * @dev Error emitted when the report is stale.
     */
    error ReportStale();
}
