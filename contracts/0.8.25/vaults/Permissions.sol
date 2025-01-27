// SPDX-License-Identifier: GPL-3.0
// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlVoteable} from "contracts/0.8.25/utils/AccessControlVoteable.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {VaultHub} from "./VaultHub.sol";
import {ILido as IStETH} from "../interfaces/ILido.sol";

/**
 * @title Permissions
 * @author Lido
 * @notice Provides granular permissions for StakingVault operations.
 */
abstract contract Permissions is AccessControlVoteable {
    /**
     * @notice Permission for funding the StakingVault.
     */
    bytes32 public constant FUND_ROLE = keccak256("StakingVault.Permissions.Fund");

    /**
     * @notice Permission for withdrawing funds from the StakingVault.
     */
    bytes32 public constant WITHDRAW_ROLE = keccak256("StakingVault.Permissions.Withdraw");

    /**
     * @notice Permission for minting stETH shares backed by the StakingVault.
     */
    bytes32 public constant MINT_ROLE = keccak256("StakingVault.Permissions.Mint");

    /**
     * @notice Permission for burning stETH shares backed by the StakingVault.
     */
    bytes32 public constant BURN_ROLE = keccak256("StakingVault.Permissions.Burn");

    /**
     * @notice Permission for rebalancing the StakingVault.
     */
    bytes32 public constant REBALANCE_ROLE = keccak256("StakingVault.Permissions.Rebalance");

    /**
     * @notice Permission for requesting validator exit from the StakingVault.
     */
    bytes32 public constant REQUEST_VALIDATOR_EXIT_ROLE = keccak256("StakingVault.Permissions.RequestValidatorExit");

    /**
     * @notice Permission for voluntary disconnecting the StakingVault.
     */
    bytes32 public constant VOLUNTARY_DISCONNECT_ROLE = keccak256("StakingVault.Permissions.VoluntaryDisconnect");

    function _stakingVault() internal view virtual returns (IStakingVault);

    function _vaultHub() internal view virtual returns (VaultHub);

    function _stETH() internal view virtual returns (IStETH);

    function _votingCommittee() internal pure virtual returns (bytes32[] memory);

    function _fund(uint256 _ether) internal onlyRole(FUND_ROLE) {
        _stakingVault().fund{value: _ether}();
    }

    function _withdraw(address _recipient, uint256 _ether) internal virtual onlyRole(WITHDRAW_ROLE) {
        _stakingVault().withdraw(_recipient, _ether);
    }

    function _mint(address _recipient, uint256 _shares) internal onlyRole(MINT_ROLE) {
        _vaultHub().mintSharesBackedByVault(address(_stakingVault()), _recipient, _shares);
    }

    function _burn(uint256 _shares) internal onlyRole(BURN_ROLE) {
        _vaultHub().burnSharesBackedByVault(address(_stakingVault()), _shares);
    }

    function _rebalanceVault(uint256 _ether) internal onlyRole(REBALANCE_ROLE) {
        _stakingVault().rebalance(_ether);
    }

    function _requestValidatorExit(bytes calldata _pubkey) internal onlyRole(REQUEST_VALIDATOR_EXIT_ROLE) {
        _stakingVault().requestValidatorExit(_pubkey);
    }

    function _voluntaryDisconnect() internal onlyRole(VOLUNTARY_DISCONNECT_ROLE) {
        uint256 shares = _vaultHub().vaultSocket(address(_stakingVault())).sharesMinted;

        if (shares > 0) {
            _rebalanceVault(_stETH().getPooledEthBySharesRoundUp(shares));
        }

        _vaultHub().voluntaryDisconnect(address(_stakingVault()));
    }

    function _transferOwnership(address _newOwner) internal onlyIfVotedBy(_votingCommittee()) {
        OwnableUpgradeable(address(_stakingVault())).transferOwnership(_newOwner);
    }
}
