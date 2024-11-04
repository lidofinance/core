// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.0.2/access/extensions/AccessControlEnumerable.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {VaultDashboard} from "./VaultDashboard.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

// TODO: natspec

// VaultStaffRoom: Delegates vault operations to different parties:
// - Manager: primary owner of the vault, manages ownership, disconnects from hub, sets fees
// - Funder: can fund the vault, withdraw, mint and rebalance the vault
// - Operator: can claim performance due and assigns Keymaster sub-role
// - Keymaster: Operator's sub-role for depositing to beacon chain
contract VaultStaffRoom is VaultDashboard {
    uint256 private constant BP_BASE = 100_00;
    uint256 private constant MAX_FEE = BP_BASE;

    bytes32 public constant FUNDER_ROLE = keccak256("Vault.VaultStaffRoom.FunderRole");
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.VaultStaffRoom.OperatorRole");
    bytes32 public constant KEYMASTER_ROLE = keccak256("Vault.VaultStaffRoom.KeymasterRole");

    IStakingVault.Report public lastClaimedReport;

    uint256 public managementFee;
    uint256 public performanceFee;
    uint256 public managementDue;

    constructor(
        address _stakingVault,
        address _defaultAdmin,
        address _stETH
    ) VaultDashboard(_stakingVault, _defaultAdmin, _stETH) {
        _setRoleAdmin(KEYMASTER_ROLE, OPERATOR_ROLE);
    }

    /// * * * * * MANAGER FUNCTIONS * * * * * ///

    function setManagementFee(uint256 _newManagementFee) external onlyRole(MANAGER_ROLE) {
        if (_newManagementFee > MAX_FEE) revert NewFeeCannotExceedMaxFee();

        managementFee = _newManagementFee;
    }

    function setPerformanceFee(uint256 _newPerformanceFee) external onlyRole(MANAGER_ROLE) {
        if (_newPerformanceFee > MAX_FEE) revert NewFeeCannotExceedMaxFee();
        if (performanceDue() > 0) revert PerformanceDueUnclaimed();

        performanceFee = _newPerformanceFee;
    }

    function performanceDue() public view returns (uint256) {
        IStakingVault.Report memory latestReport = stakingVault.latestReport();

        int128 _performanceDue = int128(latestReport.valuation - lastClaimedReport.valuation) -
            (latestReport.inOutDelta - lastClaimedReport.inOutDelta);

        if (_performanceDue > 0) {
            return (uint128(_performanceDue) * performanceFee) / BP_BASE;
        } else {
            return 0;
        }
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

    /// * * * * * FUNDER FUNCTIONS * * * * * ///

    function fund() external payable override onlyRole(FUNDER_ROLE) {
        stakingVault.fund{value: msg.value}();
    }

    function withdrawable() public view returns (uint256) {
        uint256 reserved = Math256.max(stakingVault.locked(), managementDue + performanceDue());
        uint256 value = stakingVault.valuation();

        if (reserved > value) {
            return 0;
        }

        return value - reserved;
    }

    function withdraw(address _recipient, uint256 _ether) external override onlyRole(FUNDER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        if (withdrawable() < _ether) revert InsufficientWithdrawableAmount(withdrawable(), _ether);

        stakingVault.withdraw(_recipient, _ether);
    }

    function requestValidatorExit(bytes calldata _validatorPublicKey) external override onlyRole(FUNDER_ROLE) {
        stakingVault.requestValidatorExit(_validatorPublicKey);
    }

    /// FUNDER & MANAGER FUNCTIONS ///

    function mint(
        address _recipient,
        uint256 _tokens
    ) external payable override onlyRoles(MANAGER_ROLE, FUNDER_ROLE) fundAndProceed returns (uint256 locked) {
        return vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, _tokens);
    }

    function burn(uint256 _tokens) external override onlyRoles(MANAGER_ROLE, FUNDER_ROLE) {
        stETH.transferFrom(msg.sender, address(vaultHub), _tokens);
        vaultHub.burnStethBackedByVault(address(stakingVault), _tokens);
    }

    function rebalanceVault(
        uint256 _ether
    ) external payable override onlyRoles(MANAGER_ROLE, FUNDER_ROLE) fundAndProceed {
        stakingVault.rebalance{value: msg.value}(_ether);
    }

    /// * * * * * KEYMAKER FUNCTIONS * * * * * ///

    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external override onlyRole(KEYMASTER_ROLE) {
        stakingVault.depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    /// * * * * * OPERATOR FUNCTIONS * * * * * ///

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

    /// * * * * * VAULT CALLBACK * * * * * ///

    function onReport(uint256 _valuation) external {
        if (msg.sender != address(stakingVault)) revert OnlyVaultCanCallOnReportHook();

        managementDue += (_valuation * managementFee) / 365 / BP_BASE;
    }

    /// * * * * * INTERNAL FUNCTIONS * * * * * ///

    modifier onlyRoles(bytes32 _role1, bytes32 _role2) {
        if (hasRole(_role1, msg.sender) || hasRole(_role2, msg.sender)) {
            _;
        }

        revert SenderHasNeitherRole(msg.sender, _role1, _role2);
    }

    function _withdrawDue(address _recipient, uint256 _ether) internal {
        int256 unlocked = int256(stakingVault.valuation()) - int256(stakingVault.locked());
        uint256 unreserved = unlocked >= 0 ? uint256(unlocked) : 0;
        if (unreserved < _ether) revert InsufficientUnlockedAmount(unreserved, _ether);

        stakingVault.withdraw(_recipient, _ether);
    }

    error SenderHasNeitherRole(address account, bytes32 role1, bytes32 role2);
    error NewFeeCannotExceedMaxFee();
    error PerformanceDueUnclaimed();
    error InsufficientUnlockedAmount(uint256 unlocked, uint256 requested);
    error VaultNotHealthy();
    error OnlyVaultCanCallOnReportHook();
    error FeeCannotExceed100();
}
