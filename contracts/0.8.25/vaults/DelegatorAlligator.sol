// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.0.2/access/extensions/AccessControlEnumerable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

// DelegatorAlligator: Vault Delegated Owner
// 3-Party Role Setup: Manager, Depositor, Operator
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
    error PerformanceDueUnclaimed();
    error ZeroArgument(string);
    error InsufficientWithdrawableAmount(uint256 withdrawable, uint256 requested);
    error InsufficientUnlockedAmount(uint256 unlocked, uint256 requested);
    error VaultNotHealthy();
    error OnlyVaultCanCallOnReportHook();

    uint256 private constant MAX_FEE = 10_000;

    bytes32 public constant MANAGER_ROLE = keccak256("Vault.DelegatorAlligator.ManagerRole");
    bytes32 public constant DEPOSITOR_ROLE = keccak256("Vault.DelegatorAlligator.DepositorRole");
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.DelegatorAlligator.OperatorRole");

    IStakingVault public immutable vault;

    IStakingVault.Report public lastClaimedReport;

    uint256 public managementFee;
    uint256 public performanceFee;

    uint256 public managementDue;

    constructor(address _vault, address _defaultAdmin) {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");

        vault = IStakingVault(_vault);
        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
    }

    /// * * * * * MANAGER FUNCTIONS * * * * * ///

    function transferOwnership(address _newOwner) external onlyRole(MANAGER_ROLE) {
        OwnableUpgradeable(address(vault)).transferOwnership(_newOwner);
    }

    function setManagementFee(uint256 _managementFee) external onlyRole(MANAGER_ROLE) {
        managementFee = _managementFee;
    }

    function setPerformanceFee(uint256 _performanceFee) external onlyRole(MANAGER_ROLE) {
        if (getPerformanceDue() > 0) revert PerformanceDueUnclaimed();

        performanceFee = _performanceFee;
    }

    function getPerformanceDue() public view returns (uint256) {
        IStakingVault.Report memory latestReport = vault.latestReport();

        int128 _performanceDue = int128(latestReport.valuation - lastClaimedReport.valuation) -
            int128(latestReport.inOutDelta - lastClaimedReport.inOutDelta);

        if (_performanceDue > 0) {
            return (uint128(_performanceDue) * performanceFee) / MAX_FEE;
        } else {
            return 0;
        }
    }

    function mint(address _recipient, uint256 _tokens) public payable onlyRole(MANAGER_ROLE) fundAndProceed {
        vault.mint(_recipient, _tokens);
    }

    function burn(uint256 _tokens) external onlyRole(MANAGER_ROLE) {
        vault.burn(_tokens);
    }

    function rebalance(uint256 _ether) external payable onlyRole(MANAGER_ROLE) fundAndProceed {
        vault.rebalance(_ether);
    }

    function claimManagementDue(address _recipient, bool _liquid) external onlyRole(MANAGER_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        if (!vault.isHealthy()) {
            revert VaultNotHealthy();
        }

        uint256 due = managementDue;

        if (due > 0) {
            managementDue = 0;

            if (_liquid) {
                mint(_recipient, due);
            } else {
                _withdrawDue(_recipient, due);
            }
        }
    }

    /// * * * * * DEPOSITOR FUNCTIONS * * * * * ///

    function withdrawable() public view returns (uint256) {
        uint256 reserved = _max(vault.locked(), managementDue + getPerformanceDue());
        uint256 value = vault.valuation();

        if (reserved > value) {
            return 0;
        }

        return value - reserved;
    }

    function fund() public payable onlyRole(DEPOSITOR_ROLE) {
        vault.fund();
    }

    function withdraw(address _recipient, uint256 _ether) external onlyRole(DEPOSITOR_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        if (withdrawable() < _ether) revert InsufficientWithdrawableAmount(withdrawable(), _ether);

        vault.withdraw(_recipient, _ether);
    }

    function exitValidators(uint256 _numberOfValidators) external onlyRole(DEPOSITOR_ROLE) {
        vault.exitValidators(_numberOfValidators);
    }

    /// * * * * * OPERATOR FUNCTIONS * * * * * ///

    function deposit(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external onlyRole(OPERATOR_ROLE) {
        vault.depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    function claimPerformanceDue(address _recipient, bool _liquid) external onlyRole(OPERATOR_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");

        uint256 due = getPerformanceDue();

        if (due > 0) {
            lastClaimedReport = vault.latestReport();

            if (_liquid) {
                mint(_recipient, due);
            } else {
                _withdrawDue(_recipient, due);
            }
        }
    }

    /// * * * * * VAULT CALLBACK * * * * * ///

    function onReport(uint256 _valuation) external {
        if (msg.sender != address(vault)) revert OnlyVaultCanCallOnReportHook();

        managementDue += (_valuation * managementFee) / 365 / MAX_FEE;
    }

    /// * * * * * INTERNAL FUNCTIONS * * * * * ///

    modifier fundAndProceed() {
        if (msg.value > 0) {
            fund();
        }
        _;
    }

    function _withdrawDue(address _recipient, uint256 _ether) internal {
        int256 unlocked = int256(vault.valuation()) - int256(vault.locked());
        uint256 unreserved = unlocked >= 0 ? uint256(unlocked) : 0;
        if (unreserved < _ether) revert InsufficientUnlockedAmount(unreserved, _ether);

        vault.withdraw(_recipient, _ether);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
