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
 * @notice A contract that manages the node operator fee.
 */
contract NodeOperatorFee is Permissions {
    /**
     * @notice Total basis points; 1bp = 0.01%, 100_00bp = 100.00%.
     */
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;

    /**
     * @notice Parent role representing the node operator of the underlying StakingVault.
     * The members may not include the node operator address recorded in the underlying StakingVault
     * but it is assumed that the members of this role act in the interest of that node operator.
     *
     * @dev 0x59783a4ae82167eefad593739a5430c1d9e896a16c35f1e5285ddd0c0980885c
     */
    bytes32 public constant NODE_OPERATOR_MANAGER_ROLE = keccak256("vaults.NodeOperatorFee.NodeOperatorManagerRole");

    /**
     * @notice Node operator's sub-role for fee exemptions.
     * Managed by `NODE_OPERATOR_MANAGER_ROLE`.
     *
     * @dev 0xcceeef0309e9a678ed7f11f20499aeb00a9a4b0d50e53daa428f8591debc583a
     */
    bytes32 public constant NODE_OPERATOR_FEE_EXEMPT_ROLE = keccak256("vaults.NodeOperatorFee.FeeExemptRole");

    /**
     * @notice Node operator fee rate in basis points (1 bp = 0.01%).
     * Cannot exceed 100.00% (10000 basis points).
     */
    uint256 public nodeOperatorFeeRate;

    /**
     * @notice Address that receives node operator fee disbursements.
     * This address is set by the node operator manager and receives disbursed fees.
     */
    address public nodeOperatorFeeRecipient;

    /**
     * @notice Growth of the vault not subject to fees.
     *
     * Growth is the difference between inOutDelta and totalValue,
     * i.e. the component of totalValue that has not been directly funded to the underlying StakingVault via `fund()`:
     *    inOutDelta + growth = totalValue
     *
     * Settled growth is the portion of the total growth that is not subject to node operator because:
     * - it has already been paid for,
     * - not subject to fee (exempted) such as unguaranteed/side deposits, consolidations.
     */
    uint256 public settledGrowth;

    /**
     * @notice Timestamp of the most recent fee exemption.
     * This timestamp is used to prevent retroactive fees after a fee rate change.
     * The timestamp ensures that all fee exemptions are fully reported before changing the fee rate.
     */
    uint256 public feeExemptionTimestamp;

    /**
     * @notice Flag indicating whether settled growth is pending manual adjustment.
     * This flag blocks any fee disbursement until the settled growth is confirmed by both the vault owner and node operator.
     * Settled growth needs manual adjustment when inOutDelta is outdated,
     * e.g. when connecting to VaultHub, the inOutDelta is reset to the vault's EL balance,
     * which may lead to an inadequate node operator fee calculated against the difference of inOutDelta and reported totalValue.
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
     * @notice The roles that must confirm critical parameters changes in the contract.
     * @return roles is an array of roles that form the confirming roles.
     */
    function confirmingRoles() public pure override returns (bytes32[] memory roles) {
        roles = new bytes32[](2);
        roles[0] = DEFAULT_ADMIN_ROLE;
        roles[1] = NODE_OPERATOR_MANAGER_ROLE;
    }

    /**
     * @notice The latest vault report for the underlying StakingVault.
     * @return report The latest report containing totalValue, inOutDelta, and timestamp
     */
    function latestReport() public view returns (VaultHub.Report memory) {
        return VAULT_HUB.latestReport(address(_stakingVault()));
    }

    /**
     * @notice Calculates the current disbursable node operator fee amount in ETH.
     *
     * Fee calculation steps:
     * 1. Retrieve latest vault report (totalValue, inOutDelta)
     * 2. Calculate current growth: totalValue - inOutDelta
     * 3. Determine unsettled growth: currentGrowth - settledGrowth
     * 4. Apply fee rate: unsettledGrowth × nodeOperatorFeeRate / 10000
     *
     * @dev Even though it's a view function, it will still revert
     * if the settled growth is pending, indicating the need for manual adjustment
     * @return fee The amount of ETH available for disbursement to the node operator
     */
    function nodeOperatorDisbursableFee() public view returns (uint256 fee) {
        (fee, ) = _calculateFee();
    }

    /**
     * @notice Permissionless function to disburse node operator fees.
     *
     * Fee disbursement steps:
     * 1. Calculate current vault growth from latest report
     * 2. Determine fee amount on unsettled growth
     * 3. Update settled growth to current growth (marking fees as paid)
     * 4. Withdraws fee amount from vault to node operator recipient
     */
    function disburseNodeOperatorFee() public {
        (uint256 fee, int256 growth) = _calculateFee();
        _setSettledGrowth(uint256(growth));

        VAULT_HUB.withdraw(address(_stakingVault()), nodeOperatorFeeRecipient, fee);
        emit NodeOperatorFeeDisbursed(msg.sender, fee);
    }

    /**
     * @notice Updates the node operator's fee rate with dual confirmation.
     * @param _newNodeOperatorFeeRate The new fee rate in basis points (max 10000 = 100%)
     * @return bool True if fee rate was updated, false if still awaiting confirmations
     */
    function setNodeOperatorFeeRate(uint256 _newNodeOperatorFeeRate) external returns (bool) {
        // The report must be fresh so that the total value of the vault is up to date
        // and all the node operator fees are paid out fairly up to the moment of the latest fresh report
        if (!VAULT_HUB.isReportFresh(address(_stakingVault()))) revert ReportStale();

        // Latest fee exemption must be earlier than the latest fresh report timestamp
        if (feeExemptionTimestamp >= _lazyOracle().latestReportTimestamp()) revert ExemptedValueNotReportedYet();

        // If the vault is quarantined, the total value is reduced and may not reflect the exemption
        if (_lazyOracle().vaultQuarantine(address(_stakingVault())).isActive) revert VaultQuarantined();

        // Disburse will revert if true, but it's important to check this before recording confirmations
        if (settledGrowthPending) revert SettledGrowthPending();

        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        // Disburse any outstanding fees at the current rate before changing it
        disburseNodeOperatorFee();

        _setNodeOperatorFeeRate(_newNodeOperatorFeeRate);

        return true;
    }

    /**
     * @notice Manually corrects the settled growth value with dual confirmation.
     * Used to correct fee calculation.
     *
     * @param _newSettledGrowth The corrected settled growth value
     * @param _expectedSettledGrowth The expected current settled growth
     * @return bool True if correction was applied, false if awaiting confirmations
     */
    function setSettledGrowth(uint256 _newSettledGrowth, uint256 _expectedSettledGrowth) external returns (bool) {
        if (settledGrowth != _expectedSettledGrowth) revert UnexpectedSettledGrowth();

        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        _setSettledGrowth(_newSettledGrowth);
        // multiconfirmation ensures the owner and node operator have agreed on the fees
        // and the fee disbursement can be resumed
        _enableFeeDisbursement();

        return true;
    }

    /**
     * @notice Adds a fee exemption to exclude this value from node operator fee base.
     * The exemption works by increasing the settled growth,
     * effectively treating the exempted amount as if fees were already paid on it.
     *
     * @param _exemptedAmount Amount in ETH to exempt from fee calculations
     */
    function addFeeExemption(uint256 _exemptedAmount) external onlyRoleMemberOrAdmin(NODE_OPERATOR_FEE_EXEMPT_ROLE) {
        _addFeeExemption(_exemptedAmount);
    }

    /**
     * @notice Sets the confirmation expiry period with dual confirmation.
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
     * @param _newNodeOperatorFeeRecipient The new recipient address for fee payments
     */
    function setNodeOperatorFeeRecipient(
        address _newNodeOperatorFeeRecipient
    ) external onlyRoleMemberOrAdmin(NODE_OPERATOR_MANAGER_ROLE) {
        _setNodeOperatorFeeRecipient(_newNodeOperatorFeeRecipient);
    }

    // ==================== Internal Functions ====================

    function _lazyOracle() internal view returns (LazyOracle) {
        return LazyOracle(LIDO_LOCATOR.lazyOracle());
    }

    function _setSettledGrowth(uint256 _newSettledGrowth) internal {
        uint256 oldSettledGrowth = settledGrowth;
        settledGrowth = _newSettledGrowth;

        emit SettledGrowthSet(oldSettledGrowth, _newSettledGrowth);
    }

    function _increaseSettledGrowth(uint256 _increaseAmount) internal {
        _setSettledGrowth(settledGrowth + _increaseAmount);
    }

    function _addFeeExemption(uint256 _amount) internal {
        _increaseSettledGrowth(_amount);
        feeExemptionTimestamp = block.timestamp;

        emit FeeExemptionAdded(_amount, block.timestamp);
    }

    function _calculateFee() internal view returns (uint256 fee, int256 growth) {
        // revert if the settled growth is awaiting manual adjustment,
        // thus a meaningful return value cannot be calculated.
        // cannot return 0 instead of revert because 0 is a legal value
        if (settledGrowthPending) revert SettledGrowthPending();

        VaultHub.Report memory report = latestReport();
        growth = int104(report.totalValue) - report.inOutDelta;

        if (growth > int256(settledGrowth)) {
            fee = ((uint256(growth) - settledGrowth) * nodeOperatorFeeRate) / TOTAL_BASIS_POINTS;
        }
    }

    function _enableFeeDisbursement() internal {
        settledGrowthPending = false;

        emit FeeDisbursementEnabled();
    }

    function _disableFeeDisbursement() internal {
        settledGrowthPending = true;

        emit FeeDisbursementDisabled();
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

    /**
     * @dev Emitted when the settled growth is set.
     * @param oldSettledGrowth the old settled growth
     * @param newSettledGrowth the new settled growth
     */
    event SettledGrowthSet(uint256 oldSettledGrowth, uint256 newSettledGrowth);

    /**
     * @dev Emitted when a fee exemption is added.
     * @param amountExempted the amount exempted
     * @param timestamp the timestamp of the exemption
     */
    event FeeExemptionAdded(uint256 amountExempted, uint256 timestamp);

    /**
     * @dev Emitted when the fee disbursement is enabled.
     */
    event FeeDisbursementEnabled();

    /**
     * @dev Emitted when the fee disbursement is disabled.
     */
    event FeeDisbursementDisabled();

    // ==================== Errors ====================

    /**
     * @dev Error emitted when the combined feeBPs exceed 100%.
     */
    error FeeValueExceed100Percent();

    /**
     * @dev Error emitted when trying to set same value for recipient
     */
    error SameRecipient();

    /**
     * @dev Error emitted when the report is stale.
     */
    error ReportStale();

    /**
     * @dev Error emitted when the exempted value has not been reported yet.
     */
    error ExemptedValueNotReportedYet();

    /**
     * @dev Error emitted when the settled growth does not match the expected value.
     */
    error UnexpectedSettledGrowth();

    /**
     * @dev Error emitted when the settled growth is pending manual adjustment.
     */
    error SettledGrowthPending();

    /**
     * @dev Error emitted when the vault is quarantined.
     */
    error VaultQuarantined();
}
