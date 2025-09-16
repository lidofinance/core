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
    /// @dev 0x59783a4ae82167eefad593739a5430c1d9e896a16c35f1e5285ddd0c0980885c
    bytes32 public constant NODE_OPERATOR_MANAGER_ROLE = keccak256("vaults.NodeOperatorFee.NodeOperatorManagerRole");

    /**
     * @notice Adjusts rewards to allow fee correction during side deposits or consolidations
     */
    /// @dev 0xe0b9915a7819e810f29b50730662441fec3443eb363b7e7c90c77fada416f276
    bytes32 public constant NODE_OPERATOR_FEE_EXEMPT_ROLE = keccak256("vaults.NodeOperatorFee.FeeExemptRole");

    /**
     * @notice Node operator fee in basis points; cannot exceed 100.00%.
     * The node operator's disbursable fee in ether is returned by `nodeOperatorDisbursableFee()`.
     */
    uint256 public nodeOperatorFeeRate;

    /**
     * @notice The address of the node operator fee recipient.
     */
    address public nodeOperatorFeeRecipient;

    uint256 public settledGrowth;
    uint256 public feeExemptionTimestamp;
    bool public settledGrowthPending;

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
        address _nodeOperatorFeeRecipient,
        uint256 _nodeOperatorFeeRate,
        uint256 _confirmExpiry
    ) internal {
        _requireNotZero(_nodeOperatorManager);

        super._initialize(_defaultAdmin, _confirmExpiry);

        _setNodeOperatorFeeRate(_nodeOperatorFeeRate);
        _setNodeOperatorFeeRecipient(_nodeOperatorFeeRecipient);

        _grantRole(NODE_OPERATOR_MANAGER_ROLE, _nodeOperatorManager);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_FEE_EXEMPT_ROLE, NODE_OPERATOR_MANAGER_ROLE);
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

    function nodeOperatorDisbursableFee() public view returns (uint256) {
        if (settledGrowthPending) return 0;

        VaultHub.Report memory report = latestReport();
        int256 growth = int104(report.totalValue) - report.inOutDelta;

        if (int256(settledGrowth) >= growth) return 0;

        return ((uint256(growth) - settledGrowth) * nodeOperatorFeeRate) / TOTAL_BASIS_POINTS;
    }

    function disburseNodeOperatorFee() public {
        if (settledGrowthPending) return;

        VaultHub.Report memory report = latestReport();
        int256 growth = int104(report.totalValue) - report.inOutDelta;

        if (int256(settledGrowth) >= growth) return;

        uint256 fee = ((uint256(growth) - settledGrowth) * nodeOperatorFeeRate) / TOTAL_BASIS_POINTS;
        _setSettledGrowth(uint256(growth));

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
        if (feeExemptionTimestamp >= _lazyOracle().latestReportTimestamp()) revert AdjustmentNotReported();

        // If the vault is quarantined, the total value is reduced and may not reflect the adjustment
        if (_lazyOracle().vaultQuarantine(address(_stakingVault())).isActive) revert VaultQuarantined();

        // Cannot allow to disburse fee, if the growth is not settled
        if (settledGrowthPending) revert();

        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        disburseNodeOperatorFee();

        _setNodeOperatorFeeRate(_newNodeOperatorFeeRate);

        return true;
    }

    function setSettledGrowth(uint256 _newSettledGrowth, uint256 _expectedSettledGrowth) external returns (bool) {
        if (settledGrowth != _expectedSettledGrowth) UnexpectedSettledGrowth;

        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        _setSettledGrowth(_newSettledGrowth);
        _enableFeeDisbursement();

        return true;
    }

    function addFeeExemption(uint256 _exemptedAmount) external onlyRoleMemberOrAdmin(NODE_OPERATOR_FEE_EXEMPT_ROLE) {
        _addFeeExemption(_exemptedAmount);
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

    function _setNodeOperatorFeeRate(uint256 _newNodeOperatorFeeRate) internal {
        if (_newNodeOperatorFeeRate > TOTAL_BASIS_POINTS) revert FeeValueExceed100Percent();

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

    function _addFeeExemption(uint256 _amount) internal {
        _increaseSettledGrowth(_amount);
        feeExemptionTimestamp = block.timestamp;

        emit FeeExemptionAdded(_amount, block.timestamp);
    }

    function _increaseSettledGrowth(uint256 _increaseAmount) internal {
        _setSettledGrowth(settledGrowth + _increaseAmount);
    }

    function _setSettledGrowth(uint256 _newSettledGrowth) internal {
        uint256 oldSettledGrowth = settledGrowth;
        settledGrowth = _newSettledGrowth;

        emit SettledGrowthSet(oldSettledGrowth, _newSettledGrowth);
    }

    function _enableFeeDisbursement() internal {
        settledGrowthPending = false;

        emit FeeDisbursementEnabled();
    }

    function _disableFeeDisbursement() internal {
        settledGrowthPending = true;

        emit FeeDisbursementDisabled();
    }

    function _toSignedClamped(uint128 _adjustment) internal pure returns (int128) {
        if (_adjustment > uint128(type(int128).max)) return type(int128).max;
        return int128(_adjustment);
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
    event NodeOperatorFeeRateSet(
        address indexed sender,
        uint256 oldNodeOperatorFeeRate,
        uint256 newNodeOperatorFeeRate
    );

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
    event NodeOperatorFeeRecipientSet(
        address indexed sender,
        address oldNodeOperatorFeeRecipient,
        address newNodeOperatorFeeRecipient
    );

    event SettledGrowthSet(uint256 oldSettledGrowth, uint256 newSettledGrowth);
    event FeeExemptionAdded(uint256 amountExempted, uint256 timestamp);
    event FeeDisbursementEnabled();
    event FeeDisbursementDisabled();

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

    error UnexpectedSettledGrowth();

    /**
     * @dev Error emitted when the vault is quarantined.
     */
    error VaultQuarantined();
}
