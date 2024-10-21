// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {ILiquid} from "./interfaces/ILiquid.sol";

interface IRebalanceable {
    function locked() external view returns (uint256);

    function value() external view returns (uint256);

    function rebalance(uint256 _amountOfETH) external payable;
}

interface IVaultFees {
    struct Report {
        uint128 value;
        int128 netCashFlow;
    }

    function lastReport() external view returns (Report memory);

    function lastClaimedReport() external view returns (Report memory);

    function setVaultOwnerFee(uint256 _vaultOwnerFee) external;

    function setNodeOperatorFee(uint256 _nodeOperatorFee) external;

    function claimVaultOwnerFee(address _receiver, bool _liquid) external;

    function claimNodeOperatorFee(address _receiver, bool _liquid) external;
}

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

    address payable public vault;

    IVaultFees.Report public lastClaimedReport;

    uint256 public managementFee;
    uint256 public performanceFee;

    uint256 public managementDue;

    constructor(address payable _vault, address _admin) {
        vault = _vault;

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
        IVaultFees.Report memory lastReport = IVaultFees(vault).lastReport();

        int128 _performanceDue = int128(lastReport.value - lastClaimedReport.value) -
            int128(lastReport.netCashFlow - lastClaimedReport.netCashFlow);

        if (_performanceDue > 0) {
            return (uint128(_performanceDue) * performanceFee) / MAX_FEE;
        } else {
            return 0;
        }
    }

    function mint(address _receiver, uint256 _amountOfTokens) public payable onlyRole(MANAGER_ROLE) {
        ILiquid(vault).mint(_receiver, _amountOfTokens);
    }

    function burn(uint256 _amountOfShares) external onlyRole(MANAGER_ROLE) {
        ILiquid(vault).burn(_amountOfShares);
    }

    function rebalance(uint256 _amountOfETH) external payable onlyRole(MANAGER_ROLE) {
        IRebalanceable(vault).rebalance(_amountOfETH);
    }

    function setVaultOwnerFee(uint256 _vaultOwnerFee) external onlyRole(MANAGER_ROLE) {
        IVaultFees(vault).setVaultOwnerFee(_vaultOwnerFee);
    }

    function setNodeOperatorFee(uint256 _nodeOperatorFee) external onlyRole(MANAGER_ROLE) {
        IVaultFees(vault).setNodeOperatorFee(_nodeOperatorFee);
    }

    function claimVaultOwnerFee(address _receiver, bool _liquid) external onlyRole(MANAGER_ROLE) {
        IVaultFees(vault).claimVaultOwnerFee(_receiver, _liquid);
    }

    /// * * * * * DEPOSITOR FUNCTIONS * * * * * ///

    function getWithdrawableAmount() public view returns (uint256) {
        uint256 reserved = _max(IRebalanceable(vault).locked(), managementDue + getPerformanceDue());
        uint256 value = IRebalanceable(vault).value();

        if (reserved > value) {
            return 0;
        }

        return value - reserved;
    }

    function deposit() external payable onlyRole(DEPOSITOR_ROLE) {
        IStaking(vault).deposit();
    }

    function withdraw(address _receiver, uint256 _amount) external onlyRole(DEPOSITOR_ROLE) {
        if (_receiver == address(0)) revert Zero("receiver");
        if (_amount == 0) revert Zero("amount");
        if (getWithdrawableAmount() < _amount) revert InsufficientWithdrawableAmount(getWithdrawableAmount(), _amount);

        IStaking(vault).withdraw(_receiver, _amount);
    }

    function triggerValidatorExit(uint256 _numberOfKeys) external onlyRole(DEPOSITOR_ROLE) {
        IStaking(vault).triggerValidatorExit(_numberOfKeys);
    }

    /// * * * * * OPERATOR FUNCTIONS * * * * * ///

    function topupValidators(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) external onlyRole(OPERATOR_ROLE) {
        IStaking(vault).topupValidators(_keysCount, _publicKeysBatch, _signaturesBatch);
    }

    function claimPerformanceDue(address _receiver, bool _liquid) external onlyRole(OPERATOR_ROLE) {
        if (_receiver == address(0)) revert Zero("_receiver");

        uint256 due = getPerformanceDue();

        if (due > 0) {
            lastClaimedReport = IVaultFees(vault).lastReport();

            if (_liquid) {
                mint(_receiver, due);
            } else {
                _withdrawFeeInEther(_receiver, due);
            }
        }
    }

    function _withdrawFeeInEther(address _receiver, uint256 _amountOfTokens) internal {
        int256 unlocked = int256(IRebalanceable(vault).value()) - int256(IRebalanceable(vault).locked());
        uint256 canWithdrawFee = unlocked >= 0 ? uint256(unlocked) : 0;
        if (canWithdrawFee < _amountOfTokens) revert InsufficientUnlockedAmount(canWithdrawFee, _amountOfTokens);
        IStaking(vault).withdraw(_receiver, _amountOfTokens);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
