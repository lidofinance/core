// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v4.4/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v4.4/proxy/beacon/BeaconProxy.sol";
import {StakingVault} from "./StakingVault.sol";

pragma solidity 0.8.9;

contract VaultFactory is UpgradeableBeacon {

    /**
    * @notice Event emitted on a Vault creation
    * @param admin The address of the Vault admin
    * @param vault The address of the created Vault
    */
    event VaultCreated(
        address indexed admin,
        address indexed vault
    );

    constructor(address _owner, address _implementation) UpgradeableBeacon(_implementation) {
        transferOwnership(_owner);
    }

    function createVault() external returns(address vault) {
        vault = address(
            new BeaconProxy(
                address(this),
                abi.encodeWithSelector(StakingVault.initialize.selector, msg.sender)
            )
        );

        // emit event
        emit VaultCreated(msg.sender, vault);

        return address(vault);
    }
}
