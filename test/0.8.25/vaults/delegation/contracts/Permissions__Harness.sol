// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Permissions} from "contracts/0.8.25/vaults/delegation/Permissions.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

contract Permissions__Harness is Permissions {
    address private immutable STAKING_VAULT;

    constructor(address _defaultAdmin, address _stakingVault) {
        STAKING_VAULT = _stakingVault;
        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
    }

    function stakingVault() public view override returns (IStakingVault) {
        return IStakingVault(STAKING_VAULT);
    }

    function vaultHub() public view override returns (VaultHub) {
        return VaultHub(stakingVault().vaultHub());
    }

    function confirmingRoles() public pure override returns (bytes32[] memory roles) {
        roles = new bytes32[](1);
        roles[0] = DEFAULT_ADMIN_ROLE;
    }

    function fund() public payable {
        _fund(msg.value);
    }

    function withdraw(address _recipient, uint256 _ether) public {
        _withdraw(_recipient, _ether);
    }

    function mintShares(address _recipient, uint256 _shares) public {
        _mintShares(_recipient, _shares);
    }

    function burnShares(uint256 _shares) public {
        _burnShares(_shares);
    }

    function rebalanceVault(uint256 _ether) public {
        _rebalanceVault(_ether);
    }

    function pauseBeaconChainDeposits() public {
        _pauseBeaconChainDeposits();
    }

    function resumeBeaconChainDeposits() public {
        _resumeBeaconChainDeposits();
    }

    function requestValidatorExit(bytes calldata _pubkeys) public {
        _requestValidatorExit(_pubkeys);
    }

    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) public payable {
        _triggerValidatorWithdrawal(_pubkeys, _amounts, _refundRecipient);
    }

    function voluntaryDisconnect() public {
        _voluntaryDisconnect();
    }

    function compensateDisprovenPredepositFromPDG(bytes calldata _pubkey, address _recipient) public returns (uint256) {
        return _compensateDisprovenPredepositFromPDG(_pubkey, _recipient);
    }

    function transferStakingVaultOwnership(address _newOwner) public {
        _transferStakingVaultOwnership(_newOwner);
    }
}
