// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {Dashboard} from "./Dashboard.sol";

/**
 * @title Delegation
 * @notice This contract is a contract-owner of StakingVault and includes an additional delegation layer.
 *
 * The contract provides administrative functions for managing the staking vault,
 * including funding, withdrawing, depositing to the beacon chain, minting, burning,
 * rebalancing operations, and fee management. All these functions are only callable
 * by accounts with the appropriate roles.
 * TODO: comments
 */
contract Delegation is Dashboard {
    uint256 constant TOTAL_BASIS_POINTS = 10000;
    uint256 private constant MAX_FEE = TOTAL_BASIS_POINTS;

    bytes32 public constant CURATOR_ROLE = keccak256("Vault.Delegation.CuratorRole");
    bytes32 public constant STAKER_ROLE = keccak256("Vault.Delegation.StakerRole");
    bytes32 public constant TOKEN_MASTER_ROLE = keccak256("Vault.Delegation.TokenMasterRole");
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.Delegation.OperatorRole");
    bytes32 public constant CLAIM_OPERATOR_DUE_ROLE = keccak256("Vault.Delegation.ClaimOperatorDueRole");

    uint256 public curatorFee;
    IStakingVault.Report public curatorDueClaimedReport;

    uint256 public operatorFee;
    IStakingVault.Report public operatorDueClaimedReport;

    mapping(bytes32 => mapping(bytes32 => uint256)) public votings;
    uint256 public voteLifetime;

    constructor(address _stETH) Dashboard(_stETH) {}

    function initialize(address _stakingVault) external override {
        _initialize(_stakingVault);

        // the next line implies that the msg.sender is an operator
        // however, the msg.sender is the VaultFactory
        _grantRole(OPERATOR_ROLE, msg.sender);
        _setRoleAdmin(OPERATOR_ROLE, OPERATOR_ROLE);
        _setRoleAdmin(CLAIM_OPERATOR_DUE_ROLE, OPERATOR_ROLE);

        voteLifetime = 7 days;
    }

    function curatorDue() public view returns (uint256) {
        return _calculateDue(curatorFee, curatorDueClaimedReport);
    }

    function operatorDue() public view returns (uint256) {
        return _calculateDue(operatorFee, operatorDueClaimedReport);
    }

    function unreserved() public view returns (uint256) {
        uint256 reserved = stakingVault.locked() + curatorDue() + operatorDue();
        uint256 valuation = stakingVault.valuation();

        return reserved > valuation ? 0 : valuation - reserved;
    }

    function voteLifetimeCommittee() public pure returns (bytes32[] memory committee) {
        committee = new bytes32[](2);
        committee[0] = CURATOR_ROLE;
        committee[1] = OPERATOR_ROLE;

        return committee;
    }

    function ownershipTransferCommittee() public pure returns (bytes32[] memory committee) {
        committee = new bytes32[](2);
        committee[0] = CURATOR_ROLE;
        committee[1] = OPERATOR_ROLE;
    }

    function operatorFeeCommittee() public pure returns (bytes32[] memory committee) {
        committee = new bytes32[](2);
        committee[0] = CURATOR_ROLE;
        committee[1] = OPERATOR_ROLE;
    }

    function fund() external payable override onlyRole(STAKER_ROLE) {
        _fund();
    }

    function withdraw(address _recipient, uint256 _ether) external override onlyRole(STAKER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        uint256 withdrawable = unreserved();
        if (_ether > withdrawable) revert RequestedAmountExceedsUnreserved();
        if (_ether > address(stakingVault).balance) revert InsufficientBalance();

        _withdraw(_recipient, _ether);
    }

    function mint(
        address _recipient,
        uint256 _amountOfShares
    ) external payable override onlyRole(TOKEN_MASTER_ROLE) fundAndProceed {
        _mint(_recipient, _amountOfShares);
    }

    function burn(uint256 _amountOfShares) external override onlyRole(TOKEN_MASTER_ROLE) {
        _burn(_amountOfShares);
    }

    function rebalanceVault(uint256 _ether) external payable override onlyRole(CURATOR_ROLE) fundAndProceed {
        _rebalanceVault(_ether);
    }

    function setVoteLifetime(uint256 _newVoteLifetime) external onlyIfVotedBy(voteLifetimeCommittee()) {
        uint256 oldVoteLifetime = voteLifetime;
        voteLifetime = _newVoteLifetime;

        emit VoteLifetimeSet(oldVoteLifetime, _newVoteLifetime);
    }

    function setCuratorFee(uint256 _newCuratorFee) external onlyRole(CURATOR_ROLE) {
        if (_newCuratorFee + operatorFee > MAX_FEE) revert CombinedFeesExceed100Percent();
        if (curatorDue() > 0) revert CuratorDueUnclaimed();
        uint256 oldCuratorFee = curatorFee;
        curatorFee = _newCuratorFee;

        emit CuratorFeeSet(oldCuratorFee, _newCuratorFee);
    }

    function setOperatorFee(uint256 _newOperatorFee) external onlyIfVotedBy(operatorFeeCommittee()) {
        if (_newOperatorFee + curatorFee > MAX_FEE) revert CombinedFeesExceed100Percent();
        if (operatorDue() > 0) revert OperatorDueUnclaimed();
        uint256 oldOperatorFee = operatorFee;
        operatorFee = _newOperatorFee;

        emit OperatorFeeSet(oldOperatorFee, _newOperatorFee);
    }

    function claimCuratorDue(address _recipient) external onlyRole(CURATOR_ROLE) {
        uint256 due = curatorDue();
        curatorDueClaimedReport = stakingVault.latestReport();
        _claimDue(_recipient, due);
    }

    function claimOperatorDue(address _recipient) external onlyRole(CLAIM_OPERATOR_DUE_ROLE) {
        uint256 due = operatorDue();
        operatorDueClaimedReport = stakingVault.latestReport();
        _claimDue(_recipient, due);
    }

    function transferStVaultOwnership(address _newOwner) public override onlyIfVotedBy(ownershipTransferCommittee()) {
        _transferStVaultOwnership(_newOwner);
    }

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

    function _calculateDue(
        uint256 _fee,
        IStakingVault.Report memory _lastClaimedReport
    ) internal view returns (uint256) {
        IStakingVault.Report memory latestReport = stakingVault.latestReport();

        int128 rewardsAccrued = int128(latestReport.valuation - _lastClaimedReport.valuation) -
            (latestReport.inOutDelta - _lastClaimedReport.inOutDelta);

        return rewardsAccrued > 0 ? (uint256(uint128(rewardsAccrued)) * _fee) / TOTAL_BASIS_POINTS : 0;
    }

    function _claimDue(address _recipient, uint256 _due) internal {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_due == 0) revert NoDueToClaim();
        if (_due > address(stakingVault).balance) revert InsufficientBalance();

        _withdraw(_recipient, _due);
    }

    event VoteLifetimeSet(uint256 oldVoteLifetime, uint256 newVoteLifetime);
    event CuratorFeeSet(uint256 oldCuratorFee, uint256 newCuratorFee);
    event OperatorFeeSet(uint256 oldOperatorFee, uint256 newOperatorFee);
    event RoleMemberVoted(address indexed member, bytes32 indexed role, uint256 timestamp, bytes data);

    error NotACommitteeMember();
    error InsufficientBalance();
    error CuratorDueUnclaimed();
    error OperatorDueUnclaimed();
    error CombinedFeesExceed100Percent();
    error RequestedAmountExceedsUnreserved();
    error NoDueToClaim();
}
