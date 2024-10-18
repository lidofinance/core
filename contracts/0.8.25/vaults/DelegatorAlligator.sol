// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "../../openzeppelin/nonupgradeable/5.0.2/access/extensions/AccessControlEnumerable.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {ILiquid} from "./interfaces/ILiquid.sol";

interface IRebalanceable {
    function rebalance(uint256 _amountOfETH) external payable;
}

interface IVaultFees {
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
    bytes32 public constant MANAGER_ROLE = keccak256("Vault.DelegatorAlligator.ManagerRole");
    bytes32 public constant DEPOSITOR_ROLE = keccak256("Vault.DelegatorAlligator.DepositorRole");
    bytes32 public constant OPERATOR_ROLE = keccak256("Vault.DelegatorAlligator.OperatorRole");

    address payable public vault;

    constructor(address payable _vault, address _admin) {
        vault = _vault;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// * * * * * MANAGER FUNCTIONS * * * * * ///

    function mint(address _receiver, uint256 _amountOfTokens) external payable onlyRole(MANAGER_ROLE) {
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

    function deposit() external payable onlyRole(DEPOSITOR_ROLE) {
        IStaking(vault).deposit();
    }

    function withdraw(address _receiver, uint256 _etherToWithdraw) external onlyRole(DEPOSITOR_ROLE) {
        IStaking(vault).withdraw(_receiver, _etherToWithdraw);
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

    function claimNodeOperatorFee(address _receiver, bool _liquid) external onlyRole(OPERATOR_ROLE) {
        IVaultFees(vault).claimNodeOperatorFee(_receiver, _liquid);
    }
}
