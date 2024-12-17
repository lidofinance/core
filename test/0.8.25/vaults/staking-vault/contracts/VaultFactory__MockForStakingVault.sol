// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import { UpgradeableBeacon } from "@openzeppelin/contracts-v5.0.2/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import { IStakingVault } from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract VaultFactory__MockForStakingVault is UpgradeableBeacon {
    event VaultCreated(address indexed vault);

    constructor(address _stakingVaultImplementation) UpgradeableBeacon(_stakingVaultImplementation, msg.sender) {}

    function createVault(address _owner, address _operator) external {
        IStakingVault vault = IStakingVault(address(new BeaconProxy(address(this), "")));
        vault.initialize(address(this), _owner, _operator, "");

        emit VaultCreated(address(vault));
    }
}
