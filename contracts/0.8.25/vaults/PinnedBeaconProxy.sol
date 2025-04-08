// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/IBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {PinnedBeaconUtils} from "./lib/PinnedBeaconUtils.sol";

/**
 * @title PinnedBeaconProxy
 * @author Lido
 * @notice
 *
 * PinnedBeaconProxy is an extended version of OpenZeppelin's BeaconProxy that adds the ability
 * to "pin" (ossify) specific implementation versions for individual proxy instances.
 *
 * Implementation details:
 * - Uses PinnedBeaconUtils library to manage pinned implementation state
 * - Pinned implementation is stored in a storage slot (keccak256("stakingVault.proxy.pinnedBeacon") - 1)
 * - When ossified, the proxy will always use the pinned implementation instead of the beacon's implementation
 *
 */
contract PinnedBeaconProxy is BeaconProxy {
    constructor(address beacon, bytes memory data) BeaconProxy(beacon, data) payable {}

    function _implementation() internal view virtual override returns (address) {
        address pinnedImpl = PinnedBeaconUtils.getPinnedImplementation();
        if (pinnedImpl != address(0)) {
            return pinnedImpl;
        }
        return IBeacon(_getBeacon()).implementation();
    }

    function implementation() external view returns (address) {
        return _implementation();
    }
}
