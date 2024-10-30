// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.0.2/access/extensions/AccessControlEnumerable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

// TODO: add NO reward role -> claims due, assign deposit ROLE
//  DEPOSIT ROLE -> depost to beacon chain

// DelegatorAlligator: Vault Delegated Owner
// 3-Party Role Setup: Manager, Depositor, Operator (Keymaker)
//             .-._   _ _ _ _ _ _ _ _
//  .-''-.__.-'00  '-' ' ' ' ' ' ' ' '-.
// '.___ '    .   .--_'-' '-' '-' _'-' '._
//  V: V 'vv-'   '_   '.       .'  _..' '.'.
//    '=.____.=_.--'   :_.__.__:_   '.   : :
//            (((____.-'        '-.  /   : :
//                              (((-'\ .' /
//                            _____..'  .'
//                           '-._____.-'
contract DelegatorAlligator is AccessControlEnumerable {
    error ZeroArgument(string name);
    error NewFeeCannotExceedMaxFee();
    error PerformanceDueUnclaimed();
    error InsufficientWithdrawableAmount(uint256 withdrawable, uint256 requested);
    error InsufficientUnlockedAmount(uint256 unlocked, uint256 requested);
    error VaultNotHealthy();
    error OnlyVaultCanCallOnReportHook();
    error FeeCannotExceed100();

    uint256 private constant BP_BASE = 100_00;
    uint256 private constant MAX_FEE = BP_BASE;

    bytes32 public constant MANAGER_ROLE = keccak256("Vault.DelegatorAlligator.ManagerRole");
    bytes32 public constant FUNDER_ROLE = keccak256("Vault.DelegatorAlligator.FunderRole");
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.DelegatorAlligator.OperatorRole");
    bytes32 public constant KEYMAKER_ROLE = keccak256("Vault.DelegatorAlligator.KeymakerRole");

    IStakingVault public immutable stakingVault;

    IStakingVault.Report public lastClaimedReport;

    uint256 public managementFee;
    uint256 public performanceFee;

    uint256 public managementDue;

    constructor(address _stakingVault, address _defaultAdmin) {
        if (_stakingVault == address(0)) revert ZeroArgument("_stakingVault");
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");

        stakingVault = IStakingVault(_stakingVault);
        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
        _setRoleAdmin(KEYMAKER_ROLE, OPERATOR_ROLE);
    }

    /// * * * * * MANAGER FUNCTIONS * * * * * ///

    function transferOwnershipOverStakingVault(address _newOwner) external onlyRole(MANAGER_ROLE) {
        OwnableUpgradeable(address(stakingVault)).transferOwnership(_newOwner);
    }

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

    function mintSteth(address _recipient, uint256 _steth) public payable onlyRole(MANAGER_ROLE) fundAndProceed {
        stakingVault.mint(_recipient, _steth);
    }

    function burnSteth(uint256 _steth) external onlyRole(MANAGER_ROLE) {
        stakingVault.burn(_steth);
    }

    function rebalance(uint256 _ether) external payable onlyRole(MANAGER_ROLE) fundAndProceed {
        stakingVault.rebalance(_ether);
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
                mintSteth(_recipient, due);
            } else {
                _withdrawDue(_recipient, due);
            }
        }
    }

    /// * * * * * DEPOSITOR FUNCTIONS * * * * * ///

    function withdrawable() public view returns (uint256) {
        uint256 reserved = _max(stakingVault.locked(), managementDue + performanceDue());
        uint256 value = stakingVault.valuation();

        if (reserved > value) {
            return 0;
        }

        return value - reserved;
    }

    function fund() public payable onlyRole(FUNDER_ROLE) {
        stakingVault.fund();
    }

    function withdraw(address _recipient, uint256 _ether) external onlyRole(FUNDER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        if (withdrawable() < _ether) revert InsufficientWithdrawableAmount(withdrawable(), _ether);

        stakingVault.withdraw(_recipient, _ether);
    }

    function exitValidators(uint256 _numberOfValidators) external onlyRole(FUNDER_ROLE) {
        stakingVault.exitValidators(_numberOfValidators);
    }

    /// * * * * * KEYMAKER FUNCTIONS * * * * * ///

    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external onlyRole(KEYMAKER_ROLE) {
        stakingVault.depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    /// * * * * * OPERATOR FUNCTIONS * * * * * ///

    function claimPerformanceDue(address _recipient, bool _liquid) external onlyRole(OPERATOR_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        uint256 due = performanceDue();

        if (due > 0) {
            lastClaimedReport = stakingVault.latestReport();

            if (_liquid) {
                mintSteth(_recipient, due);
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

    modifier fundAndProceed() {
        if (msg.value > 0) {
            fund();
        }
        _;
    }

    function _withdrawDue(address _recipient, uint256 _ether) internal {
        int256 unlocked = int256(stakingVault.valuation()) - int256(stakingVault.locked());
        uint256 unreserved = unlocked >= 0 ? uint256(unlocked) : 0;
        if (unreserved < _ether) revert InsufficientUnlockedAmount(unreserved, _ether);

        stakingVault.withdraw(_recipient, _ether);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
