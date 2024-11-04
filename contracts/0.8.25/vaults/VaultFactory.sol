// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";

import {StakingVault} from "./StakingVault.sol";
import {VaultStaffRoom} from "./VaultStaffRoom.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

pragma solidity 0.8.25;

contract VaultFactory is UpgradeableBeacon {

    address public immutable stETH;

    /// @param _implementation The address of the StakingVault implementation
    /// @param _owner The address of the VaultFactory owner
    constructor(address _implementation, address _owner, address _stETH) UpgradeableBeacon(_implementation, _owner) {
        if (_stETH == address(0)) revert ZeroArgument("_stETH");

        stETH = _stETH;
    }

    function createVault(bytes calldata params) external returns(address vault, address vaultStaffRoom) {
        vault = address(
            new BeaconProxy(address(this), "")
        );

        vaultStaffRoom = address(
            new VaultStaffRoom(vault, msg.sender, stETH)
        );

        IStakingVault(vault).initialize(vaultStaffRoom, params);

        // emit event
        emit VaultCreated(msg.sender, vault);
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
