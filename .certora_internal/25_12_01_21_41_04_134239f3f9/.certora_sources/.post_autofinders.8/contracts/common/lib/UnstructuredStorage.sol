// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>, Aragon
// SPDX-License-Identifier: MIT

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.9;

library UnstructuredStorage {
    function getStorageBool(bytes32 position) internal view returns (bool data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02990000, 1037618709145) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02990001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02991000, position) }
        assembly { data := sload(position) }
    }

    function getStorageAddress(bytes32 position) internal view returns (address data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029a0000, 1037618709146) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029a0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029a1000, position) }
        assembly { data := sload(position) }
    }

    function getStorageBytes32(bytes32 position) internal view returns (bytes32 data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029c0000, 1037618709148) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029c0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029c1000, position) }
        assembly { data := sload(position) }
    }

    function getStorageUint256(bytes32 position) internal view returns (uint256 data) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029d0000, 1037618709149) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029d0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029d1000, position) }
        assembly { data := sload(position) }
    }

    function setStorageBool(bytes32 position, bool data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029b0000, 1037618709147) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029b0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029b1000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029b1001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageAddress(bytes32 position, address data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029e0000, 1037618709150) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029e0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029e1000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029e1001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageBytes32(bytes32 position, bytes32 data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029f0000, 1037618709151) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029f0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029f1000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff029f1001, data) }
        assembly { sstore(position, data) }
    }

    function setStorageUint256(bytes32 position, uint256 data) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a00000, 1037618709152) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a00001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a01000, position) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02a01001, data) }
        assembly { sstore(position, data) }
    }
}
