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
abstract contract NodeOperatorFee is Permissions {
    /**
     * @notice Total basis points; 1bp = 0.01%, 100_00bp = 100.00%.
     */
    uint256 private constant TOTAL_BASIS_POINTS = 100_00;

    /**
     * @notice Maximum fee value; equals to 100.00%.
     */
    uint256 private constant MAX_FEE_BP = TOTAL_BASIS_POINTS;

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
    bytes32 public constant NODE_OPERATOR_FEE_CLAIM_ROLE = keccak256("vaults.NodeOperatorFee.NodeOperatorFeeClaimRole");

    /**
     * @notice Node operator fee in basis points; cannot exceed 100.00%.
     * The node operator's unclaimed fee in ether is returned by `nodeOperatorUnclaimedFee()`.
     */
    uint256 public nodeOperatorFeeBP;

    /**
     * @notice The last report for which node operator fee was claimed. Updated on each claim.
     */
    IStakingVault.Report public nodeOperatorFeeClaimedReport;

    function _initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) public virtual {
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");
        if (_nodeOperatorManager == address(0)) revert ZeroArgument("_nodeOperatorManager");
        if (_nodeOperatorFeeBP > MAX_FEE_BP) revert FeeValueExceed100Percent();

        nodeOperatorFeeBP = _nodeOperatorFeeBP;

        _setConfirmExpiry(_confirmExpiry);

        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
        _grantRole(NODE_OPERATOR_MANAGER_ROLE, _nodeOperatorManager);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_FEE_CLAIM_ROLE, NODE_OPERATOR_MANAGER_ROLE);
    }

    /**
     * @notice Returns the roles that can:
     * - change the confirm expiry;
     * - set the curator fee;
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
     * calculated as: U = (R * F) / T
     * where:
     * - U is the node operator unclaimed fee;
     * - R is the StakingVault rewards accrued since the last node operator fee claim;
     * - F is `nodeOperatorFeeBP`;
     * - T is the total basis points, 10,000.
     * @return uint256: the amount of unclaimed fee in ether.
     */
    function nodeOperatorUnclaimedFee() public view returns (uint256) {
        IStakingVault.Report memory latestReport = stakingVault().latestReport();

        int128 rewardsAccrued = int128(latestReport.valuation - nodeOperatorFeeClaimedReport.valuation) -
            (latestReport.inOutDelta - nodeOperatorFeeClaimedReport.inOutDelta);

        return rewardsAccrued > 0 ? (uint256(uint128(rewardsAccrued)) * nodeOperatorFeeBP) / TOTAL_BASIS_POINTS : 0;
    }

    /**
     * @notice Returns the unreserved amount of ether,
     * i.e. the amount of ether that is not locked in the StakingVault
     * and not reserved for curator and node operator fees.
     * This amount does not account for the current balance of the StakingVault and
     * can return a value greater than the actual balance of the StakingVault.
     * @return uint256: the amount of unreserved ether.
     */
    function unreserved() public view returns (uint256) {
        uint256 reserved = stakingVault().locked() + nodeOperatorUnclaimedFee();
        uint256 valuation = stakingVault().valuation();

        return reserved > valuation ? 0 : valuation - reserved;
    }

    /**
     * @notice Returns the amount of ether that can be withdrawn from the staking vault.
     * @dev This is the amount of ether that is not locked in the StakingVault and not reserved for curator and node operator fees.
     * @dev This method overrides the Dashboard's withdrawableEther() method
     * @return The amount of ether that can be withdrawn.
     */
    function withdrawableEther() external view returns (uint256) {
        return Math256.min(address(stakingVault()).balance, unreserved());
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
     * The node operator fee combined with the curator fee cannot exceed 100%.
     * Note that the function reverts if the node operator fee is unclaimed and all the confirms must be recasted to execute it again,
     * which is why the deciding confirm must make sure that `nodeOperatorUnclaimedFee()` is 0 before calling this function.
     * @param _newNodeOperatorFeeBP The new node operator fee in basis points.
     */
    function setNodeOperatorFeeBP(uint256 _newNodeOperatorFeeBP) external onlyConfirmed(confirmingRoles()) {
        if (_newNodeOperatorFeeBP > MAX_FEE_BP) revert FeeValueExceed100Percent();
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
     * @notice Claims the node operator fee.
     * Note that the authorized role is NODE_OPERATOR_FEE_CLAIMER_ROLE, not NODE_OPERATOR_MANAGER_ROLE,
     * although NODE_OPERATOR_MANAGER_ROLE is the admin role for NODE_OPERATOR_FEE_CLAIMER_ROLE.
     * @param _recipient The address to which the node operator fee will be sent.
     */
    function claimNodeOperatorFee(address _recipient) external onlyRole(NODE_OPERATOR_FEE_CLAIM_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        uint256 fee = nodeOperatorUnclaimedFee();
        if (fee == 0) revert NoUnclaimedFee();

        nodeOperatorFeeClaimedReport = stakingVault().latestReport();

        stakingVault().withdraw(_recipient, fee);
    }

    /**
     * @dev Modifier that checks if the requested amount is less than or equal to the unreserved amount.
     * @param _ether The amount of ether to check.
     */
    modifier onlyIfUnreserved(uint256 _ether) {
        uint256 withdrawable = unreserved();
        if (_ether > withdrawable) revert RequestedAmountExceedsUnreserved();
        _;
    }

    /**
     * @dev Emitted when the node operator fee is set.
     * @param oldNodeOperatorFeeBP The old node operator fee.
     * @param newNodeOperatorFeeBP The new node operator fee.
     */
    event NodeOperatorFeeBPSet(address indexed sender, uint256 oldNodeOperatorFeeBP, uint256 newNodeOperatorFeeBP);

    /**
     * @dev Error emitted when the node operator fee is unclaimed.
     */
    error NodeOperatorFeeUnclaimed();

    /**
     * @dev Error emitted when the combined feeBPs exceed 100%.
     */
    error FeeValueExceed100Percent();

    /**
     * @dev Error emitted when the requested amount exceeds the unreserved amount.
     */
    error RequestedAmountExceedsUnreserved();

    /**
     * @dev Error emitted when the fee is 0.
     */
    error NoUnclaimedFee();
}
