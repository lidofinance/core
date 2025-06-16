// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0


// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity 0.4.24;


import {UnstructuredStorage} from "@aragon/os/contracts/apps/AragonApp.sol";

library UnstructuredStorageUint128 {
    using UnstructuredStorage for bytes32;

    uint256 constant internal UINT128_LOW_MASK = ~uint128(0);
    uint256 constant internal UINT128_HIGH_MASK = UINT128_LOW_MASK << 128;
    uint256 constant internal UINT160_LOW_MASK = ~uint160(0);
    uint256 constant internal UINT96_HIGH_MASK = UINT160_LOW_MASK << 160;

    function getLowUint128(bytes32 position) internal view returns (uint256) {
        return position.getStorageUint256() & UINT128_LOW_MASK;
    }

    function setLowUint128(bytes32 position, uint256 data) internal {
        uint256 high128 = position.getStorageUint256() & UINT128_HIGH_MASK;
        position.setStorageUint256(high128 | (data & UINT128_LOW_MASK));
    }

    function getHighUint128(bytes32 position) internal view returns (uint256) {
        return position.getStorageUint256() >> 128;
    }

    function setHighUint128(bytes32 position, uint256 data) internal {
        uint256 low128 = position.getStorageUint256() & UINT128_LOW_MASK;
        position.setStorageUint256((data << 128) | low128);
    }

    function getLowAndHighUint128(bytes32 position) internal view returns (uint256 low, uint256 high) {
        uint256 value = position.getStorageUint256();
        low = value & UINT128_LOW_MASK;
        high = value >> 128;
    }

    function setLowAndHighUint128(bytes32 position, uint256 low, uint256 high) internal {
        position.setStorageUint256((high << 128) | (low & UINT128_LOW_MASK));
    }

    function getLowUint160(bytes32 position) internal view returns (uint256) {
        return position.getStorageUint256() & UINT160_LOW_MASK;
    }

    function setLowUint160(bytes32 position, uint256 data) internal {
        position.setStorageUint256((position.getStorageUint256() & UINT96_HIGH_MASK) | (data & UINT160_LOW_MASK));
    }

    function getHighUint96(bytes32 position) internal view returns (uint256) {
        return position.getStorageUint256() >> 160;
    }

    function setHighUint96(bytes32 position, uint256 data) internal {
        position.setStorageUint256((data << 160) | (position.getStorageUint256() & UINT160_LOW_MASK));
    }
}
