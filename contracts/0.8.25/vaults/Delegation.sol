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
     * - votes on vote lifetime;
     * - votes on node operator fee;
     * - votes on ownership transfer;
     * - pauses deposits to beacon chain;
     * - resumes deposits to beacon chain.
     */
    bytes32 public constant CURATOR_ROLE = keccak256("Vault.Delegation.CuratorRole");

    /**
     * @notice Mint/burn role:
     * - mints shares of stETH;
     * - burns shares of stETH.
     */
    bytes32 public constant MINT_BURN_ROLE = keccak256("Vault.Delegation.MintBurnRole");

    /**
     * @notice Fund/withdraw role:
     * - funds StakingVault;
     * - withdraws from StakingVault.
     */
    bytes32 public constant FUND_WITHDRAW_ROLE = keccak256("Vault.Delegation.FundWithdrawRole");

    /**
     * @notice Node operator manager role:
     * - votes on vote lifetime;
     * - votes on node operator fee;
     * - votes on ownership transfer;
     * - assigns NODE_OPERATOR_FEE_CLAIMER_ROLE.
     */
    bytes32 public constant NODE_OPERATOR_MANAGER_ROLE = keccak256("Vault.Delegation.NodeOperatorManagerRole");

    /**
     * @notice Node operator fee claimer role:
     * - claims node operator fee.
     */
    bytes32 public constant NODE_OPERATOR_FEE_CLAIMER_ROLE = keccak256("Vault.Delegation.NodeOperatorFeeClaimerRole");

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
     * @notice Constructs the contract.
     * @dev Stores token addresses in the bytecode to reduce gas costs.
     * @param _weth Address of the weth token contract.
     * @param _lidoLocator Address of the Lido locator contract.
     */
    constructor(address _weth, address _lidoLocator) Dashboard(_weth, _lidoLocator) {}

    /**
     * @notice Initializes the contract:
     * - sets up the roles;
     * - sets the vote lifetime to 7 days (can be changed later by CURATOR_ROLE and NODE_OPERATOR_MANAGER_ROLE).
     * @dev The msg.sender here is VaultFactory. The VaultFactory is temporarily granted
     * DEFAULT_ADMIN_ROLE AND NODE_OPERATOR_MANAGER_ROLE to be able to set initial fees and roles in VaultFactory.
     * All the roles are revoked from VaultFactory by the end of the initialization.
     */
    function initialize() external override {
        _initialize();

        // the next line implies that the msg.sender is an operator
        // however, the msg.sender is the VaultFactory, and the role will be revoked
        // at the end of the initialization
        _grantRole(NODE_OPERATOR_MANAGER_ROLE, msg.sender);
        _setRoleAdmin(NODE_OPERATOR_MANAGER_ROLE, NODE_OPERATOR_MANAGER_ROLE);
        _setRoleAdmin(NODE_OPERATOR_FEE_CLAIMER_ROLE, NODE_OPERATOR_MANAGER_ROLE);

        voteLifetime = 7 days;
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
     * @notice Returns the committee that can:
     * - change the vote lifetime;
     * - set the node operator fee;
     * - transfer the ownership of the StakingVault.
     * @return committee is an array of roles that form the voting committee.
     */
    function votingCommittee() public pure returns (bytes32[] memory committee) {
        committee = new bytes32[](2);
        committee[0] = CURATOR_ROLE;
        committee[1] = NODE_OPERATOR_MANAGER_ROLE;
    }

    /**
     * @notice Funds the StakingVault with ether.
     */
    function fund() external payable override onlyRole(FUND_WITHDRAW_ROLE) {
        _fund(msg.value);
    }

    /**
     * @notice Withdraws ether from the StakingVault.
     * Cannot withdraw more than the unreserved amount: which is the amount of ether
     * that is not locked in the StakingVault and not reserved for curator and node operator fees.
     * Does not include a check for the balance of the StakingVault, this check is present
     * on the StakingVault itself.
     * @param _recipient The address to which the ether will be sent.
     * @param _ether The amount of ether to withdraw.
     */
    function withdraw(address _recipient, uint256 _ether) external override onlyRole(FUND_WITHDRAW_ROLE) {
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
    function mintShares(
        address _recipient,
        uint256 _amountOfShares
    ) external payable override onlyRole(MINT_BURN_ROLE) fundAndProceed {
        _mintSharesTo(_recipient, _amountOfShares);
    }

    /**
     * @notice Burns shares for a given recipient.
     * This function works with shares of StETH, not the tokens.
     * For conversion rates, please refer to the official documentation: docs.lido.fi.
     * NB: Delegation contract must have ERC-20 approved allowance to burn sender's shares.
     * @param _amountOfShares The amount of shares to burn.
     */
    function burnShares(uint256 _amountOfShares) external override onlyRole(MINT_BURN_ROLE) {
        _burnSharesFrom(msg.sender, _amountOfShares);
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
     * Note that the function reverts if the node operator fee is unclaimed and all the votes must be recasted to execute it again,
     * which is why the deciding voter must make sure that `nodeOperatorUnclaimedFee()` is 0 before calling this function.
     * @param _newNodeOperatorFeeBP The new node operator fee in basis points.
     */
    function setNodeOperatorFeeBP(uint256 _newNodeOperatorFeeBP) external onlyIfVotedBy(votingCommittee()) {
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
     * @notice Pauses deposits to beacon chain from the StakingVault.
     */
    function pauseBeaconChainDeposits() external override onlyRole(CURATOR_ROLE) {
        _pauseBeaconChainDeposits();
    }

    /**
     * @notice Resumes deposits to beacon chain from the StakingVault.
     */
    function resumeBeaconChainDeposits() external override onlyRole(CURATOR_ROLE) {
        _resumeBeaconChainDeposits();
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
     */
    function _claimFee(address _recipient, uint256 _fee) internal {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_fee == 0) revert ZeroArgument("_fee");

        _withdraw(_recipient, _fee);
    }

    /**
     * @dev Emitted when the vote lifetime is set.
     * @param oldVoteLifetime The old vote lifetime.
     * @param newVoteLifetime The new vote lifetime.
     */
    event VoteLifetimeSet(address indexed sender, uint256 oldVoteLifetime, uint256 newVoteLifetime);

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
