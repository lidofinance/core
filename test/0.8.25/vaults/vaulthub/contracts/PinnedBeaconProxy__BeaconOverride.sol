// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/IBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {PinnedBeaconUtils} from "contracts/0.8.25/vaults/lib/PinnedBeaconUtils.sol";

/**
 * @title PinnedBeaconProxy__BeaconOverride
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
contract PinnedBeaconProxy__BeaconOverride is BeaconProxy {
    constructor(address _spoofImpl, address beacon, bytes memory data) payable BeaconProxy(beacon, data) {
        assembly {
            sstore(
                0x8d75cfa6c9a3cd2fb8b6d445eafb32adc5497a45b333009f9000379f7024f9f5, // PINNED_BEACON_STORAGE_SLOT
                _spoofImpl
            )
        }
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
