// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {Permissions} from "contracts/0.8.25/vaults/dashboard/Permissions.sol";

contract Permissions__Harness is Permissions {
    function initialize(address _defaultAdmin, uint256 _confirmExpiry) external {
        _initialize(_defaultAdmin, _confirmExpiry);
    }

    function revertDoubleInitialize(address _defaultAdmin, uint256 _confirmExpiry) external {
        _initialize(_defaultAdmin, _confirmExpiry);
        _initialize(_defaultAdmin, _confirmExpiry);
    }

    function confirmingRoles() public pure override returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = DEFAULT_ADMIN_ROLE;
        return roles;
    }

    function fund(uint256 _ether) external payable {
        _fund(_ether);
    }

    function withdraw(address _recipient, uint256 _ether) external {
        _withdraw(_recipient, _ether);
    }

    function lock(uint256 _locked) external {
        _lock(_locked);
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

    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        _triggerValidatorWithdrawal(_pubkeys, _amounts, _refundRecipient);
    }

    function voluntaryDisconnect() external {
        _voluntaryDisconnect();
    }

    function transferStakingVaultOwnership(address _newOwner) external {
        _transferStakingVaultOwnership(_newOwner);
    }

    function compensateDisprovenPredepositFromPDG(
        bytes calldata _pubkey,
        address _recipient
    ) external returns (uint256) {
        return _compensateDisprovenPredepositFromPDG(_pubkey, _recipient);
    }

    function authorizeLidoVaultHub() external {
        _authorizeLidoVaultHub();
    }

    function ossifyStakingVault() external {
        _ossifyStakingVault();
    }

    function setDepositor(address _depositor) external {
        _setDepositor(_depositor);
    }

    function resetLocked() external {
        _resetLocked();
    }

    function setConfirmExpiry(uint256 _newConfirmExpiry) external {
        _setConfirmExpiry(_newConfirmExpiry);
    }
}
