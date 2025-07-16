// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {PinnedBeaconProxy} from "contracts/0.8.25/vaults/PinnedBeaconProxy.sol";
import {StakingVault__MockForVaultHub} from "./StakingVault__MockForVaultHub.sol";

contract VaultFactory__MockForVaultHub {
    event VaultCreated(address indexed vault);

    address public immutable BEACON;

    constructor(address _beacon) {
        BEACON = _beacon;
    }

    function createVault(address _owner, address _operator, address _depositor) external {
        StakingVault__MockForVaultHub vault = StakingVault__MockForVaultHub(address(new PinnedBeaconProxy(BEACON, "")));

        vault.initialize(_owner, _operator, _depositor);

        emit VaultCreated(address(vault));
    }
}
