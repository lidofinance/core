// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/IBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {PinnedBeaconUtils} from "./lib/PinnedBeaconUtils.sol";

contract PinnedBeaconProxy is BeaconProxy {
    /**
     * @dev Storage slot with the address of the last implementation.
     * This is the keccak-256 hash of "stakingVault.proxy.pinnedBeacon" subtracted by 1.

     0x8d75cfa6c9a3cd2fb8b6d445eafb32adc5497a45b333009f9000379f7024f9f5
     */
    bytes32 internal constant PINNED_BEACON_SLOT = bytes32(uint256(keccak256("stakingVault.proxy.pinnedBeacon")) - 1);

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
