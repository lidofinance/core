// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Math256} from "contracts/common/lib/Math256.sol";

import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {Permissions} from "./Permissions.sol";
import {VaultHub} from "../VaultHub.sol";

/**
 * @title NodeOperatorFee
 * @notice This contract manages the node operator fee and claiming mechanism.
 * It reserves a portion of the staking rewards for the node operator, and allows
 * the node operator to claim their fee.
 *
 * Key features:
 * - Tracks node operator fees based on staking rewards
 * - Provides fee claiming mechanism via role-based access control
 * - Restricts withdrawals based on the fee reserved for node operators
 * - Requires both the node operator and default admin to confirm the fee changes
 *
 * Node operator fees are calculated as a percentage of the staking rewards accrued
 * between the last claimed report and the latest report in the StakingVault.
 * If the fee was never claimed, the percentage is calculated based on the total
 * rewards accrued since the StakingVault was created.
 */
contract NodeOperatorFee is Permissions {
    /**
     * @notice Total basis points; 1bp = 0.01%, 100_00bp = 100.00%.
     */
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;

    /**
     * @notice Bitwise AND mask that clamps the value to positive int128 range
     */
    uint256 private constant ADJUSTMENT_CLAMP_MASK = uint256(uint128(type(int128).max));

    /**
     * @notice Maximum value that can be set via manual adjustment
     */
    uint256 public constant MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT = 10_000_000 ether;

    /**
     * @notice Node operator manager role:
     * - confirms confirm expiry;
     * - confirms node operator fee changes;
     * - confirms the transfer of the StakingVault ownership;
     * - is the admin role for NODE_OPERATOR_FEE_CLAIM_ROLE.
     */
    bytes32 public constant NODE_OPERATOR_MANAGER_ROLE = keccak256("vaults.NodeOperatorFee.NodeOperatorManagerRole");

    /**
     * @notice Claims node operator fee.
     */
    bytes32 public constant NODE_OPERATOR_FEE_CLAIM_ROLE = keccak256("vaults.NodeOperatorFee.FeeClaimRole");

    /**
     * @notice Adjusts rewards to allow fee correction during side deposits or consolidations
     */
    bytes32 public constant NODE_OPERATOR_REWARDS_ADJUST_ROLE = keccak256("vaults.NodeOperatorFee.RewardsAdjustRole");

    /**
     * @notice Node operator fee in basis points; cannot exceed 100.00%.
     * The node operator's unclaimed fee in ether is returned by `nodeOperatorUnclaimedFee()`.
     */
    uint256 public nodeOperatorFeeBP;

    /**
     * @notice The last report for which node operator fee was claimed. Updated on each claim.
     */
    IStakingVault.Report public nodeOperatorFeeClaimedReport;

    /**
     * @notice Adjustment to allow fee correction during side deposits or consolidations.
     *          - can be increased manually by `increaseAccruedRewardsAdjustment` by NODE_OPERATOR_REWARDS_ADJUST_ROLE
     *          - can be set via `setAccruedRewardsAdjustment` by `confirmingRoles()`
     *          - increased automatically with `unguaranteedDepositToBeaconChain` by total ether amount of deposits
     *          - reset to zero after `claimNodeOperatorFee`
     *        This amount will be deducted from rewards during NO fee calculation and can be used effectively write off NO's accrued fees.
     *
     */
    uint256 public accruedRewardsAdjustment;

    /**
     * @notice Passes the address of the vault hub up the inheritance chain.
     * @param _vaultHub The address of the vault hub.
     */
    constructor(address _vaultHub) Permissions(_vaultHub) {}

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

        _grantRole(NODE_OPERATOR_MANAGER_ROLE, _nodeOperatorManager);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_FEE_CLAIM_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_REWARDS_ADJUST_ROLE, NODE_OPERATOR_MANAGER_ROLE);
    }

    /**
     * @notice Returns the roles that can:
     * - change the confirm expiry;
     * - set the node operator fee;
     * - transfer the ownership of the StakingVault.
     * @return roles is an array of roles that form the confirming roles.
     */
    function confirmingRoles() public pure override returns (bytes32[] memory roles) {
        roles = new bytes32[](2);
        roles[0] = DEFAULT_ADMIN_ROLE;
        roles[1] = NODE_OPERATOR_MANAGER_ROLE;
    }

    /**
     * @notice Returns the accumulated unclaimed node operator fee in ether,
     * calculated as: U = ((R - A) * F) / T
     * where:
     * - U is the node operator unclaimed fee;
     * - R is the StakingVault rewards accrued since the last node operator fee claim;
     * - F is `nodeOperatorFeeBP`;
     * - A is `accruedRewardsAdjustment`;
     * - T is the total basis points, 10,000.
     * @return uint256: the amount of unclaimed fee in ether.
     */
    function nodeOperatorUnclaimedFee() public view returns (uint256) {
        IStakingVault.Report memory latestReport = stakingVault().latestReport();
        IStakingVault.Report storage _lastClaimedReport = nodeOperatorFeeClaimedReport;

        // cast down safely clamping to int128.max
        int128 adjustment = int128(int256(accruedRewardsAdjustment & ADJUSTMENT_CLAMP_MASK));

        int128 rewardsAccrued = int128(latestReport.valuation) - int128(_lastClaimedReport.valuation) -
            (latestReport.inOutDelta - _lastClaimedReport.inOutDelta) -
            adjustment;

        return rewardsAccrued > 0 ? (uint256(uint128(rewardsAccrued)) * nodeOperatorFeeBP) / TOTAL_BASIS_POINTS : 0;
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
     * @notice Sets the node operator fee.
     * The node operator fee is the percentage (in basis points) of node operator's share of the StakingVault rewards.
     * The node operator fee cannot exceed 100%.
     * Note that the function reverts if the node operator fee is unclaimed and all the confirms must be recasted to execute it again,
     * which is why the deciding confirm must make sure that `nodeOperatorUnclaimedFee()` is 0 before calling this function.
     * @param _newNodeOperatorFeeBP The new node operator fee in basis points.
     */
    function setNodeOperatorFeeBP(uint256 _newNodeOperatorFeeBP) external onlyConfirmed(confirmingRoles()) {
        _setNodeOperatorFeeBP(_newNodeOperatorFeeBP);
    }

    /**
     * @notice Claims the node operator fee.
     * Note that the authorized role is NODE_OPERATOR_FEE_CLAIMER_ROLE, not NODE_OPERATOR_MANAGER_ROLE,
     * although NODE_OPERATOR_MANAGER_ROLE is the admin role for NODE_OPERATOR_FEE_CLAIMER_ROLE.
     * @param _recipient The address to which the node operator fee will be sent.
     */
    function claimNodeOperatorFee(address _recipient) external onlyRole(NODE_OPERATOR_FEE_CLAIM_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        uint256 fee = nodeOperatorUnclaimedFee();
        if (fee == 0) revert NoUnclaimedFee();

        if (accruedRewardsAdjustment != 0) _setAccruedRewardsAdjustment(0);
        nodeOperatorFeeClaimedReport = stakingVault().latestReport();

        stakingVault().withdraw(_recipient, fee);
    }

    /**
     * @notice Increases accrued rewards adjustment to correct fee calculation due to non-rewards ether on CL
     *         Note that the authorized role is NODE_OPERATOR_FEE_CLAIM_ROLE, not NODE_OPERATOR_MANAGER_ROLE,
     *         although NODE_OPERATOR_MANAGER_ROLE is the admin role for NODE_OPERATOR_FEE_CLAIM_ROLE.
     * @param _adjustmentIncrease amount to increase adjustment by
     * @dev will revert if final adjustment is more than `MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT`
     */
    function increaseAccruedRewardsAdjustment(
        uint256 _adjustmentIncrease
    ) external onlyRole(NODE_OPERATOR_REWARDS_ADJUST_ROLE) {
        uint256 newAdjustment = accruedRewardsAdjustment + _adjustmentIncrease;
        // sanity check, though value will be cast safely during fee calculation
        if (newAdjustment > MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT) revert IncreasedOverLimit();
        _setAccruedRewardsAdjustment(newAdjustment);
    }

    /**
     * @notice set `accruedRewardsAdjustment` to a new proposed value if `confirmingRoles()` agree
     * @param _newAdjustment ew adjustment amount
     * @param _currentAdjustment current adjustment value for invalidating old confirmations
     * @dev will revert if new adjustment is more than `MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT`
     */
    function setAccruedRewardsAdjustment(
        uint256 _newAdjustment,
        uint256 _currentAdjustment
    ) external onlyConfirmed(confirmingRoles()) {
        if (accruedRewardsAdjustment != _currentAdjustment)
            revert InvalidatedAdjustmentVote(accruedRewardsAdjustment, _currentAdjustment);
        if (_newAdjustment > MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT) revert IncreasedOverLimit();
        _setAccruedRewardsAdjustment(_newAdjustment);
    }

    function _setNodeOperatorFeeBP(uint256 _newNodeOperatorFeeBP) internal {
        if (_newNodeOperatorFeeBP > TOTAL_BASIS_POINTS) revert FeeValueExceed100Percent();
        if (nodeOperatorUnclaimedFee() > 0) revert NodeOperatorFeeUnclaimed();

        uint256 oldNodeOperatorFeeBP = nodeOperatorFeeBP;

        // If fee is changing from 0, update the claimed report to current to prevent retroactive fees
        if (oldNodeOperatorFeeBP == 0 && _newNodeOperatorFeeBP > 0) {
            nodeOperatorFeeClaimedReport = stakingVault().latestReport();
        }

        nodeOperatorFeeBP = _newNodeOperatorFeeBP;

        emit NodeOperatorFeeBPSet(msg.sender, oldNodeOperatorFeeBP, _newNodeOperatorFeeBP);
    }

    /**
     * @notice sets InOut adjustment for correct fee calculation
     * @param _newAdjustment new adjustment value
     */
    function _setAccruedRewardsAdjustment(uint256 _newAdjustment) internal {
        uint256 oldAdjustment = accruedRewardsAdjustment;

        if (_newAdjustment == oldAdjustment) revert SameAdjustment();

        accruedRewardsAdjustment = _newAdjustment;

        emit AccruedRewardsAdjustmentSet(_newAdjustment, oldAdjustment);
    }

    // ==================== Events ====================

    /**
     * @dev Emitted when the node operator fee is set.
     * @param oldNodeOperatorFeeBP The old node operator fee.
     * @param newNodeOperatorFeeBP The new node operator fee.
     */
    event NodeOperatorFeeBPSet(address indexed sender, uint256 oldNodeOperatorFeeBP, uint256 newNodeOperatorFeeBP);

    /**
     * @dev Emitted when the new rewards adjustment is set.
     * @param newAdjustment the new adjustment value
     * @param oldAdjustment previous adjustment value
     */
    event AccruedRewardsAdjustmentSet(uint256 newAdjustment, uint256 oldAdjustment);

    // ==================== Errors ====================

    /**
     * @dev Error emitted when the node operator fee is unclaimed.
     */
    error NodeOperatorFeeUnclaimed();

    /**
     * @dev Error emitted when the fee is 0.
     */
    error NoUnclaimedFee();

    /**
     * @dev Error emitted when the combined feeBPs exceed 100%.
     */
    error FeeValueExceed100Percent();

    /**
     * @dev Error emitted when the increased adjustment exceeds the `MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT`.
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
}
