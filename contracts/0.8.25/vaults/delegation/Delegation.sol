// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Math256} from "contracts/common/lib/Math256.sol";

import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {Permissions} from "./Permissions.sol";
import {VaultHub} from "../VaultHub.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";

/**
 * @title Delegation
 * @notice This contract is a contract-owner of StakingVault and includes an additional delegation layer.
 */
contract Delegation is Permissions {
    struct InitializationConfig {
        address defaultAdmin;
        address nodeOperatorManager;
        uint256 nodeOperatorFeeBP;
        uint256 confirmExpiry;
        RoleAssignment[] additionalRoles;
    }

    /**
     * @notice Total basis points; 1bp = 0.01%, 10000bp = 100%.
     */
    uint256 private constant TOTAL_BASIS_POINTS = 10000;

    /**
     * @notice Maximum fee value; equals to 100%.
     */
    uint256 private constant MAX_FEE_BP = TOTAL_BASIS_POINTS;

    /**
     * @notice Node operator manager role:
     * - confirms confirm expiry;
     * - confirms ownership transfer;
     * - is the admin role for NODE_OPERATOR_FEE_CLAIM_ROLE.
     */
    bytes32 public constant NODE_OPERATOR_MANAGER_ROLE = keccak256("vaults.Delegation.NodeOperatorManagerRole");

    /**
     * @notice Claims node operator fee.
     */
    bytes32 public constant NODE_OPERATOR_FEE_CLAIM_ROLE = keccak256("vaults.Delegation.NodeOperatorFeeClaimRole");

    /**
     * @notice Address of the implementation contract
     * @dev Used to prevent initialization in the implementation
     */
    address private immutable _SELF;

    /**
     * @notice Node operator fee in basis points; cannot exceed 100%, or 10,000 basis points.
     * The node operator's unclaimed fee in ether is returned by `nodeOperatorUnclaimedFee()`.
     */
    uint256 public nodeOperatorFeeBP;

    /**
     * @notice The last report for which node operator fee was claimed. Updated on each claim.
     */
    IStakingVault.Report public nodeOperatorFeeClaimedReport;

    /**
     * @notice Indicates whether the contract has been initialized
     */
    bool public initialized;

    constructor() {
        _SELF = address(this);
    }

    function initialize(InitializationConfig memory _config) public virtual {
        if (initialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();
        if (_config.defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");
        if (_config.nodeOperatorManager == address(0)) revert ZeroArgument("_nodeOperatorManager");
        if (_config.nodeOperatorFeeBP > MAX_FEE_BP) revert FeeValueExceed100Percent();

        initialized = true;

        for (uint256 i = 0; i < _config.additionalRoles.length; i++) {
            RoleAssignment memory roleAssignment = _config.additionalRoles[i];
            _grantRole(roleAssignment.role, roleAssignment.account);
        }

        _grantRole(DEFAULT_ADMIN_ROLE, _config.defaultAdmin);
        _grantRole(NODE_OPERATOR_MANAGER_ROLE, _config.nodeOperatorManager);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_FEE_CLAIM_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setConfirmExpiry(_config.confirmExpiry);

        emit Initialized(_config.defaultAdmin);
    }

    function stakingVault() public view override returns (IStakingVault) {
        return IStakingVault(_loadStakingVaultAddress());
    }

    function vaultHub() public view override returns (VaultHub) {
        return VaultHub(stakingVault().vaultHub());
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
     * @dev Loads the address of the underlying StakingVault.
     * @return addr The address of the StakingVault.
     */
    function _loadStakingVaultAddress() internal view returns (address addr) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        assembly {
            addr := mload(add(args, 32))
        }
    }

    /**
     * @dev Emitted when the contract is initialized.
     * @param defaultAdmin The address of the default admin.
     */
    event Initialized(address indexed defaultAdmin);

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
     * @dev Error emitted when the contract is already initialized.
     */
    error AlreadyInitialized();

    /**
     * @dev Error emitted when the contract is called as a proxy.
     */
    error NonProxyCallsForbidden();

    /**
     * @dev Error emitted when the fee is 0.
     */
    error NoUnclaimedFee();
}
