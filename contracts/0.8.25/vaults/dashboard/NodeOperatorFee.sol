// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "../VaultHub.sol";
import {LazyOracle} from "../LazyOracle.sol";
import {Permissions} from "./Permissions.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";

/**
 * @title NodeOperatorFee
 * @author Lido
 * @notice A contract that manages the node operator fee.
 */
contract NodeOperatorFee is Permissions {
    using SafeCast for uint256;
    using SafeCast for int256;

    /**
     * @notice Total basis points; 1bp = 0.01%, 100_00bp = 100.00%.
     */
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;

    /**
     * @dev arbitrary number that is big enough to be infinite settled growth
     */
    int256 internal constant MAX_SANE_SETTLED_GROWTH = type(int104).max;

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
     * @notice Node operator's sub-role for unguaranteed deposit
     * Managed by `NODE_OPERATOR_MANAGER_ROLE`.
     *
     * @dev 0x5c17b14b08ace6dda14c9642528ae92de2a73d59eacb65c71f39f309a5611063
     */
    bytes32 public constant NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE =
        keccak256("vaults.NodeOperatorFee.UnguaranteedDepositRole");

    /**
     * @notice Node operator's sub-role for proving unknown validators.
     * Managed by `NODE_OPERATOR_MANAGER_ROLE`.
     *
     * @dev 0x7b564705f4e61596c4a9469b6884980f89e475befabdb849d69719f0791628be
     */
    bytes32 public constant NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE =
        keccak256("vaults.NodeOperatorFee.ProveUnknownValidatorsRole");

    /**
     * @notice If the accrued fee exceeds this BP of the total value, it is considered abnormally high.
     * An abnormally high fee can only be disbursed by `DEFAULT_ADMIN_ROLE`.
     * This threshold is to prevent accidental overpayment due to outdated settled growth.
     *
     * Why 1% threshold?
     *
     * - Assume a very generous annual staking APR of ~5% (3% CL + 2% EL).
     * - A very high node operator fee rate of 10% translates to a 0.5% annual fee.
     * - Thus, a 1% fee threshold would therefore be reached in 2 years.
     * - Meaning: as long as the operator disburses fees at least once every 2 years,
     *   the threshold will never be hit.
     *
     * Since these assumptions are highly conservative, in practice the operator
     * would need to disburse even less frequently before approaching the threshold.
     */
    uint256 constant internal ABNORMALLY_HIGH_FEE_THRESHOLD_BP = 1_00;

    // ==================== Packed Storage Slot 1 ====================
    /**
     * @notice Address that receives node operator fee disbursements.
     * This address is set by the node operator manager and receives disbursed fees.
     */
    address public feeRecipient;

    /**
     * @notice Node operator fee rate in basis points (1 bp = 0.01%).
     * Cannot exceed 100.00% (10000 basis points).
     */
    uint16 public feeRate;

    // ==================== Packed Storage Slot 2 ====================
    /**
     * @notice Growth of the vault not subject to fees.
     *
     * Growth is the difference between inOutDelta and totalValue,
     * i.e. the component of totalValue that has not been directly funded to the underlying StakingVault via `fund()`:
     *    inOutDelta + growth = totalValue
     *
     * Settled growth is the portion of the total growth that:
     * - has already been charged by the node operator,
     * - or is not subject to fee (exempted) such as unguaranteed/side deposits, consolidations.
     */
    int128 public settledGrowth;

    /**
     * @notice Timestamp of the most recent settled growth correction.
     * This timestamp is used to prevent retroactive fees after a fee rate change.
     * The timestamp ensures that all fee exemptions and corrections are fully reported before changing the fee rate.
     * Regular fee disbursements do not update this timestamp.
     */
    uint64 public latestCorrectionTimestamp;

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
     * @param _feeRecipient The node operator fee recipient address
     * @param _feeRate The node operator fee rate
     * @param _confirmExpiry The confirmation expiry time in seconds
     */
    function _initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        address _feeRecipient,
        uint256 _feeRate,
        uint256 _confirmExpiry
    ) internal {
        _requireNotZero(_nodeOperatorManager);

        super._initialize(_defaultAdmin, _confirmExpiry);

        _setFeeRate(_feeRate);
        _setFeeRecipient(_feeRecipient);

        _grantRole(NODE_OPERATOR_MANAGER_ROLE, _nodeOperatorManager);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_FEE_EXEMPT_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE, NODE_OPERATOR_MANAGER_ROLE);
    }

    /**
     * @notice The roles that must confirm critical parameter changes in the contract.
     * @return roles is an array of roles that form the confirming roles.
     */
    function confirmingRoles() public pure returns (bytes32[] memory roles) {
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
     * @notice Calculates the current node operator fee amount in ETH.
     *
     * Fee calculation steps:
     * 1. Retrieve latest vault report (totalValue, inOutDelta)
     * 2. Calculate current growth: totalValue - inOutDelta
     * 3. Determine unsettled growth: currentGrowth - settledGrowth
     * 4. Apply fee rate: unsettledGrowth × feeRate / 10000
     *
     * @return fee The amount of ETH accrued as fee
     */
    function accruedFee() public view returns (uint256 fee) {
        (fee,, ) = _calculateFee();
    }

    /**
     * @notice Disburses node operator fees permissionlessly.
     * Can be called by anyone as long as fee is not abnormally high.
     *
     * Fee disbursement steps:
     * 1. Calculate current vault growth from latest report
     * 2. Determine fee amount on unsettled growth
     * 3. Update settled growth to current growth (marking fees as paid)
     * 4. Withdraws fee amount from vault to node operator recipient
     */
    function disburseFee() public {
        (uint256 fee, int256 growth, uint256 abnormallyHighFeeThreshold) = _calculateFee();
        if (fee > abnormallyHighFeeThreshold) revert AbnormallyHighFee();

        _disburseFee(fee, growth, feeRecipient);
    }

    /**
     * @notice Disburses an abnormally high fee as `DEFAULT_ADMIN_ROLE`.
     * Before calling this function, the caller must ensure that the high fee is expected,
     * and the settled growth (used as baseline for fee) is set correctly.
     */
    function disburseAbnormallyHighFee() external onlyRoleMemberOrAdmin(DEFAULT_ADMIN_ROLE) {
        (uint256 fee, int256 growth,) = _calculateFee();
        _disburseFee(fee, growth, feeRecipient);
    }

    /**
     * @notice Updates the node operator's fee rate with dual confirmation.
     * @param _newFeeRate The new fee rate in basis points (max 10000 = 100%)
     * @return bool True if fee rate was updated, false if still awaiting confirmations
     */
    function setFeeRate(uint256 _newFeeRate) external returns (bool) {
        // The report must be fresh so that the total value of the vault is up to date
        // and all the node operator fees are paid out fairly up to the moment of the latest fresh report
        if (!VAULT_HUB.isReportFresh(address(_stakingVault()))) revert ReportStale();

        // Latest fee exemption must be earlier than the latest fresh report timestamp
        if (latestCorrectionTimestamp >= _lazyOracle().latestReportTimestamp()) revert CorrectionAfterReport();

        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        // Disburse any outstanding fees at the current rate before changing it
        disburseFee();

        _setFeeRate(_newFeeRate);

        return true;
    }

    /**
     * @notice Manually corrects the settled growth value with dual confirmation.
     * Used to correct fee calculation and enable fee accrual after reconnection
     *
     * So, in the simplest case the value of settledGrowth before the vault is connected to VaultHub should be set to:
     *
     * sum(validator.balance) + stagedBalance
     *
     * @param _newSettledGrowth The corrected settled growth value
     * @param _expectedSettledGrowth The expected current settled growth
     * @return bool True if correction was applied, false if awaiting confirmations
     */
    function correctSettledGrowth(int256 _newSettledGrowth, int256 _expectedSettledGrowth) external returns (bool) {
        if (settledGrowth != _expectedSettledGrowth) revert UnexpectedSettledGrowth();
        if (!_collectAndCheckConfirmations(msg.data, confirmingRoles())) return false;

        _correctSettledGrowth(_newSettledGrowth);

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
     * @param _newFeeRecipient The new recipient address for fee payments
     */
    function setFeeRecipient(address _newFeeRecipient) external onlyRoleMemberOrAdmin(NODE_OPERATOR_MANAGER_ROLE) {
        _setFeeRecipient(_newFeeRecipient);
    }

    // ==================== Internal Functions ====================

    function _lazyOracle() internal view returns (LazyOracle) {
        return LazyOracle(LIDO_LOCATOR.lazyOracle());
    }

    function _disburseFee(uint256 fee, int256 growth, address _recipient) internal {
        if (fee == 0) {
            // we still need to update the settledGrowth event if the fee is zero
            // to avoid the retroactive fees
            if (growth > settledGrowth) _setSettledGrowth(growth);
            return;
        }

        _setSettledGrowth(growth);
        _doWithdraw(_recipient, fee);

        emit FeeDisbursed(msg.sender, fee, _recipient);
    }

    function _setSettledGrowth(int256 _newSettledGrowth) internal {
        int256 oldSettledGrowth = settledGrowth;
        if (oldSettledGrowth == _newSettledGrowth) revert SameSettledGrowth();

        settledGrowth = _newSettledGrowth.toInt128();

        emit SettledGrowthSet(oldSettledGrowth, _newSettledGrowth);
    }

    /**
     * @dev Set a new settled growth and updates the timestamp.
     * Should be used to correct settled growth for total value change that might not have been reported yet
     */
    function _correctSettledGrowth(int256 _newSettledGrowth) internal {
        _setSettledGrowth(_newSettledGrowth);
        latestCorrectionTimestamp = uint64(block.timestamp);

        emit CorrectionTimestampUpdated(block.timestamp);
    }

    /**
     * @dev Increases settled growth for total value increases not subject to fee,
     * which is why it updates the timestamp to ensure that the exemption comes before
     * the total value report during the fee rate change, which guarantees that the exemption is reported
     * @dev fee exemption can only be positive
     */
    function _addFeeExemption(uint256 _amount) internal {
        if (_amount > uint256(MAX_SANE_SETTLED_GROWTH)) revert UnexpectedFeeExemptionAmount();

        _correctSettledGrowth(settledGrowth + int256(_amount));
    }

    function _calculateFee() internal view returns (uint256 fee, int256 growth, uint256 abnormallyHighFeeThreshold) {
        VaultHub.Report memory report = latestReport();
        // we include quarantined value for fees as well
        uint256 quarantineValue = _lazyOracle().quarantineValue(address(_stakingVault()));
        uint256 totalValueAndQuarantine = uint256(report.totalValue) + quarantineValue;
        growth = int256(totalValueAndQuarantine) - report.inOutDelta;
        int256 unsettledGrowth = growth - settledGrowth;

        if (unsettledGrowth > 0) {
            fee = (uint256(unsettledGrowth) * feeRate) / TOTAL_BASIS_POINTS;
        }

        abnormallyHighFeeThreshold = (totalValueAndQuarantine * ABNORMALLY_HIGH_FEE_THRESHOLD_BP) / TOTAL_BASIS_POINTS;
    }

    function _stopFeeAccrual() internal {
        // effectively stopping fee accrual by setting over the top settledGrowth
        if (settledGrowth < MAX_SANE_SETTLED_GROWTH) _setSettledGrowth(MAX_SANE_SETTLED_GROWTH);
    }

    function _setFeeRate(uint256 _newFeeRate) internal {
        if (_newFeeRate > TOTAL_BASIS_POINTS) revert FeeValueExceed100Percent();

        uint256 oldFeeRate = feeRate;
        uint256 newFeeRate = _newFeeRate;

        feeRate = uint16(newFeeRate);

        emit FeeRateSet(msg.sender, oldFeeRate, newFeeRate);
    }

    function _setFeeRecipient(address _newFeeRecipient) internal {
        _requireNotZero(_newFeeRecipient);
        if (_newFeeRecipient == feeRecipient) revert SameRecipient();

        address oldFeeRecipient = feeRecipient;
        feeRecipient = _newFeeRecipient;
        emit FeeRecipientSet(msg.sender, oldFeeRecipient, _newFeeRecipient);
    }

    // ==================== Events ====================

    /**
     * @dev Emitted when the node operator fee is set.
     * @param sender the address of the sender
     * @param oldFeeRate The old node operator fee rate.
     * @param newFeeRate The new node operator fee rate.
     */
    event FeeRateSet(address indexed sender, uint256 oldFeeRate, uint256 newFeeRate);

    /**
     * @dev Emitted when the node operator fee is disbursed.
     * @param sender the address of the sender
     * @param fee the amount of disbursed fee.
     * @param recipient the address of recipient
     */
    event FeeDisbursed(address indexed sender, uint256 fee, address recipient);

    /**
     * @dev Emitted when the node operator fee recipient is set.
     * @param sender the address of the sender who set the recipient
     * @param oldFeeRecipient the old node operator fee recipient
     * @param newFeeRecipient the new node operator fee recipient
     */
    event FeeRecipientSet(address indexed sender, address oldFeeRecipient, address newFeeRecipient);

    /**
     * @dev Emitted when the settled growth is set.
     * @param oldSettledGrowth the old settled growth
     * @param newSettledGrowth the new settled growth
     */
    event SettledGrowthSet(int256 oldSettledGrowth, int256 newSettledGrowth);

    /**
     * @dev Emitted when the settled growth is corrected.
     * @param timestamp new correction timestamp
     */
    event CorrectionTimestampUpdated(uint256 timestamp);

    // ==================== Errors ====================

    /**
     * @dev Error emitted when the combined feeBPs exceed 100%.
     */
    error FeeValueExceed100Percent();

    /**
     * @dev Error emitted when trying to disburse an abnormally high fee.
     */
    error AbnormallyHighFee();

    /**
     * @dev Error emitted when trying to set same value for recipient
     */
    error SameRecipient();

    /**
     * @dev Error emitted when trying to set same value for settled growth
     */
    error SameSettledGrowth();

    /**
     * @dev Error emitted when the report is stale.
     */
    error ReportStale();

    /**
     * @dev Error emitted when the correction is made after the report.
     */
    error CorrectionAfterReport();

    /**
     * @dev Error emitted when the settled growth does not match the expected value.
     */
    error UnexpectedSettledGrowth();

    /**
     * @dev Error emitted when the fee exemption amount does not match the expected value
     */
    error UnexpectedFeeExemptionAmount();
}
