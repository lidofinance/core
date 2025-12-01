// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>, Aragon
// SPDX-License-Identifier: MIT

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.9;

library UnstructuredStorage {
    function getStorageBool(bytes32 position) internal view returns (bool data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00740000, 1037618708596) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00740001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00741000, position) }
        assembly { data := sload(position) }
    }

    function getStorageAddress(bytes32 position) internal view returns (address data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00750000, 1037618708597) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00750001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00751000, position) }
        assembly { data := sload(position) }
    }

    function getStorageBytes32(bytes32 position) internal view returns (bytes32 data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00770000, 1037618708599) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00770001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00771000, position) }
        assembly { data := sload(position) }
    }

    function getStorageUint256(bytes32 position) internal view returns (uint256 data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00780000, 1037618708600) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00780001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00781000, position) }
        assembly { data := sload(position) }
    }

    function setStorageBool(bytes32 position, bool data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00760000, 1037618708598) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00760001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00761000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00761001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageAddress(bytes32 position, address data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00790000, 1037618708601) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00790001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00791000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00791001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageBytes32(bytes32 position, bytes32 data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007a0000, 1037618708602) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007a0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007a1000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007a1001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageUint256(bytes32 position, uint256 data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007b0000, 1037618708603) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007b0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007b1000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff007b1001, data) }
        assembly { sstore(position, data) }
    }
}
