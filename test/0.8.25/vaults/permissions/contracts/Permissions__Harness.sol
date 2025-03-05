// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {Permissions} from "contracts/0.8.25/vaults/Permissions.sol";

contract Permissions__Harness is Permissions {
    function initialize(address _defaultAdmin, uint256 _confirmExpiry) external {
        _initialize(_defaultAdmin, _confirmExpiry);
    }

    function revertDoubleInitialize(address _defaultAdmin, uint256 _confirmExpiry) external {
        _initialize(_defaultAdmin, _confirmExpiry);
        _initialize(_defaultAdmin, _confirmExpiry);
    }

    function confirmingRoles() external pure returns (bytes32[] memory) {
        return _confirmingRoles();
    }

    function fund(uint256 _ether) external payable {
        _fund(_ether);
    }

    function withdraw(address _recipient, uint256 _ether) external {
        _withdraw(_recipient, _ether);
    }

    function mintShares(address _recipient, uint256 _shares) external {
        _mintShares(_recipient, _shares);
    }

    function burnShares(uint256 _shares) external {
        _burnShares(_shares);
    }

    function rebalanceVault(uint256 _ether) external {
        _rebalanceVault(_ether);
    }

    function pauseBeaconChainDeposits() external {
        _pauseBeaconChainDeposits();
    }

    function resumeBeaconChainDeposits() external {
        _resumeBeaconChainDeposits();
    }

    function requestValidatorExit(bytes calldata _pubkey) external {
        _requestValidatorExit(_pubkey);
    }

    function queueSelfDisconnect() external {
        _queueSelfDisconnect();
    }

    function transferStakingVaultOwnership(address _newOwner) external {
        _transferStakingVaultOwnership(_newOwner);
    }

    function setConfirmExpiry(uint256 _newConfirmExpiry) external {
        _setConfirmExpiry(_newConfirmExpiry);
    }
}
