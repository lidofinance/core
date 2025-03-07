// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {StorageSlot} from "@openzeppelin/contracts-v5.2/utils/StorageSlot.sol";

library PinnedBeaconUtils {
    bytes32 internal constant PINNED_BEACON_SLOT = bytes32(
        uint256(keccak256("stakingVault.proxy.pinnedBeacon")) - 1
    );

    function getPinnedImplementation() internal view returns (address) {
        return StorageSlot.getAddressSlot(PINNED_BEACON_SLOT).value;
    }

    function setPinnedImplementation(address newImpl) internal {
        StorageSlot.getAddressSlot(PINNED_BEACON_SLOT).value = newImpl;
    }
}
