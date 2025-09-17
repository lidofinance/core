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
 * @notice An accounting contract for a vault's node operator fee management.
 *
 * This contract provides fee calculation and disbursement functionality:
 * • Calculates the node operator's proportional share of vault rewards based on actual growth
 * • Enables permissionless on-demand fee disbursement to a configured recipient
 * • Requires dual confirmation (vault owner + node operator) for critical parameter changes
 * • Supports fee exemptions for specific operations like validator consolidations, unguaranteed/side deposits
 */
contract NodeOperatorFee is Permissions {
    /**
     * @notice Total basis points; 1bp = 0.01%, 100_00bp = 100.00%.
     */
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;

    /**
     * @notice Maximum value that can be set via manual adjustment
     */
    uint256 public constant MAX_SANE_SETTLED_GROWTH = 10_000_000 ether;

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
     * @notice Node operator fee rate in basis points (1 bp = 0.01%).
     * Cannot exceed 100.00% (10000 basis points).
     * The node operator's disbursable fee in ether is returned by `nodeOperatorDisbursableFee()`.
     */
    uint256 public nodeOperatorFeeRate;

    /**
     * @notice The address that receives node operator fee disbursements.
     * This address is set by the node operator manager and receives ETH when fees are disbursed.
     */
    address public nodeOperatorFeeRecipient;

    /**
     * @notice A high-water mark for the vault's total value growth.
     * This value tracks how much of the vault's total growth has already been settled for fee payments.
     * Used to calculate the outstanding fee amount: (currentGrowth - settledGrowth) × feeRate.
     */
    uint256 public settledGrowth;

    /**
     * @notice Timestamp of the most recent fee exemption adjustment.
     * Used to ensure exemptions are properly reported by the oracle before allowing fee rate changes.
     * Must be earlier than the latest oracle report timestamp for fee operations to proceed.
     */
    uint256 public feeExemptionTimestamp;

    /**
     * @notice Flag indicating whether growth settlement is pending manual intervention.
     * When true, fee calculations and disbursements are temporarily disabled until
     * the settled growth value is manually corrected through dual confirmation.
     */
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
     * @notice Returns the latest vault report data containing total value and cumulative in-out delta.
     * This data is essential for calculating the vault's current growth and outstanding fees.
     * @return report The latest report containing totalValue, inOutDelta, and timestamp
     */
    function latestReport() public view returns (VaultHub.Report memory) {
        return VAULT_HUB.latestReport(address(_stakingVault()));
    }

    /**
     * @notice Calculates the current disbursable node operator fee amount in ETH.
     *
     * Fee Calculation Process:
     * 1. Retrieves latest vault report (totalValue, inOutDelta)
     * 2. Calculates current growth: totalValue - inOutDelta
     * 3. Determines unsettled growth: currentGrowth - settledGrowth
     * 4. Applies fee rate: unsettledGrowth × nodeOperatorFeeRate / 10000
     *
     * @return The amount of ETH available for disbursement to the node operator
     */
    function nodeOperatorDisbursableFee() public view returns (uint256) {
        // No fees can be disbursed when settlement is pending manual correction
        if (settledGrowthPending) return 0;

        VaultHub.Report memory report = latestReport();
        // Calculate current growth
        int256 growth = int104(report.totalValue) - report.inOutDelta;

        // No fee if current growth hasn't exceeded what's already been settled
        if (int256(settledGrowth) >= growth) return 0;

        // Calculate fee on unsettled growth: (newGrowth - settledGrowth) × feeRate / 10000
        return ((uint256(growth) - settledGrowth) * nodeOperatorFeeRate) / TOTAL_BASIS_POINTS;
    }

    /**
     * @notice Permissionless function to disburse outstanding node operator fees.
     *
     * This function can be called by anyone to trigger fee payment to the node operator.
     *
     * Process:
     * 1. Calculates current vault growth from latest report
     * 2. Determines fee amount on unsettled growth
     * 3. Updates settled growth to current growth (marking fees as paid)
     * 4. Withdraws fee amount from vault to node operator recipient
     */
    function disburseNodeOperatorFee() public {
        // Cannot disburse when settlement requires manual intervention
        if (settledGrowthPending) return;

        VaultHub.Report memory report = latestReport();
        // Calculate current vault growth
        int256 growth = int104(report.totalValue) - report.inOutDelta;

        // No disbursement needed if growth hasn't increased since last settlement
        if (int256(settledGrowth) >= growth) return;

        // Calculate fee on new growth since last settlement
        uint256 fee = ((uint256(growth) - settledGrowth) * nodeOperatorFeeRate) / TOTAL_BASIS_POINTS;
        // Mark this growth as settled 
        _setSettledGrowth(uint256(growth));

        // Transfer fee from vault to node operator recipient
        VAULT_HUB.withdraw(address(_stakingVault()), nodeOperatorFeeRecipient, fee);
        emit NodeOperatorFeeDisbursed(msg.sender, fee);
    }

    /**
     * @notice Updates the node operator's fee rate with dual confirmation.
     *
     * This critical function requires confirmation from both vault owner and node operator
     * due to its significant financial impact. The fee rate determines the node operator's
     * percentage share of all future vault rewards.
     *
     * @param _newNodeOperatorFeeRate The new fee rate in basis points (max 10000 = 100%)
     * @return bool True if fee rate was updated, false if still awaiting confirmations
     */
    function setNodeOperatorFeeRate(uint256 _newNodeOperatorFeeRate) external returns (bool) {
        // The report must be fresh so that the total value of the vault is up to date
        // and all the node operator fees are paid out fairly up to the moment of the latest fresh report
        if (!VAULT_HUB.isReportFresh(address(_stakingVault()))) revert ReportStale();

        // Latest fee exemption must be earlier than the latest fresh report timestamp
        if (feeExemptionTimestamp >= _lazyOracle().latestReportTimestamp()) revert AdjustmentNotReported();

        // If the vault is quarantined, the total value is reduced and may not reflect the adjustment
        if (_lazyOracle().vaultQuarantine(address(_stakingVault())).isActive) revert VaultQuarantined();

        // Cannot allow to disburse fee, if the growth is not settled
        if (settledGrowthPending) revert();

        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        // Disburse any outstanding fees at the current rate before changing it
        disburseNodeOperatorFee();

        _setNodeOperatorFeeRate(_newNodeOperatorFeeRate);

        return true;
    }

    /**
     * @notice Manually corrects the settled growth value with dual confirmation.
     *
     * This critical function allows manual correction of the settled growth tracking
     * when automated calculations become inconsistent after disconnection.
     *
     * @param _newSettledGrowth The corrected settled growth value
     * @param _expectedSettledGrowth The expected current settled growth
     * @return bool True if correction was applied, false if awaiting confirmations
     */
    function setSettledGrowth(uint256 _newSettledGrowth, uint256 _expectedSettledGrowth) external returns (bool) {
        if (settledGrowth != _expectedSettledGrowth) UnexpectedSettledGrowth;

        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        _setSettledGrowth(_newSettledGrowth);
        _enableFeeDisbursement();

        return true;
    }

    /**
     * @notice Adds a fee exemption to exclude specific amounts from node operator fee calculations.
     *
     * This function allows authorized roles to exempt certain vault value changes from
     * triggering node operator fees. This is essential for operations like:
     * - Validator consolidations
     * - Side deposits 
     *
     * The exemption works by increasing the settled growth baseline, effectively
     * treating the exempted amount as if fees were already paid on it.
     *
     * @param _exemptedAmount Amount in ETH to exempt from fee calculations
     */
    function addFeeExemption(uint256 _exemptedAmount) external onlyRoleMemberOrAdmin(NODE_OPERATOR_FEE_EXEMPT_ROLE) {
        _addFeeExemption(_exemptedAmount);
    }

    /**
     * @notice Sets the confirmation expiry period with dual confirmation.
     *
     * The confirmation expiry defines how long confirmations remain valid before
     * they must be re-submitted. This prevents stale confirmations from being
     * used for critical operations after circumstances have changed.
     *
     * This setting affects all operations requiring dual confirmation:
     * - Fee rate changes
     * - Settled growth corrections
     * - Confirmation expiry changes themselves
     *
     * @param _newConfirmExpiry The new confirmation expiry period in seconds
     * @return bool True if expiry was updated, false if awaiting confirmations
     */
    function setConfirmExpiry(uint256 _newConfirmExpiry) external returns (bool) {
        _validateConfirmExpiry(_newConfirmExpiry);

        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        _setConfirmExpiry(_newConfirmExpiry);

        return true;
    }

    /**
     * @notice Sets the address that receives node operator fee disbursements.
     *
     * This function can only be called by the node operator manager and allows
     * updating where fees are sent when `disburseNodeOperatorFee()` is called.
     *
     * @param _newNodeOperatorFeeRecipient The new recipient address for fee payments
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
        if (_newSettledGrowth > MAX_SANE_SETTLED_GROWTH) revert SettledGrowthTooHigh();

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
    error SettledGrowthTooHigh();

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
     * @dev Error emitted when the settled growth does not match the expected value.
     */
    error UnexpectedSettledGrowth();

    /**
     * @dev Error emitted when the vault is quarantined.
     */
    error VaultQuarantined();
}
