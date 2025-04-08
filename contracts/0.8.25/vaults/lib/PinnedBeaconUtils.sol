// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {StorageSlot} from "@openzeppelin/contracts-v5.2/utils/StorageSlot.sol";
import {IBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/IBeacon.sol";
import {ERC1967Utils} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Utils.sol";

library PinnedBeaconUtils {
    /**
     * @dev Storage slot with the address of the last implementation.
     * PINNED_BEACON_STORAGE_SLOT = bytes32(uint256(keccak256("stakingVault.proxy.pinnedBeacon")) - 1)
     */
    bytes32 internal constant PINNED_BEACON_STORAGE_SLOT = 0x8d75cfa6c9a3cd2fb8b6d445eafb32adc5497a45b333009f9000379f7024f9f5;

    function getPinnedImplementation() internal view returns (address) {
        return StorageSlot.getAddressSlot(PINNED_BEACON_STORAGE_SLOT).value;
    }

    /**
     * @notice Ossifies the beacon by pinning the current implementation
     */
    function ossify() internal {
        if (ossified()) revert AlreadyOssified();
        address currentImplementation = IBeacon(ERC1967Utils.getBeacon()).implementation();
        StorageSlot.getAddressSlot(PINNED_BEACON_STORAGE_SLOT).value = currentImplementation;
        emit PinnedImplementationUpdated(currentImplementation);
    }

    /**
     * @notice Returns true if the proxy is ossified
     * @return True if the proxy is ossified, false otherwise
     */
    function ossified() internal view returns(bool) {
        return getPinnedImplementation() != address(0);
    }

    /**
     * @notice Emitted when the pinned implementation is updated
     * @param implementation The address of the new pinned implementation
     */
    event PinnedImplementationUpdated(address indexed implementation);

    /**
     * @notice Thrown when trying to ossify the proxy while it is already ossified
     */
    error AlreadyOssified();
}
