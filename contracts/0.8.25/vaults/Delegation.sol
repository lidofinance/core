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
 * - OPERATOR_ROLE is the node operator of StakingVault; and itself is the role admin,
 * and the DEFAULT_ADMIN_ROLE cannot assign OPERATOR_ROLE;
 * - CLAIM_OPERATOR_DUE_ROLE is the role that can claim operator due; is assigned by OPERATOR_ROLE;
 *
 * Additionally, the following roles are assigned by the owner (DEFAULT_ADMIN_ROLE):
 * - CURATOR_ROLE is the curator of StakingVault empowered by the owner;
 * performs the daily operations of the StakingVault on behalf of the owner;
 * - STAKER_ROLE funds and withdraws from the StakingVault;
 * - TOKEN_MASTER_ROLE mints and burns shares of stETH backed by the StakingVault;
 *
 * Operator and Curator have their respective fees and dues.
 * The fee is calculated as a percentage (in basis points) of the StakingVault rewards.
 * The due is the amount of ether that is owed to the Curator or Operator based on the fee.
 */
contract Delegation is Dashboard {

    /**
     * @notice Maximum fee value; equals to 100%.
     */
    uint256 private constant MAX_FEE = TOTAL_BASIS_POINTS;

    /**
     * @notice Curator:
     * - sets curator fee;
     * - votes operator fee;
     * - votes on vote lifetime;
     * - votes on ownership transfer;
     * - claims curator due.
     */
    bytes32 public constant CURATOR_ROLE = keccak256("Vault.Delegation.CuratorRole");

    /**
     * @notice Staker:
     * - funds vault;
     * - withdraws from vault.
     */
    bytes32 public constant STAKER_ROLE = keccak256("Vault.Delegation.StakerRole");

    /**
     * @notice Token master:
     * - mints shares;
     * - burns shares.
     */
    bytes32 public constant TOKEN_MASTER_ROLE = keccak256("Vault.Delegation.TokenMasterRole");

    /**
     * @notice Node operator:
     * - votes on vote lifetime;
     * - votes on operator fee;
     * - votes on ownership transfer;
     * - is the role admin for CLAIM_OPERATOR_DUE_ROLE.
     */
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.Delegation.OperatorRole");

    /**
     * @notice Claim operator due:
     * - claims operator due.
     */
    bytes32 public constant CLAIM_OPERATOR_DUE_ROLE = keccak256("Vault.Delegation.ClaimOperatorDueRole");

    /**
     * @notice Curator fee in basis points; combined with operator fee cannot exceed 100%.
     * The term "fee" is used to represent the percentage (in basis points) of curator's share of the rewards.
     * The term "due" is used to represent the actual amount of fees in ether.
     * The curator due in ether is returned by `curatorDue()`.
     */
    uint256 public curatorFee;

    /**
     * @notice The last report for which curator due was claimed. Updated on each claim.
     */
    IStakingVault.Report public curatorDueClaimedReport;

    /**
     * @notice Operator fee in basis points; combined with curator fee cannot exceed 100%.
     * The term "fee" is used to represent the percentage (in basis points) of operator's share of the rewards.
     * The term "due" is used to represent the actual amount of fees in ether.
     * The operator due in ether is returned by `operatorDue()`.
     */
    uint256 public operatorFee;

    /**
     * @notice The last report for which operator due was claimed. Updated on each claim.
     */
    IStakingVault.Report public operatorDueClaimedReport;

    /**
     * @notice Tracks committee votes
     * - callId: unique identifier for the call, derived as `keccak256(msg.data)`
     * - role: role that voted
     * - voteTimestamp: timestamp of the vote.
     * The term "voting" refers to the entire voting process through which vote-restricted actions are performed.
     * The term "vote" refers to a single individual vote cast by a committee member.
     */
    mapping(bytes32 callId => mapping(bytes32 role => uint256 voteTimestamp)) public votings;

    /**
     * @notice Vote lifetime in seconds; after this period, the vote expires and no longer counts.
     */
    uint256 public voteLifetime;

    /**
     * @notice Initializes the contract with the weth address.
     * @param _weth Address of the weth token contract.
     * @param _lidoLocator Address of the Lido locator contract.
     */
    constructor(address _weth, address _lidoLocator) Dashboard(_weth, _lidoLocator) {}

    /**
     * @notice Initializes the contract:
     * - sets the address of StakingVault;
     * - sets up the roles;
     * - sets the vote lifetime to 7 days (can be changed later by CURATOR_ROLE and OPERATOR_ROLE).
     * @param _stakingVault The address of StakingVault.
     * @dev The msg.sender here is VaultFactory. It is given the OPERATOR_ROLE
     * to be able to set initial operatorFee in VaultFactory, because only OPERATOR_ROLE
     * is the admin role for itself. The rest of the roles are also temporarily given to
     * VaultFactory to be able to set initial config in VaultFactory.
     * All the roles are revoked from VaultFactory at the end of the initialization.
     */
    function initialize(address _stakingVault) external override {
        _initialize(_stakingVault);

        // the next line implies that the msg.sender is an operator
        // however, the msg.sender is the VaultFactory, and the role will be revoked
        // at the end of the initialization
        _grantRole(OPERATOR_ROLE, msg.sender);
        _setRoleAdmin(OPERATOR_ROLE, OPERATOR_ROLE);
        _setRoleAdmin(CLAIM_OPERATOR_DUE_ROLE, OPERATOR_ROLE);

        voteLifetime = 7 days;
    }

    /**
     * @notice Returns the accumulated curator due in ether,
     * calculated as: CD = (SVR * CF) / TBP
     * where:
     * - CD is the curator due;
     * - SVR is the StakingVault rewards accrued since the last curator due claim;
     * - CF is the curator fee in basis points;
     * - TBP is the total basis points (100%).
     * @return uint256: the amount of due ether.
     */
    function curatorDue() public view returns (uint256) {
        return _calculateDue(curatorFee, curatorDueClaimedReport);
    }

    /**
     * @notice Returns the accumulated operator due in ether,
     * calculated as: OD = (SVR * OF) / TBP
     * where:
     * - OD is the operator due;
     * - SVR is the StakingVault rewards accrued since the last operator due claim;
     * - OF is the operator fee in basis points;
     * - TBP is the total basis points (100%).
     * @return uint256: the amount of due ether.
     */
    function operatorDue() public view returns (uint256) {
        return _calculateDue(operatorFee, operatorDueClaimedReport);
    }

    /**
     * @notice Returns the unreserved amount of ether,
     * i.e. the amount of ether that is not locked in the StakingVault
     * and not reserved for curator due and operator due.
     * This amount does not account for the current balance of the StakingVault and
     * can return a value greater than the actual balance of the StakingVault.
     * @return uint256: the amount of unreserved ether.
     */
    function unreserved() public view returns (uint256) {
        uint256 reserved = stakingVault.locked() + curatorDue() + operatorDue();
        uint256 valuation = stakingVault.valuation();

        return reserved > valuation ? 0 : valuation - reserved;
    }

    /**
     * @notice Returns the committee that can:
     * - change the vote lifetime;
     * - set the operator fee;
     * - transfer the ownership of the StakingVault.
     * @return committee is an array of roles that form the voting committee.
     */
    function votingCommittee() public pure returns (bytes32[] memory committee) {
        committee = new bytes32[](2);
        committee[0] = CURATOR_ROLE;
        committee[1] = OPERATOR_ROLE;
    }

    /**
     * @notice Funds the StakingVault with ether.
     */
    function fund() external payable override onlyRole(STAKER_ROLE) {
        _fund(msg.value);
    }

    /**
     * @notice Withdraws ether from the StakingVault.
     * Cannot withdraw more than the unreserved amount: which is the amount of ether
     * that is not locked in the StakingVault and not reserved for curator due and operator due.
     * Does not include a check for the balance of the StakingVault, this check is present
     * on the StakingVault itself.
     * @param _recipient The address to which the ether will be sent.
     * @param _ether The amount of ether to withdraw.
     */
    function withdraw(address _recipient, uint256 _ether) external override onlyRole(STAKER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        uint256 withdrawable = unreserved();
        if (_ether > withdrawable) revert RequestedAmountExceedsUnreserved();

        _withdraw(_recipient, _ether);
    }

    /**
     * @notice Mints shares for a given recipient.
     * This function works with shares of StETH, not the tokens.
     * For conversion rates, please refer to the official documentation: docs.lido.fi.
     * @param _recipient The address to which the shares will be minted.
     * @param _amountOfShares The amount of shares to mint.
     */
    function mint(
        address _recipient,
        uint256 _amountOfShares
    ) external payable override onlyRole(TOKEN_MASTER_ROLE) fundAndProceed {
        _mint(_recipient, _amountOfShares);
    }

    /**
     * @notice Burns shares for a given recipient.
     * This function works with shares of StETH, not the tokens.
     * For conversion rates, please refer to the official documentation: docs.lido.fi.
     * NB: Delegation contract must have ERC-20 approved allowance to burn sender's shares.
     * @param _amountOfShares The amount of shares to burn.
     */
    function burn(uint256 _amountOfShares) external override onlyRole(TOKEN_MASTER_ROLE) {
        _burn(msg.sender, _amountOfShares);
    }

    /**
     * @notice Rebalances the StakingVault with a given amount of ether.
     * @param _ether The amount of ether to rebalance with.
     */
    function rebalanceVault(uint256 _ether) external payable override onlyRole(CURATOR_ROLE) fundAndProceed {
        _rebalanceVault(_ether);
    }

    /**
     * @notice Sets the vote lifetime.
     * Vote lifetime is a period during which the vote is counted. Once the period is over,
     * the vote is considered expired, no longer counts and must be recasted for the voting to go through.
     * @param _newVoteLifetime The new vote lifetime in seconds.
     */
    function setVoteLifetime(uint256 _newVoteLifetime) external onlyIfVotedBy(votingCommittee()) {
        uint256 oldVoteLifetime = voteLifetime;
        voteLifetime = _newVoteLifetime;

        emit VoteLifetimeSet(msg.sender, oldVoteLifetime, _newVoteLifetime);
    }

    /**
     * @notice Sets the curator fee.
     * The curator fee is the percentage (in basis points) of curator's share of the StakingVault rewards.
     * The curator fee combined with the operator fee cannot exceed 100%.
     * The curator due must be claimed before the curator fee can be changed to avoid
     * @param _newCuratorFee The new curator fee in basis points.
     */
    function setCuratorFee(uint256 _newCuratorFee) external onlyRole(CURATOR_ROLE) {
        if (_newCuratorFee + operatorFee > MAX_FEE) revert CombinedFeesExceed100Percent();
        if (curatorDue() > 0) revert CuratorDueUnclaimed();
        uint256 oldCuratorFee = curatorFee;
        curatorFee = _newCuratorFee;

        emit CuratorFeeSet(msg.sender, oldCuratorFee, _newCuratorFee);
    }

    /**
     * @notice Sets the operator fee.
     * The operator fee is the percentage (in basis points) of operator's share of the StakingVault rewards.
     * The operator fee combined with the curator fee cannot exceed 100%.
     * Note that the function reverts if the operator due is not claimed and all the votes must be recasted to execute it again,
     * which is why the deciding voter must make sure that the operator due is claimed before calling this function.
     * @param _newOperatorFee The new operator fee in basis points.
     */
    function setOperatorFee(uint256 _newOperatorFee) external onlyIfVotedBy(votingCommittee()) {
        if (_newOperatorFee + curatorFee > MAX_FEE) revert CombinedFeesExceed100Percent();
        if (operatorDue() > 0) revert OperatorDueUnclaimed();
        uint256 oldOperatorFee = operatorFee;
        operatorFee = _newOperatorFee;

        emit OperatorFeeSet(msg.sender, oldOperatorFee, _newOperatorFee);
    }

    /**
     * @notice Claims the curator due.
     * @param _recipient The address to which the curator due will be sent.
     */
    function claimCuratorDue(address _recipient) external onlyRole(CURATOR_ROLE) {
        uint256 due = curatorDue();
        curatorDueClaimedReport = stakingVault.latestReport();
        _claimDue(_recipient, due);
    }

    /**
     * @notice Claims the operator due.
     * Note that the authorized role is CLAIM_OPERATOR_DUE_ROLE, not OPERATOR_ROLE,
     * although OPERATOR_ROLE is the admin role for CLAIM_OPERATOR_DUE_ROLE.
     * @param _recipient The address to which the operator due will be sent.
     */
    function claimOperatorDue(address _recipient) external onlyRole(CLAIM_OPERATOR_DUE_ROLE) {
        uint256 due = operatorDue();
        operatorDueClaimedReport = stakingVault.latestReport();
        _claimDue(_recipient, due);
    }

    /**
     * @notice Transfers the ownership of the StakingVault.
     * This function transfers the ownership of the StakingVault to a new owner which can be an entirely new owner
     * or the same underlying owner (DEFAULT_ADMIN_ROLE) but a different Delegation contract.
     * @param _newOwner The address to which the ownership will be transferred.
     */
    function transferStVaultOwnership(address _newOwner) public override onlyIfVotedBy(votingCommittee()) {
        _transferStVaultOwnership(_newOwner);
    }

    /**
     * @notice Voluntarily disconnects the StakingVault from VaultHub.
     */
    function voluntaryDisconnect() external payable override onlyRole(CURATOR_ROLE) fundAndProceed {
        _voluntaryDisconnect();
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
     *
     * @notice Votes expire after the voting period and must be recast
     * @notice All committee members must vote within the same voting period
     * @notice Only committee members can initiate votes
     *
     * @custom:security-note Each unique function call (including parameters) requires its own set of votes
     */
    modifier onlyIfVotedBy(bytes32[] memory _committee) {
        bytes32 callId = keccak256(msg.data);
        uint256 committeeSize = _committee.length;
        uint256 votingStart = block.timestamp - voteLifetime;
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

    /**
     * @dev Calculates the curator/operatordue amount based on the fee and the last claimed report.
     * @param _fee The fee in basis points.
     * @param _lastClaimedReport The last claimed report.
     * @return The accrued due amount.
     */
    function _calculateDue(
        uint256 _fee,
        IStakingVault.Report memory _lastClaimedReport
    ) internal view returns (uint256) {
        IStakingVault.Report memory latestReport = stakingVault.latestReport();

        int128 rewardsAccrued = int128(latestReport.valuation - _lastClaimedReport.valuation) -
            (latestReport.inOutDelta - _lastClaimedReport.inOutDelta);

        return rewardsAccrued > 0 ? (uint256(uint128(rewardsAccrued)) * _fee) / TOTAL_BASIS_POINTS : 0;
    }

    /**
     * @dev Claims the curator/operator due amount.
     * @param _recipient The address to which the due will be sent.
     * @param _due The accrued due amount.
     */
    function _claimDue(address _recipient, uint256 _due) internal {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_due == 0) revert NoDueToClaim();

        _withdraw(_recipient, _due);
    }

    /**
     * @dev Emitted when the vote lifetime is set.
     * @param oldVoteLifetime The old vote lifetime.
     * @param newVoteLifetime The new vote lifetime.
     */
    event VoteLifetimeSet(address indexed sender, uint256 oldVoteLifetime, uint256 newVoteLifetime);

    /**
     * @dev Emitted when the curator fee is set.
     * @param oldCuratorFee The old curator fee.
     * @param newCuratorFee The new curator fee.
     */
    event CuratorFeeSet(address indexed sender, uint256 oldCuratorFee, uint256 newCuratorFee);

    /**
     * @dev Emitted when the operator fee is set.
     * @param oldOperatorFee The old operator fee.
     * @param newOperatorFee The new operator fee.
     */
    event OperatorFeeSet(address indexed sender, uint256 oldOperatorFee, uint256 newOperatorFee);

    /**
     * @dev Emitted when a committee member votes.
     * @param member The address of the voting member.
     * @param role The role of the voting member.
     * @param timestamp The timestamp of the vote.
     * @param data The msg.data of the vote.
     */
    event RoleMemberVoted(address indexed member, bytes32 indexed role, uint256 timestamp, bytes data);

    /**
     * @dev Error emitted when a caller without a required role attempts to vote.
     */
    error NotACommitteeMember();

    /**
     * @dev Error emitted when the curator due is unclaimed.
     */
    error CuratorDueUnclaimed();

    /**
     * @dev Error emitted when the operator due is unclaimed.
     */
    error OperatorDueUnclaimed();

    /**
     * @dev Error emitted when the combined fees exceed 100%.
     */
    error CombinedFeesExceed100Percent();

    /**
     * @dev Error emitted when the requested amount exceeds the unreserved amount.
     */
    error RequestedAmountExceedsUnreserved();

    /**
     * @dev Error emitted when there is no due to claim.
     */
    error NoDueToClaim();
}
