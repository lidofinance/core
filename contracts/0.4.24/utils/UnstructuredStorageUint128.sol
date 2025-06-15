// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0


// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity ^0.4.24;


import {UnstructuredStorage} from "@aragon/os/contracts/apps/AragonApp.sol";

library UnstructuredStorageUint128 {
    using UnstructuredStorage for bytes32;

    uint256 constant internal UINT128_LOW_MASK = ~uint128(0);
    uint256 constant internal UINT128_HIGH_MASK = UINT128_LOW_MASK << 128;

    function getStorageUint128Low(bytes32 position) internal view returns (uint256 low) {
        low = position.getStorageUint256() & UINT128_LOW_MASK;
    }

    function setStorageUint128Low(bytes32 position, uint256 data) internal {
        position.setStorageUint256((data & UINT128_LOW_MASK) | (position.getStorageUint256() & UINT128_HIGH_MASK));
    }

    function getStorageUint128High(bytes32 position) internal view returns (uint256 high) {
        high = position.getStorageUint256() >> 128;
    }

    function setStorageUint128High(bytes32 position, uint256 data) internal {
        position.setStorageUint256((data << 128) | (position.getStorageUint256() & UINT128_LOW_MASK));
    }

    function getLowAndHighUint128(bytes32 position) internal view returns (uint256 low, uint256 high) {
        uint256 value = position.getStorageUint256();
        low = value & UINT128_LOW_MASK;
        high = value >> 128;
    }
}
