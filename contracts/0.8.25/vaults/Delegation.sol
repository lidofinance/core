// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IReportReceiver} from "./interfaces/IReportReceiver.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {Dashboard} from "./Dashboard.sol";

/**
 * @title Delegation
 * @notice This contract serves as an owner for `StakingVault` with additional delegation capabilities.
 * It extends `Dashboard` and implements `IReportReceiver`.
 * The contract provides administrative functions for managing the staking vault,
 * including funding, withdrawing, depositing to the beacon chain, minting, burning,
 * rebalancing operations, and fee management. All these functions are only callable
 * by accounts with the appropriate roles.
 *
 * @notice `IReportReceiver` is implemented to receive reports from the staking vault, which in turn
 * receives the report from the vault hub. We need the report to calculate the accumulated management due.
 *
 * @notice The term "fee" is used to express the fee percentage as basis points, e.g. 5%,
 * while "due" is the actual amount of the fee, e.g. 1 ether
 */
contract Delegation is Dashboard, IReportReceiver {
    // ==================== Constants ====================

    uint256 private constant TOTAL_BASIS_POINTS = 10000; // Basis points base (100%)
    uint256 private constant MAX_FEE = TOTAL_BASIS_POINTS; // Maximum fee in basis points (100%)

    // ==================== Roles ====================

    /**
     * @notice Role for the manager.
     * Manager manages the vault on behalf of the owner.
     * Manager can:
     * - set the management fee
     * - claim the management due
     * - disconnect the vault from the vault hub
     * - rebalance the vault
     * - vote on ownership transfer
     * - vote on performance fee changes
     */
    bytes32 public constant MANAGER_ROLE = keccak256("Vault.Delegation.ManagerRole");

    /**
     * @notice Role for the staker.
     * Staker can:
     * - fund the vault
     * - withdraw from the vault
     */
    bytes32 public constant STAKER_ROLE = keccak256("Vault.Delegation.StakerRole");

    /**
     * @notice Role for the node operator
     * Node operator can:
     * - claim the performance due
     * - vote on performance fee changes
     * - vote on ownership transfer
     */
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.Delegation.OperatorRole");

    /**
     * @notice Role for the token master.
     * Token master can:
     * - mint stETH tokens
     * - burn stETH tokens
     */
    bytes32 public constant TOKEN_MASTER_ROLE = keccak256("Vault.Delegation.TokenMasterRole");

    // ==================== State Variables ====================

    /// @notice The last report for which the performance due was claimed
    IStakingVault.Report public lastClaimedReport;

    /// @notice Management fee in basis points
    uint256 public managementFee;

    /// @notice Performance fee in basis points
    uint256 public performanceFee;

    /**
     * @notice Accumulated management fee due amount
     * Management due is calculated as a percentage (`managementFee`) of the vault valuation increase
     * since the last report.
     */
    uint256 public managementDue;

    // ==================== Voting ====================

    /// @notice Tracks votes for function calls requiring multi-role approval.
    mapping(bytes32 => mapping(bytes32 => uint256)) public votings;

    // ==================== Initialization ====================

    /**
     * @notice Constructor sets the stETH token address.
     * @param _stETH Address of the stETH token contract.
     */
    constructor(address _stETH) Dashboard(_stETH) {}

    /**
     * @notice Initializes the contract with the default admin and `StakingVault` address.
     * Sets up roles and role administrators.
     * @param _stakingVault Address of the `StakingVault` contract.
     * @dev This function is called by the `VaultFactory` contract
     */
    function initialize(address _stakingVault) external override {
        _initialize(_stakingVault);

        // `OPERATOR_ROLE` is set to `msg.sender` to allow the `VaultFactory` to set the initial operator fee
        // the role will be revoked from `VaultFactory`
        _grantRole(OPERATOR_ROLE, msg.sender);
        _setRoleAdmin(OPERATOR_ROLE, OPERATOR_ROLE);
    }

    // ==================== View Functions ====================

    /**
     * @notice Returns the amount of ether that can be withdrawn from the vault
     * accounting for the locked amount, the management due and the performance due.
     * @return The withdrawable amount in ether.
     */
    function withdrawable() public view returns (uint256) {
        // Question: shouldn't we reserve both locked + dues, not max(locked, dues)?
        uint256 reserved = Math256.max(stakingVault.locked(), managementDue + performanceDue());
        uint256 valuation = stakingVault.valuation();

        if (reserved > valuation) {
            return 0;
        }

        return valuation - reserved;
    }

    /**
     * @notice Calculates the performance fee due based on the latest report.
     * @return The performance fee due in ether.
     */
    function performanceDue() public view returns (uint256) {
        IStakingVault.Report memory latestReport = stakingVault.latestReport();

        int128 rewardsAccrued = int128(latestReport.valuation - lastClaimedReport.valuation) -
            (latestReport.inOutDelta - lastClaimedReport.inOutDelta);

        if (rewardsAccrued > 0) {
            return (uint128(rewardsAccrued) * performanceFee) / TOTAL_BASIS_POINTS;
        } else {
            return 0;
        }
    }

    /**
     * @notice Returns the committee roles required for transferring the ownership of the staking vault.
     * @return An array of role identifiers.
     */
    function ownershipTransferCommittee() public pure returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](2);
        roles[0] = MANAGER_ROLE;
        roles[1] = OPERATOR_ROLE;
        return roles;
    }

    /**
     * @notice Returns the committee roles required for performance fee changes.
     * @return An array of role identifiers.
     */
    function performanceFeeCommittee() public pure returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](2);
        roles[0] = MANAGER_ROLE;
        roles[1] = OPERATOR_ROLE;
        return roles;
    }

    // ==================== Fee Management ====================

    /**
     * @notice Sets the management fee.
     * @param _newManagementFee The new management fee in basis points.
     */
    function setManagementFee(uint256 _newManagementFee) external onlyRole(MANAGER_ROLE) {
        if (_newManagementFee > MAX_FEE) revert NewFeeCannotExceedMaxFee();
        managementFee = _newManagementFee;
    }

    /**
     * @notice Sets the performance fee.
     * @param _newPerformanceFee The new performance fee in basis points.
     */
    function setPerformanceFee(uint256 _newPerformanceFee) external onlyIfVotedBy(performanceFeeCommittee(), 7 days) {
        if (_newPerformanceFee > MAX_FEE) revert NewFeeCannotExceedMaxFee();
        if (performanceDue() > 0) revert PerformanceDueUnclaimed();
        performanceFee = _newPerformanceFee;
    }

    /**
     * @notice Claims the accumulated management fee.
     * @param _recipient Address of the recipient.
     * @param _liquid If true, mints stETH tokens; otherwise, withdraws ether.
     */
    function claimManagementDue(address _recipient, bool _liquid) external onlyRole(MANAGER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (!stakingVault.isBalanced()) revert VaultUnbalanced();

        uint256 due = managementDue;

        if (due > 0) {
            managementDue = 0;

            if (_liquid) {
                _mint(_recipient, STETH.getSharesByPooledEth(due));
            } else {
                _withdrawDue(_recipient, due);
            }
        }
    }

    // ==================== Vault Management Functions ====================

    /**
     * @notice Transfers ownership of the staking vault to a new owner.
     * Requires approval from the ownership transfer committee.
     * @param _newOwner Address of the new owner.
     */
    function transferStVaultOwnership(
        address _newOwner
    ) public override onlyIfVotedBy(ownershipTransferCommittee(), 7 days) {
        _transferStVaultOwnership(_newOwner);
    }

    /**
     * @notice Disconnects the staking vault from the vault hub.
     */
    function voluntaryDisconnect() external payable override onlyRole(MANAGER_ROLE) fundAndProceed {
        _voluntaryDisconnect();
    }

    // ==================== Vault Operations ====================

    /**
     * @notice Funds the staking vault with ether.
     */
    function fund() external payable override onlyRole(STAKER_ROLE) {
        _fund();
    }

    /**
     * @notice Withdraws ether from the staking vault to a recipient.
     * @param _recipient Address of the recipient.
     * @param _ether Amount of ether to withdraw.
     */
    function withdraw(address _recipient, uint256 _ether) external override onlyRole(STAKER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        uint256 available = withdrawable();
        if (available < _ether) revert InsufficientWithdrawableAmount(available, _ether);

        _withdraw(_recipient, _ether);
    }

    /**
     * @notice Claims the performance fee due.
     * @param _recipient Address of the recipient.
     * @param _liquid If true, mints stETH tokens; otherwise, withdraws ether.
     */
    function claimPerformanceDue(address _recipient, bool _liquid) external onlyRole(OPERATOR_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        uint256 due = performanceDue();

        if (due > 0) {
            lastClaimedReport = stakingVault.latestReport();

            if (_liquid) {
                _mint(_recipient, STETH.getSharesByPooledEth(due));
            } else {
                _withdrawDue(_recipient, due);
            }
        }
    }

    /**
     * @notice Mints stETH shares backed by the vault to a recipient.
     * @param _recipient Address of the recipient.
     * @param _amountOfShares Amount of shares to mint.
     */
    function mint(
        address _recipient,
        uint256 _amountOfShares
    ) external payable override onlyRole(TOKEN_MASTER_ROLE) fundAndProceed {
        _mint(_recipient, _amountOfShares);
    }

    /**
     * @notice Burns stETH shares from the sender backed by the vault.
     * @param _amountOfShares Amount of shares to burn.
     */
    function burn(uint256 _amountOfShares) external override onlyRole(TOKEN_MASTER_ROLE) {
        _burn(_amountOfShares);
    }

    /**
     * @notice Rebalances the vault by transferring ether.
     * @param _ether Amount of ether to rebalance.
     */
    function rebalanceVault(uint256 _ether) external payable override onlyRole(MANAGER_ROLE) fundAndProceed {
        _rebalanceVault(_ether);
    }

    // ==================== Report Handling ====================

    /**
     * @notice Hook called by the staking vault during the report in the staking vault.
     * @param _valuation The new valuation of the vault.
     */
    function onReport(uint256 _valuation, int256 /*_inOutDelta*/, uint256 /*_locked*/) external {
        if (msg.sender != address(stakingVault)) revert OnlyStVaultCanCallOnReportHook();

        managementDue += (_valuation * managementFee) / 365 / TOTAL_BASIS_POINTS;
    }

    // ==================== Internal Functions ====================

    /**
     * @dev Withdraws the due amount to a recipient, ensuring sufficient unlocked funds.
     * @param _recipient Address of the recipient.
     * @param _ether Amount of ether to withdraw.
     */
    function _withdrawDue(address _recipient, uint256 _ether) internal {
        int256 unlocked = int256(stakingVault.valuation()) - int256(stakingVault.locked());
        uint256 unreserved = unlocked >= 0 ? uint256(unlocked) : 0;
        if (unreserved < _ether) revert InsufficientUnlockedAmount(unreserved, _ether);

        _withdraw(_recipient, _ether);
    }

    /**
     * @dev Modifier that implements a mechanism for multi-role committee approval.
     * Each unique function call (identified by msg.data: selector + arguments) requires
     * approval from all committee role members within a specified time window.
     *
     * The voting process works as follows:
     * 1. When a committee member calls the function:
     *    - Their vote is counted immediately
     *    - If not enough votes exist, their vote is recorded
     *    - If they're not a committee member, the call reverts
     *
     * 2. Vote counting:
     *    - Counts the current caller's votes if they're a committee member
     *    - Counts existing votes that are within the voting period
     *    - All votes must occur within the same voting period window
     *
     * 3. Execution:
     *    - If all committee members have voted within the period, executes the function
     *    - On successful execution, clears all voting state for this call
     *    - If not enough votes, stores the current votes
     *    - Thus, if the caller has all the roles, the function is executed immediately
     *
     * 4. Gas Optimization:
     *    - Votes are stored in a deferred manner using a memory array
     *    - Vote storage writes only occur if the function cannot be executed immediately
     *    - This prevents unnecessary storage writes when all votes are present,
     *      because the votes are cleared anyway after the function is executed,
     *    - i.e. this optimization is beneficial for the deciding caller and
     *      saves 1 storage write for each role the deciding caller has
     *
     * @param _committee Array of role identifiers that form the voting committee
     * @param _votingPeriod Time window in seconds during which votes remain valid
     *
     * @notice Votes expire after the voting period and must be recast
     * @notice All committee members must vote within the same voting period
     * @notice Only committee members can initiate votes
     *
     * @custom:security-note Each unique function call (including parameters) requires its own set of votes
     */
    modifier onlyIfVotedBy(bytes32[] memory _committee, uint256 _votingPeriod) {
        bytes32 callId = keccak256(msg.data);
        uint256 committeeSize = _committee.length;
        uint256 votingStart = block.timestamp - _votingPeriod;
        uint256 voteTally = 0;
        bool[] memory deferredVotes = new bool[](committeeSize);
        bool isCommitteeMember = false;

        for (uint256 i = 0; i < committeeSize; ++i) {
            bytes32 role = _committee[i];

            if (super.hasRole(role, msg.sender)) {
                isCommitteeMember = true;
                voteTally++;
                deferredVotes[i] = true;

                emit RoleMemberVoted(msg.sender, role, block.timestamp, msg.data);
            } else if (votings[callId][role] >= votingStart) {
                voteTally++;
            }
        }

        if (!isCommitteeMember) revert NotACommitteeMember();

        if (voteTally == committeeSize) {
            for (uint256 i = 0; i < committeeSize; ++i) {
                bytes32 role = _committee[i];
                delete votings[callId][role];
            }
            _;
        } else {
            for (uint256 i = 0; i < committeeSize; ++i) {
                if (deferredVotes[i]) {
                    bytes32 role = _committee[i];
                    votings[callId][role] = block.timestamp;
                }
            }
        }
    }

    // ==================== Events ====================

    /// @notice Emitted when a role member votes on a function requiring committee approval.
    event RoleMemberVoted(address member, bytes32 role, uint256 timestamp, bytes data);

    // ==================== Errors ====================

    /// @notice Thrown if the caller is not a member of the committee.
    error NotACommitteeMember();

    /// @notice Thrown if the new fee exceeds the maximum allowed fee.
    error NewFeeCannotExceedMaxFee();

    /// @notice Thrown if the performance due is unclaimed.
    error PerformanceDueUnclaimed();

    /// @notice Thrown if the unlocked amount is insufficient.
    /// @param unlocked The amount that is unlocked.
    /// @param requested The amount requested to withdraw.
    error InsufficientUnlockedAmount(uint256 unlocked, uint256 requested);

    /// @notice Error when the vault is not balanced.
    error VaultUnbalanced();

    /// @notice Hook can only be called by the staking vault.
    error OnlyStVaultCanCallOnReportHook();
}
