// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>, Aragon
// SPDX-License-Identifier: MIT

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.9;

library UnstructuredStorage {
    function getStorageBool(bytes32 position) internal view returns (bool data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01800000, 1037618708864) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01800001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01801000, position) }
        assembly { data := sload(position) }
    }

    function getStorageAddress(bytes32 position) internal view returns (address data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01810000, 1037618708865) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01810001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01811000, position) }
        assembly { data := sload(position) }
    }

    function getStorageBytes32(bytes32 position) internal view returns (bytes32 data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01830000, 1037618708867) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01830001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01831000, position) }
        assembly { data := sload(position) }
    }

    function getStorageUint256(bytes32 position) internal view returns (uint256 data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01840000, 1037618708868) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01840001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01841000, position) }
        assembly { data := sload(position) }
    }

    function setStorageBool(bytes32 position, bool data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01820000, 1037618708866) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01820001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01821000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01821001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageAddress(bytes32 position, address data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01850000, 1037618708869) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01850001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01851000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01851001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageBytes32(bytes32 position, bytes32 data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01860000, 1037618708870) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01860001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01861000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01861001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageUint256(bytes32 position, uint256 data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01870000, 1037618708871) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01870001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01871000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01871001, data) }
        assembly { sstore(position, data) }
    }
}
