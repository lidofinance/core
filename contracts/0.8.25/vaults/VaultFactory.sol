// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.0.2/proxy/Clones.sol";

import {StakingVault} from "./StakingVault.sol";
import {VaultStaffRoom} from "./VaultStaffRoom.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

pragma solidity 0.8.25;

interface IVaultStaffRoom {
    function initialize(address admin, address stakingVault) external;
}

contract VaultFactory is UpgradeableBeacon {

    address public immutable vaultStaffRoomImpl;

    /// @param _owner The address of the VaultFactory owner
    /// @param _stakingVaultImpl The address of the StakingVault implementation
    /// @param _vaultStaffRoomImpl The address of the VaultStaffRoom implementation
    constructor(address _owner, address _stakingVaultImpl, address _vaultStaffRoomImpl) UpgradeableBeacon(_stakingVaultImpl, _owner) {
        if (_vaultStaffRoomImpl == address(0)) revert ZeroArgument("_vaultStaffRoom");

        vaultStaffRoomImpl = _vaultStaffRoomImpl;
    }

    /// @notice Creates a new StakingVault and VaultStaffRoom contracts
    /// @param _params The params of vault initialization
    function createVault(bytes calldata _params) external returns(address vault, address vaultStaffRoom) {
        vault = address(new BeaconProxy(address(this), ""));

        vaultStaffRoom = Clones.clone(vaultStaffRoomImpl);
        IVaultStaffRoom(vaultStaffRoom).initialize(msg.sender, vault);

        IStakingVault(vault).initialize(vaultStaffRoom, _params);

        emit VaultCreated(vaultStaffRoom, vault);
        emit VaultStaffRoomCreated(msg.sender, vaultStaffRoom);
    }

    /**
    * @notice Event emitted on a Vault creation
    * @param admin The address of the Vault admin
    * @param vault The address of the created Vault
    */
    event VaultCreated(
        address indexed admin,
        address indexed vault
    );

    /**
    * @notice Event emitted on a VaultStaffRoom creation
    * @param admin The address of the VaultStaffRoom admin
    * @param vaultStaffRoom The address of the created VaultStaffRoom
    */
    event VaultStaffRoomCreated(
        address indexed admin,
        address indexed vaultStaffRoom
    );

    error ZeroArgument(string);
}
