// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "../VaultHub.sol";
import {LazyOracle} from "../LazyOracle.sol";
import {Permissions} from "./Permissions.sol";

/**
 * @title NodeOperatorFee
 * @author Lido
 * @notice An accounting contract for a vault's node operator fee:
 *   • Calculates the node operator's share of each reward period,
 *   • Ignores any vault value changes that aren't true rewards,
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
    uint256 public constant MANUAL_REWARDS_ADJUSTMENT_LIMIT = 10_000_000 ether;

    /**
     * @notice Node operator manager role:
     * - confirms confirm expiry;
     * - confirms node operator fee changes;
     * - confirms the transfer of the StakingVault ownership;
     * - sets the node operator fee recipient.
     */
    bytes32 public constant NODE_OPERATOR_MANAGER_ROLE = keccak256("vaults.NodeOperatorFee.NodeOperatorManagerRole");

    /**
     * @notice Adjusts rewards to allow fee correction during side deposits or consolidations
     */
    bytes32 public constant NODE_OPERATOR_REWARDS_ADJUST_ROLE = keccak256("vaults.NodeOperatorFee.RewardsAdjustRole");

    /**
     * @notice Node operator fee in basis points; cannot exceed 100.00%.
     * The node operator's disbursable fee in ether is returned by `nodeOperatorDisbursableFee()`.
     */
    uint256 public nodeOperatorFeeRate;

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
        uint64 latestTimestamp;
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
     * @param _nodeOperatorFeeRate The node operator fee rate
     * @param _confirmExpiry The confirmation expiry time in seconds
     */
    function _initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeRate,
        uint256 _confirmExpiry
    ) internal {
        _requireNotZero(_nodeOperatorManager);

        super._initialize(_defaultAdmin, _confirmExpiry);

        _validateNodeOperatorFeeRate(_nodeOperatorFeeRate);
        _setNodeOperatorFeeRate(_nodeOperatorFeeRate);
        _setNodeOperatorFeeRecipient(_nodeOperatorManager);

        _grantRole(NODE_OPERATOR_MANAGER_ROLE, _nodeOperatorManager);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
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
     * @notice Calculates the node operator's disbursable fee.
     *
     * The fee presently owed to the node-operator,
     * computed as a portion of staking rewards accrued between
     * `feePeriodStartReport` and `latestReport()`.
     *
     * Staking rewards for an accounting interval are derived as:
     *     rewards = Δ(totalValue) − Δ(inOutDelta) − rewardsAdjustment
     *
     * where
     *  • Δ(totalValue)     — change in totalValue (CL + EL balances) between reports;
     *  • Δ(inOutDelta)     — net funds/withdrawals in the same interval;
     *  • rewardsAdjustment — rewards offset that excludes side deposits and consolidations
     *                        (e.g. CL topups that are not subject to node operator fee).
     *
     * If the rewards are negative, for the purposes of fee calculation, they are considered to be zero.
     * The node-operator's fee is therefore:
     *     fee = max(0, rewards) × nodeOperatorFeeBP / TOTAL_BASIS_POINTS
     *
     * @return fee The node operator's disbursable fee.
     */
    function nodeOperatorDisbursableFee() public view returns (uint256) {
        VaultHub.Report memory periodStart = feePeriodStartReport;
        VaultHub.Report memory periodEnd = latestReport();
        int256 adjustment = _toSignedClamped(rewardsAdjustment.amount);

        // the total increase/decrease of the vault value during the fee period
        int256 growth = int112(periodEnd.totalValue) - int112(periodStart.totalValue) -
                        (periodEnd.inOutDelta - periodStart.inOutDelta);

        // the actual rewards that are subject to the fee
        int256 rewards = growth - adjustment;

        return rewards <= 0 ? 0 : (uint256(rewards) * nodeOperatorFeeRate) / TOTAL_BASIS_POINTS;
    }

    /**
     * @notice Transfers the node-operator's accrued fee (if any).
     * Steps:
     *  • Compute the current fee via `nodeOperatorDisbursableFee()`.
     *  • If there are no rewards, do nothing.
     *  • Otherwise, move `feePeriodStartReport` to `latestReport()`,
     *    reset `rewardsAdjustment` and transfer `fee` wei to `nodeOperatorFeeRecipient`.
     */
    function disburseNodeOperatorFee() public {
        uint256 fee = nodeOperatorDisbursableFee();
        // it's important not to revert here if there is no fee,
        // because the fee is automatically disbursed during `voluntaryDisconnect`
        if (fee == 0) return;

        if (rewardsAdjustment.amount != 0) _setRewardsAdjustment(0);
        feePeriodStartReport = latestReport();

        VAULT_HUB.withdraw(address(_stakingVault()), nodeOperatorFeeRecipient, fee);
        emit NodeOperatorFeeDisbursed(msg.sender, fee);
    }

    /**
     * @notice Updates the node-operator's fee rate (basis-points share).
     * @param _newNodeOperatorFeeRate The new node operator fee rate.
     * @return bool Whether the node operator fee rate was set.
     */
    function setNodeOperatorFeeRate(uint256 _newNodeOperatorFeeRate) external returns (bool) {
        // The report must be fresh so that the total value of the vault is up to date
        // and all the node operator fees are paid out fairly up to the moment of the latest fresh report
        if (!VAULT_HUB.isReportFresh(address(_stakingVault()))) revert ReportStale();

        // Latest adjustment must be earlier than the latest fresh report timestamp
        if (rewardsAdjustment.latestTimestamp >= _lazyOracle().latestReportTimestamp())
            revert AdjustmentNotReported();

        // Adjustment must be settled before the fee rate change
        if (rewardsAdjustment.amount != 0) revert AdjustmentNotSettled();

        // If the vault is quarantined, the total value is reduced and may not reflect the adjustment
        if (_lazyOracle().vaultQuarantine(address(_stakingVault())).isActive) revert VaultQuarantined();

        // Validate fee rate before collecting confirmations
        _validateNodeOperatorFeeRate(_newNodeOperatorFeeRate);

        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        // To follow the check-effects-interaction pattern, we need to remember the fee here
        // because the fee calculation variables will be reset in the following lines
        uint256 fee = nodeOperatorDisbursableFee();

        // Start a new fee period
        feePeriodStartReport = latestReport();

        _setNodeOperatorFeeRate(_newNodeOperatorFeeRate);

        if (fee > 0) {
            VAULT_HUB.withdraw(address(_stakingVault()), nodeOperatorFeeRecipient, fee);
            emit NodeOperatorFeeDisbursed(msg.sender, fee);
        }

        return true;
    }

    /**
     * @notice Sets the confirm expiry.
     * Confirm expiry is a period during which the confirm is counted. Once the period is over,
     * the confirm is considered expired, no longer counts and must be recasted.
     * @param _newConfirmExpiry The new confirm expiry in seconds.
     * @return bool Whether the confirm expiry was set.
     */
    function setConfirmExpiry(uint256 _newConfirmExpiry) external returns (bool) {
        _validateConfirmExpiry(_newConfirmExpiry);

        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        _setConfirmExpiry(_newConfirmExpiry);

        return true;
    }

    /**
     * @notice Sets the node operator fee recipient.
     * @param _newNodeOperatorFeeRecipient The address of the new node operator fee recipient.
     */
    function setNodeOperatorFeeRecipient(
        address _newNodeOperatorFeeRecipient
    ) external onlyRoleMemberOrAdmin(NODE_OPERATOR_MANAGER_ROLE) {
        _setNodeOperatorFeeRecipient(_newNodeOperatorFeeRecipient);
    }

    /**
     * @notice Increases rewards adjustment to correct fee calculation due to non-rewards ether on CL
     * @param _adjustmentIncrease amount to increase adjustment by
     * @dev will revert if final adjustment is more than `MANUAL_REWARDS_ADJUSTMENT_LIMIT`
     */
    function increaseRewardsAdjustment(
        uint256 _adjustmentIncrease
    ) external onlyRoleMemberOrAdmin(NODE_OPERATOR_REWARDS_ADJUST_ROLE) {
        uint256 newAdjustment = rewardsAdjustment.amount + _adjustmentIncrease;
        // sanity check, though value will be cast safely during fee calculation
        if (newAdjustment > MANUAL_REWARDS_ADJUSTMENT_LIMIT) revert IncreasedOverLimit();
        _setRewardsAdjustment(newAdjustment);
    }

    /**
     * @notice set `rewardsAdjustment` to a new proposed value if `confirmingRoles()` agree
     * @param _proposedAdjustment new adjustment amount
     * @param _expectedAdjustment current adjustment value for invalidating old confirmations
     * @return bool Whether the rewards adjustment was set.
     * @dev will revert if new adjustment is more than `MANUAL_REWARDS_ADJUSTMENT_LIMIT`
     */
    function setRewardsAdjustment(
        uint256 _proposedAdjustment,
        uint256 _expectedAdjustment
    ) external returns (bool) {
        if (rewardsAdjustment.amount != _expectedAdjustment)
            revert InvalidatedAdjustmentVote(rewardsAdjustment.amount, _expectedAdjustment);
        if (_proposedAdjustment > MANUAL_REWARDS_ADJUSTMENT_LIMIT) revert IncreasedOverLimit();
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;
        _setRewardsAdjustment(_proposedAdjustment);
        return true;
    }

    function _setNodeOperatorFeeRate(uint256 _newNodeOperatorFeeRate) internal {
        _validateNodeOperatorFeeRate(_newNodeOperatorFeeRate);

        uint256 oldNodeOperatorFeeRate = nodeOperatorFeeRate;
        nodeOperatorFeeRate = _newNodeOperatorFeeRate;

        emit NodeOperatorFeeRateSet(msg.sender, oldNodeOperatorFeeRate, _newNodeOperatorFeeRate);
    }

    function _setNodeOperatorFeeRecipient(address _newNodeOperatorFeeRecipient) internal {
        _requireNotZero(_newNodeOperatorFeeRecipient);
        if (_newNodeOperatorFeeRecipient == nodeOperatorFeeRecipient) revert SameRecipient();

        address oldNodeOperatorFeeRecipient = nodeOperatorFeeRecipient;
        nodeOperatorFeeRecipient = _newNodeOperatorFeeRecipient;
        emit NodeOperatorFeeRecipientSet(msg.sender, oldNodeOperatorFeeRecipient, _newNodeOperatorFeeRecipient);
    }

    /**
     * @notice sets InOut adjustment for correct fee calculation
     * @param _newAdjustment new adjustment value
     */
    function _setRewardsAdjustment(uint256 _newAdjustment) internal {
        uint256 oldAdjustment = rewardsAdjustment.amount;

        if (_newAdjustment == oldAdjustment) revert SameAdjustment();

        rewardsAdjustment.amount = uint128(_newAdjustment);
        rewardsAdjustment.latestTimestamp = uint64(block.timestamp);

        emit RewardsAdjustmentSet(_newAdjustment, oldAdjustment);
    }

    function _toSignedClamped(uint128 _adjustment) internal pure returns (int128) {
        if (_adjustment > uint128(type(int128).max)) return type(int128).max;
        return int128(_adjustment);
    }

    /**
     * @notice Validates that the node operator fee rate is within acceptable bounds
     * @param _nodeOperatorFeeRate The fee rate to validate
     */
    function _validateNodeOperatorFeeRate(uint256 _nodeOperatorFeeRate) internal pure {
        if (_nodeOperatorFeeRate > TOTAL_BASIS_POINTS) revert FeeValueExceed100Percent();
    }

    function _lazyOracle() internal view returns (LazyOracle) {
        return LazyOracle(LIDO_LOCATOR.lazyOracle());
    }

    // ==================== Events ====================

    /**
     * @dev Emitted when the node operator fee is set.
     * @param oldNodeOperatorFeeRate The old node operator fee rate.
     * @param newNodeOperatorFeeRate The new node operator fee rate.
     */
    event NodeOperatorFeeRateSet(address indexed sender, uint256 oldNodeOperatorFeeRate, uint256 newNodeOperatorFeeRate);

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

    /**
     * @dev Emitted when the node operator fee recipient is set.
     * @param sender the address of the sender who set the recipient
     * @param oldNodeOperatorFeeRecipient the old node operator fee recipient
     * @param newNodeOperatorFeeRecipient the new node operator fee recipient
     */
    event NodeOperatorFeeRecipientSet(address indexed sender, address oldNodeOperatorFeeRecipient, address newNodeOperatorFeeRecipient);

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
     * @dev Error emitted when trying to set same value for recipient
     */
    error SameRecipient();

    /**
     * @dev Error emitted when the report is stale.
     */
    error ReportStale();

    /**
     * @dev Error emitted when the adjustment has not been reported yet.
     */
    error AdjustmentNotReported();

    /**
     * @dev Error emitted when the adjustment is not settled.
     */
    error AdjustmentNotSettled();

    /**
     * @dev Error emitted when the vault is quarantined.
     */
    error VaultQuarantined();
}
