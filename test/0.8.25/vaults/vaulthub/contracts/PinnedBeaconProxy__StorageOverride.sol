// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/IBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {PinnedBeaconUtils} from "contracts/0.8.25/vaults/lib/PinnedBeaconUtils.sol";

struct InitializableStorage {
    /**
     * @dev Indicates that the contract has been initialized.
     */
    uint64 _initialized;
    /**
     * @dev Indicates that the contract is in the process of being initialized.
     */
    bool _initializing;
}

contract PinnedBeaconProxy__StorageOverride is BeaconProxy {
    constructor(address beacon, bytes memory data) payable BeaconProxy(beacon, data) {
        bytes32 slot = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
        InitializableStorage storage s;
        assembly {
            s.slot := slot
        }

        s._initialized = 0;
        s._initializing = false;
    }

    function isOssified() external view returns (bool) {
        return PinnedBeaconUtils.getPinnedImplementation() != address(0);
    }

    function _implementation() internal view virtual override returns (address) {
        address pinnedImpl = PinnedBeaconUtils.getPinnedImplementation();
        if (pinnedImpl != address(0)) {
            return pinnedImpl;
        }

        return super._implementation();
    }

    function implementation() external view returns (address) {
        return _implementation();
    }
}
