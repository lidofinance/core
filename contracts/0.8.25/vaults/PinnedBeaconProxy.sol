// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/IBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {PinnedBeaconUtils} from "./lib/PinnedBeaconUtils.sol";


contract PinnedBeaconProxy is BeaconProxy {
    constructor(address beacon, bytes memory data) BeaconProxy(beacon, data) {}

    function _implementation() internal view virtual override returns (address) {
        if (PinnedBeaconUtils.getPinnedImplementation() != address(0)) {
            return PinnedBeaconUtils.getPinnedImplementation();
        }
        return IBeacon(_getBeacon()).implementation();
    }

    function implementation() external view returns(address) {
        return _implementation();
    }
}
