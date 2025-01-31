// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {Dashboard} from "./Dashboard.sol";

/**
 * @title Delegation
 * @notice This contract is a contract-owner of StakingVault and includes an additional delegation layer.
 *
 * The delegation hierarchy is as follows:
 * - DEFAULT_ADMIN_ROLE is the underlying owner of StakingVault;
 * - NODE_OPERATOR_MANAGER_ROLE is the node operator manager of StakingVault; and itself is the role admin,
 * and the DEFAULT_ADMIN_ROLE cannot assign NODE_OPERATOR_MANAGER_ROLE;
 * - NODE_OPERATOR_FEE_CLAIMER_ROLE is the role that can claim node operator fee; is assigned by NODE_OPERATOR_MANAGER_ROLE;
 *
 * Additionally, the following roles are assigned by DEFAULT_ADMIN_ROLE:
 * - CURATOR_ROLE is the curator of StakingVault and perfoms some operations on behalf of DEFAULT_ADMIN_ROLE;
 * - FUND_WITHDRAW_ROLE funds and withdraws from the StakingVault;
 * - MINT_BURN_ROLE mints and burns shares of stETH backed by the StakingVault;
 *
 * The curator and node operator have their respective fees.
 * The feeBP is the percentage (in basis points) of the StakingVault rewards.
 * The unclaimed fee is the amount of ether that is owed to the curator or node operator based on the feeBP.
 */
