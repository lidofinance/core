// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

contract VaultFactory__MockForStakingVault is UpgradeableBeacon {
    event VaultCreated(address indexed vault);

    constructor(address _stakingVaultImplementation) UpgradeableBeacon(_stakingVaultImplementation, msg.sender) {}

    function createVault(address _owner, address _operator, address _depositor) external {
        IStakingVault vault = IStakingVault(address(new BeaconProxy(address(this), "")));
        vault.initialize(address(this), _operator, _depositor);
        OwnableUpgradeable(address(vault)).transferOwnership(_owner);

        emit VaultCreated(address(vault));
    }
}
