// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract VaultFactory__MockForVaultHub is UpgradeableBeacon {
    event VaultCreated(address indexed vault);

    constructor(address _stakingVaultImplementation) UpgradeableBeacon(_stakingVaultImplementation, msg.sender) {}

    function createVault(address _owner, address _operator, address _depositor) external {
        IStakingVault vault = IStakingVault(address(new BeaconProxy(address(this), "")));
        vault.initialize(_owner, _operator, _depositor);

        emit VaultCreated(address(vault));
    }
}
