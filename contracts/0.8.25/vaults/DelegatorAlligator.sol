// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {IVault} from "./interfaces/IVault.sol";
import {ILiquidVault} from "./interfaces/ILiquidVault.sol";

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
    error Zero(string);
    error InsufficientWithdrawableAmount(uint256 withdrawable, uint256 requested);
    error InsufficientUnlockedAmount(uint256 unlocked, uint256 requested);

    uint256 private constant MAX_FEE = 10_000;

    bytes32 public constant MANAGER_ROLE = keccak256("Vault.DelegatorAlligator.ManagerRole");
    bytes32 public constant DEPOSITOR_ROLE = keccak256("Vault.DelegatorAlligator.DepositorRole");
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.DelegatorAlligator.OperatorRole");
    bytes32 public constant VAULT_ROLE = keccak256("Vault.DelegatorAlligator.VaultRole");

    address payable public vault;

    ILiquidVault.Report public lastClaimedReport;

    uint256 public managementFee;
    uint256 public performanceFee;

    uint256 public managementDue;

    constructor(address payable _vault, address _admin) {
        vault = _vault;

        _grantRole(VAULT_ROLE, _vault);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// * * * * * MANAGER FUNCTIONS * * * * * ///

    function setManagementFee(uint256 _managementFee) external onlyRole(MANAGER_ROLE) {
        managementFee = _managementFee;
    }

    function setPerformanceFee(uint256 _performanceFee) external onlyRole(MANAGER_ROLE) {
        performanceFee = _performanceFee;

        if (getPerformanceDue() > 0) revert PerformanceDueUnclaimed();
    }

    function getPerformanceDue() public view returns (uint256) {
        ILiquidVault.Report memory latestReport = ILiquidVault(vault).getLatestReport();

        int128 _performanceDue = int128(latestReport.valuation - lastClaimedReport.valuation) -
            int128(latestReport.inOutDelta - lastClaimedReport.inOutDelta);

        if (_performanceDue > 0) {
            return (uint128(_performanceDue) * performanceFee) / MAX_FEE;
        } else {
            return 0;
        }
    }

    function mint(address _receiver, uint256 _amountOfTokens) public payable onlyRole(MANAGER_ROLE) {
        ILiquidVault(vault).mint(_receiver, _amountOfTokens);
    }

    function burn(uint256 _amountOfShares) external onlyRole(MANAGER_ROLE) {
        ILiquidVault(vault).burn(_amountOfShares);
    }

    function rebalance(uint256 _amountOfETH) external payable onlyRole(MANAGER_ROLE) {
        ILiquidVault(vault).rebalance(_amountOfETH);
    }

    function claimManagementDue(address _receiver, bool _liquid) external onlyRole(MANAGER_ROLE) {
        // TODO
    }

    /// * * * * * DEPOSITOR FUNCTIONS * * * * * ///

    function getWithdrawableAmount() public view returns (uint256) {
        uint256 reserved = _max(ILiquidVault(vault).getLocked(), managementDue + getPerformanceDue());
        uint256 value = ILiquidVault(vault).valuation();

        if (reserved > value) {
            return 0;
        }

        return value - reserved;
    }

    function fund() external payable onlyRole(DEPOSITOR_ROLE) {
        IVault(vault).fund();
    }

    function withdraw(address _receiver, uint256 _amount) external onlyRole(DEPOSITOR_ROLE) {
        if (_receiver == address(0)) revert Zero("receiver");
        if (_amount == 0) revert Zero("amount");
        if (getWithdrawableAmount() < _amount) revert InsufficientWithdrawableAmount(getWithdrawableAmount(), _amount);

        IVault(vault).withdraw(_receiver, _amount);
    }

    function exitValidators(uint256 _numberOfKeys) external onlyRole(DEPOSITOR_ROLE) {
        IVault(vault).exitValidators(_numberOfKeys);
    }

    /// * * * * * OPERATOR FUNCTIONS * * * * * ///

    function deposit(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external onlyRole(OPERATOR_ROLE) {
        IVault(vault).deposit(_numberOfDeposits, _pubkeys, _signatures);
    }

    function claimPerformanceDue(address _receiver, bool _liquid) external onlyRole(OPERATOR_ROLE) {
        if (_receiver == address(0)) revert Zero("_receiver");

        uint256 due = getPerformanceDue();

        if (due > 0) {
            lastClaimedReport = ILiquidVault(vault).getLatestReport();

            if (_liquid) {
                mint(_receiver, due);
            } else {
                _withdrawFeeInEther(_receiver, due);
            }
        }
    }

    /// * * * * * VAULT CALLBACK * * * * * ///

    function updateManagementDue(uint256 _valuation) external onlyRole(VAULT_ROLE) {
        managementDue += (_valuation * managementFee) / 365 / MAX_FEE;
    }

    /// * * * * * INTERNAL FUNCTIONS * * * * * ///

    function _withdrawFeeInEther(address _receiver, uint256 _amountOfTokens) internal {
        int256 unlocked = int256(ILiquidVault(vault).valuation()) - int256(ILiquidVault(vault).getLocked());
        uint256 canWithdrawFee = unlocked >= 0 ? uint256(unlocked) : 0;
        if (canWithdrawFee < _amountOfTokens) revert InsufficientUnlockedAmount(canWithdrawFee, _amountOfTokens);
        IVault(vault).withdraw(_receiver, _amountOfTokens);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
