// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.0.2/access/extensions/AccessControlEnumerable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IReportReceiver} from "./interfaces/IReportReceiver.sol";
import {VaultDashboard} from "./VaultDashboard.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

// TODO: natspec
// TODO: events

// VaultDelegationLayer: Delegates vault operations to different parties:
// - Manager: manages fees
// - Staker: can fund the vault and withdraw funds
// - Operator: can claim performance due and assigns Keymaster sub-role
// - Keymaster: Operator's sub-role for depositing to beacon chain
// - Plumber: manages liquidity, i.e. mints and burns stETH
// - Lido DAO: acts on behalf of Lido DAO (Lido Agent, EasyTrack, etc.)
contract VaultDelegationLayer is VaultDashboard, IReportReceiver {
    uint256 private constant BP_BASE = 100_00;
    uint256 private constant MAX_FEE = BP_BASE;

    bytes32 public constant STAKER_ROLE = keccak256("Vault.VaultDelegationLayer.StakerRole");
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.VaultDelegationLayer.OperatorRole");
    bytes32 public constant KEY_MASTER_ROLE = keccak256("Vault.VaultDelegationLayer.KeyMasterRole");
    bytes32 public constant TOKEN_MASTER_ROLE = keccak256("Vault.VaultDelegationLayer.TokenMasterRole");
    bytes32 public constant LIDO_DAO_ROLE = keccak256("Vault.VaultDelegationLayer.LidoDAORole");

    IStakingVault.Report public lastClaimedReport;

    uint256 public managementFee;
    uint256 public performanceFee;
    uint256 public managementDue;

    mapping(bytes32 callId => mapping(bytes32 role => uint256 timestamp)) public votings;

    constructor(address _stETH) VaultDashboard(_stETH) {}

    // TODO: adding fix LIDO DAO role
    function initialize(address _defaultAdmin, address _stakingVault) external override {
        _initialize(_defaultAdmin, _stakingVault);
        _setRoleAdmin(KEY_MASTER_ROLE, OPERATOR_ROLE);
        _setRoleAdmin(OPERATOR_ROLE, LIDO_DAO_ROLE);
    }

    /// * * * * * VIEW FUNCTIONS * * * * * ///

    function withdrawable() public view returns (uint256) {
        uint256 reserved = Math256.max(stakingVault.locked(), managementDue + performanceDue());
        uint256 value = stakingVault.valuation();

        if (reserved > value) {
            return 0;
        }

        return value - reserved;
    }

    function performanceDue() public view returns (uint256) {
        IStakingVault.Report memory latestReport = stakingVault.latestReport();

        int128 rewardsAccrued = int128(latestReport.valuation - lastClaimedReport.valuation) -
            (latestReport.inOutDelta - lastClaimedReport.inOutDelta);

        if (rewardsAccrued > 0) {
            return (uint128(rewardsAccrued) * performanceFee) / BP_BASE;
        } else {
            return 0;
        }
    }

    function ownershipTransferCommittee() public pure returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](3);

        roles[0] = MANAGER_ROLE;
        roles[1] = OPERATOR_ROLE;
        roles[2] = LIDO_DAO_ROLE;

        return roles;
    }

    function performanceFeeCommittee() public pure returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](2);

        roles[0] = MANAGER_ROLE;
        roles[1] = OPERATOR_ROLE;

        return roles;
    }

    function setManagementFee(uint256 _newManagementFee) external onlyRole(MANAGER_ROLE) {
        if (_newManagementFee > MAX_FEE) revert NewFeeCannotExceedMaxFee();

        managementFee = _newManagementFee;
    }

    function setPerformanceFee(uint256 _newPerformanceFee) external onlyIfVotedBy(performanceFeeCommittee(), 7 days) {
        if (_newPerformanceFee > MAX_FEE) revert NewFeeCannotExceedMaxFee();
        if (performanceDue() > 0) revert PerformanceDueUnclaimed();

        performanceFee = _newPerformanceFee;
    }

    function claimManagementDue(address _recipient, bool _liquid) external onlyRole(MANAGER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        if (!stakingVault.isHealthy()) {
            revert VaultNotHealthy();
        }

        uint256 due = managementDue;

        if (due > 0) {
            managementDue = 0;

            if (_liquid) {
                vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, due);
            } else {
                _withdrawDue(_recipient, due);
            }
        }
    }

    function fund() external payable override onlyRole(STAKER_ROLE) {
        stakingVault.fund{value: msg.value}();
    }

    function withdraw(address _recipient, uint256 _ether) external override onlyRole(STAKER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        if (withdrawable() < _ether) revert InsufficientWithdrawableAmount(withdrawable(), _ether);

        stakingVault.withdraw(_recipient, _ether);
    }

    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external override onlyRole(KEY_MASTER_ROLE) {
        stakingVault.depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    function claimPerformanceDue(address _recipient, bool _liquid) external onlyRole(OPERATOR_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        uint256 due = performanceDue();

        if (due > 0) {
            lastClaimedReport = stakingVault.latestReport();

            if (_liquid) {
                vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, due);
            } else {
                _withdrawDue(_recipient, due);
            }
        }
    }

    function mint(
        address _recipient,
        uint256 _tokens
    ) external payable override onlyRole(TOKEN_MASTER_ROLE) fundAndProceed {
        vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, _tokens);
    }

    function burn(uint256 _tokens) external override onlyRole(TOKEN_MASTER_ROLE) {
        stETH.transferFrom(msg.sender, address(vaultHub), _tokens);
        vaultHub.burnStethBackedByVault(address(stakingVault), _tokens);
    }

    // solhint-disable-next-line no-unused-vars
    function onReport(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        if (msg.sender != address(stakingVault)) revert OnlyVaultCanCallOnReportHook();

        managementDue += (_valuation * managementFee) / 365 / BP_BASE;
    }

    function transferStakingVaultOwnership(
        address _newOwner
    ) public override onlyIfVotedBy(ownershipTransferCommittee(), 7 days) {
        OwnableUpgradeable(address(stakingVault)).transferOwnership(_newOwner);
    }

    /// * * * * * INTERNAL FUNCTIONS * * * * * ///

    function _withdrawDue(address _recipient, uint256 _ether) internal {
        int256 unlocked = int256(stakingVault.valuation()) - int256(stakingVault.locked());
        uint256 unreserved = unlocked >= 0 ? uint256(unlocked) : 0;
        if (unreserved < _ether) revert InsufficientUnlockedAmount(unreserved, _ether);

        stakingVault.withdraw(_recipient, _ether);
    }

    /// @notice Requires approval from all committee members within a voting period
    /// @dev Uses a bitmap to track new votes within the call instead of updating storage immediately,
    ///      this way we avoid unnecessary storage writes if the vote is deciding
    ///      because the votes will reset anyway
    /// @param _committee Array of role identifiers that form the voting committee
    /// @param _votingPeriod Time window in seconds during which votes remain valid
    /// @custom:throws UnauthorizedCaller if caller has none of the committee roles
    /// @custom:security Votes expire after _votingPeriod seconds to prevent stale approvals
    modifier onlyIfVotedBy(bytes32[] memory _committee, uint256 _votingPeriod) {
        bytes32 callId = keccak256(msg.data);
        uint256 committeeSize = _committee.length;
        uint256 votingStart = block.timestamp - _votingPeriod;
        uint256 voteTally = 0;
        uint256 votesToUpdateBitmap = 0;

        for (uint256 i = 0; i < committeeSize; ++i) {
            bytes32 role = _committee[i];

            if (super.hasRole(role, msg.sender)) {
                voteTally++;
                votesToUpdateBitmap |= (1 << i);

                emit RoleMemberVoted(msg.sender, role, block.timestamp, msg.data);
            } else if (votings[callId][role] >= votingStart) {
                voteTally++;
            }
        }

        if (votesToUpdateBitmap == 0) revert UnauthorizedCaller();

        if (voteTally == committeeSize) {
            for (uint256 i = 0; i < committeeSize; ++i) {
                bytes32 role = _committee[i];
                delete votings[callId][role];
            }
            _;
        } else {
            for (uint256 i = 0; i < committeeSize; ++i) {
                if ((votesToUpdateBitmap & (1 << i)) != 0) {
                    bytes32 role = _committee[i];
                    votings[callId][role] = block.timestamp;
                }
            }
        }
    }

    /// * * * * * EVENTS * * * * * ///

    event RoleMemberVoted(address member, bytes32 role, uint256 timestamp, bytes data);

    /// * * * * * ERRORS * * * * * ///

    error UnauthorizedCaller();
    error NewFeeCannotExceedMaxFee();
    error PerformanceDueUnclaimed();
    error InsufficientUnlockedAmount(uint256 unlocked, uint256 requested);
    error VaultNotHealthy();
    error OnlyVaultCanCallOnReportHook();
    error FeeCannotExceed100();
}