contract Delegation is Dashboard {
    /**
     * @notice Maximum combined feeBP value; equals to 100%.
     */
    uint256 private constant MAX_FEE_BP = TOTAL_BASIS_POINTS;

    /**
     * @notice Curator role:
     * - sets curator fee;
     * - claims curator fee;
     * - confirms confirm lifetime;
     * - confirms node operator fee;
     * - confirms ownership transfer;
     * - pauses deposits to beacon chain;
     * - resumes deposits to beacon chain.
     */
    bytes32 public constant CURATOR_ROLE = keccak256("vaults.Delegation.CuratorRole");

    /**
     * @notice Node operator manager role:
     * - confirms confirm lifetime;
     * - confirms node operator fee;
     * - confirms ownership transfer;
     * - assigns NODE_OPERATOR_FEE_CLAIMER_ROLE.
     */
    bytes32 public constant NODE_OPERATOR_MANAGER_ROLE = keccak256("vaults.Delegation.NodeOperatorManagerRole");

    /**
     * @notice Node operator fee claimer role:
     * - claims node operator fee.
     */
    bytes32 public constant NODE_OPERATOR_FEE_CLAIMER_ROLE = keccak256("vaults.Delegation.NodeOperatorFeeClaimerRole");

    /**
     * @notice Curator fee in basis points; combined with node operator fee cannot exceed 100%.
     * The curator's unclaimed fee in ether is returned by `curatorUnclaimedFee()`.
     */
    uint256 public curatorFeeBP;

    /**
     * @notice The last report for which curator fee was claimed. Updated on each claim.
     */
    IStakingVault.Report public curatorFeeClaimedReport;

    /**
     * @notice Node operator fee in basis points; combined with curator fee cannot exceed 100%, or 10,000 basis points.
     * The node operator's unclaimed fee in ether is returned by `nodeOperatorUnclaimedFee()`.
     */
    uint256 public nodeOperatorFeeBP;

    /**
     * @notice The last report for which node operator fee was claimed. Updated on each claim.
     */
    IStakingVault.Report public nodeOperatorFeeClaimedReport;

    /**
     * @notice Constructs the contract.
     * @dev Stores token addresses in the bytecode to reduce gas costs.
     * @param _weth Address of the weth token contract.
     * @param _lidoLocator Address of the Lido locator contract.
     */
    constructor(address _weth, address _lidoLocator) Dashboard(_weth, _lidoLocator) {}

    /**
     * @notice Initializes the contract:
     * - sets up the roles;
     * - sets the confirm lifetime to 7 days (can be changed later by CURATOR_ROLE and NODE_OPERATOR_MANAGER_ROLE).
     * @dev The msg.sender here is VaultFactory. The VaultFactory is temporarily granted
     * DEFAULT_ADMIN_ROLE AND NODE_OPERATOR_MANAGER_ROLE to be able to set initial fees and roles in VaultFactory.
     * All the roles are revoked from VaultFactory by the end of the initialization.
     */
    function initialize(address _defaultAdmin, uint256 _confirmLifetime) external override {
        _initialize(_defaultAdmin, _confirmLifetime);

        // the next line implies that the msg.sender is an operator
        // however, the msg.sender is the VaultFactory, and the role will be revoked
        // at the end of the initialization
        _grantRole(NODE_OPERATOR_MANAGER_ROLE, _defaultAdmin);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_FEE_CLAIMER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
    }

    /**
     * @notice Returns the accumulated unclaimed curator fee in ether,
     * calculated as: U = (R * F) / T
     * where:
     * - U is the curator unclaimed fee;
     * - R is the StakingVault rewards accrued since the last curator fee claim;
     * - F is `curatorFeeBP`;
     * - T is the total basis points, 10,000.
     * @return uint256: the amount of unclaimed fee in ether.
     */
    function curatorUnclaimedFee() public view returns (uint256) {
        return _calculateFee(curatorFeeBP, curatorFeeClaimedReport);
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
        return _calculateFee(nodeOperatorFeeBP, nodeOperatorFeeClaimedReport);
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
        uint256 reserved = stakingVault().locked() + curatorUnclaimedFee() + nodeOperatorUnclaimedFee();
        uint256 valuation = stakingVault().valuation();

        return reserved > valuation ? 0 : valuation - reserved;
    }

    /**
     * @notice Sets the confirm lifetime.
     * Confirm lifetime is a period during which the confirm is counted. Once the period is over,
     * the confirm is considered expired, no longer counts and must be recasted.
     * @param _newConfirmLifetime The new confirm lifetime in seconds.
     */
    function setConfirmLifetime(uint256 _newConfirmLifetime) external onlyMutuallyConfirmed(_confirmingRoles()) {
        _setConfirmLifetime(_newConfirmLifetime);
    }

    /**
     * @notice Sets the curator fee.
     * The curator fee is the percentage (in basis points) of curator's share of the StakingVault rewards.
     * The curator and node operator fees combined cannot exceed 100%, or 10,000 basis points.
     * The function will revert if the curator fee is unclaimed.
     * @param _newCuratorFeeBP The new curator fee in basis points.
     */
    function setCuratorFeeBP(uint256 _newCuratorFeeBP) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_newCuratorFeeBP + nodeOperatorFeeBP > MAX_FEE_BP) revert CombinedFeesExceed100Percent();
        if (curatorUnclaimedFee() > 0) revert CuratorFeeUnclaimed();
        uint256 oldCuratorFeeBP = curatorFeeBP;
        curatorFeeBP = _newCuratorFeeBP;

        emit CuratorFeeBPSet(msg.sender, oldCuratorFeeBP, _newCuratorFeeBP);
    }

    /**
     * @notice Sets the node operator fee.
     * The node operator fee is the percentage (in basis points) of node operator's share of the StakingVault rewards.
     * The node operator fee combined with the curator fee cannot exceed 100%.
     * Note that the function reverts if the node operator fee is unclaimed and all the confirms must be recasted to execute it again,
     * which is why the deciding confirm must make sure that `nodeOperatorUnclaimedFee()` is 0 before calling this function.
     * @param _newNodeOperatorFeeBP The new node operator fee in basis points.
     */
    function setNodeOperatorFeeBP(uint256 _newNodeOperatorFeeBP) external onlyMutuallyConfirmed(_confirmingRoles()) {
        if (_newNodeOperatorFeeBP + curatorFeeBP > MAX_FEE_BP) revert CombinedFeesExceed100Percent();
        if (nodeOperatorUnclaimedFee() > 0) revert NodeOperatorFeeUnclaimed();
        uint256 oldNodeOperatorFeeBP = nodeOperatorFeeBP;
        nodeOperatorFeeBP = _newNodeOperatorFeeBP;

        emit NodeOperatorFeeBPSet(msg.sender, oldNodeOperatorFeeBP, _newNodeOperatorFeeBP);
    }

    /**
     * @notice Claims the curator fee.
     * @param _recipient The address to which the curator fee will be sent.
     */
    function claimCuratorFee(address _recipient) external onlyRole(CURATOR_ROLE) {
        uint256 fee = curatorUnclaimedFee();
        curatorFeeClaimedReport = stakingVault().latestReport();
        _claimFee(_recipient, fee);
    }

    /**
     * @notice Claims the node operator fee.
     * Note that the authorized role is NODE_OPERATOR_FEE_CLAIMER_ROLE, not NODE_OPERATOR_MANAGER_ROLE,
     * although NODE_OPERATOR_MANAGER_ROLE is the admin role for NODE_OPERATOR_FEE_CLAIMER_ROLE.
     * @param _recipient The address to which the node operator fee will be sent.
     */
    function claimNodeOperatorFee(address _recipient) external onlyRole(NODE_OPERATOR_FEE_CLAIMER_ROLE) {
        uint256 fee = nodeOperatorUnclaimedFee();
        nodeOperatorFeeClaimedReport = stakingVault().latestReport();
        _claimFee(_recipient, fee);
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
     * @dev Calculates the curator/node operator fee amount based on the fee and the last claimed report.
     * @param _feeBP The fee in basis points.
     * @param _lastClaimedReport The last claimed report.
     * @return The accrued fee amount.
     */
    function _calculateFee(
        uint256 _feeBP,
        IStakingVault.Report memory _lastClaimedReport
    ) internal view returns (uint256) {
        IStakingVault.Report memory latestReport = stakingVault().latestReport();

        int128 rewardsAccrued = int128(latestReport.valuation - _lastClaimedReport.valuation) -
            (latestReport.inOutDelta - _lastClaimedReport.inOutDelta);

        return rewardsAccrued > 0 ? (uint256(uint128(rewardsAccrued)) * _feeBP) / TOTAL_BASIS_POINTS : 0;
    }

    /**
     * @dev Claims the curator/node operator fee amount.
     * @param _recipient The address to which the fee will be sent.
     * @param _fee The accrued fee amount.
     * @dev Use `Permissions._unsafeWithdraw()` to avoid the `WITHDRAW_ROLE` check.
     */
    function _claimFee(address _recipient, uint256 _fee) internal onlyIfUnreserved(_fee) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_fee == 0) revert ZeroArgument("_fee");

        stakingVault().withdraw(_recipient, _fee);
    }

    /**
     * @notice Returns the roles that can:
     * - change the confirm lifetime;
     * - set the curator fee;
     * - set the node operator fee;
     * - transfer the ownership of the StakingVault.
     * @return roles is an array of roles that form the confirming roles.
     */
    function _confirmingRoles() internal pure override returns (bytes32[] memory roles) {
        roles = new bytes32[](2);
        roles[0] = CURATOR_ROLE;
        roles[1] = NODE_OPERATOR_MANAGER_ROLE;
    }

    /**
     * @dev Overrides the Permissions' internal withdraw function to add a check for the unreserved amount.
     * Cannot withdraw more than the unreserved amount: which is the amount of ether
     * that is not locked in the StakingVault and not reserved for curator and node operator fees.
     * Does not include a check for the balance of the StakingVault, this check is present
     * on the StakingVault itself.
     * @param _recipient The address to which the ether will be sent.
     * @param _ether The amount of ether to withdraw.
     */
    function _withdraw(address _recipient, uint256 _ether) internal override onlyIfUnreserved(_ether) {
        super._withdraw(_recipient, _ether);
    }

    /**
     * @dev Emitted when the curator fee is set.
     * @param oldCuratorFeeBP The old curator fee.
     * @param newCuratorFeeBP The new curator fee.
     */
    event CuratorFeeBPSet(address indexed sender, uint256 oldCuratorFeeBP, uint256 newCuratorFeeBP);

    /**
     * @dev Emitted when the node operator fee is set.
     * @param oldNodeOperatorFeeBP The old node operator fee.
     * @param newNodeOperatorFeeBP The new node operator fee.
     */
    event NodeOperatorFeeBPSet(address indexed sender, uint256 oldNodeOperatorFeeBP, uint256 newNodeOperatorFeeBP);

    /**
     * @dev Error emitted when the curator fee is unclaimed.
     */
    error CuratorFeeUnclaimed();

    /**
     * @dev Error emitted when the node operator fee is unclaimed.
     */
    error NodeOperatorFeeUnclaimed();

    /**
     * @dev Error emitted when the combined feeBPs exceed 100%.
     */
    error CombinedFeesExceed100Percent();

    /**
     * @dev Error emitted when the requested amount exceeds the unreserved amount.
     */
    error RequestedAmountExceedsUnreserved();
}
