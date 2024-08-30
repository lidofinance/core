// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import "forge-std/Test.sol";

import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";

contract ExposedUnstructuredStorageTest is Test {
    ExposedUnstructuredStorage public unstructuredStorage;

    function setUp() public {
        unstructuredStorage = new ExposedUnstructuredStorage();
    }

    function test_getStorageBool_Uninitialized() public view {
        bytes32 position = keccak256("FOO");
        assertEq(unstructuredStorage.getStorageBool(position), false);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_getStorageBool_Uninitialized(bytes32 position) public view {
        assertEq(unstructuredStorage.getStorageBool(position), false);
    }

    function test_getStorageAddress_Uninitialized() public view {
        bytes32 position = keccak256("FOO");
        assertEq(unstructuredStorage.getStorageAddress(position), address(0));
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_getStorageAddress_Uninitialized(bytes32 position) public view {
        assertEq(unstructuredStorage.getStorageAddress(position), address(0));
    }

    function test_getStorageBytes32_Uninitialized() public view {
        bytes32 position = keccak256("FOO");
        bytes32 data;
        assertEq(unstructuredStorage.getStorageBytes32(position), data);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_getStorageBytes32_Uninitialized(bytes32 position) public view {
        bytes32 data;
        assertEq(unstructuredStorage.getStorageBytes32(position), data);
    }

    function test_getStorageUint256_Uninitialized() public view {
        bytes32 position = keccak256("FOO");
        uint256 data;
        assertEq(unstructuredStorage.getStorageUint256(position), data);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_getStorageUint256_Uninitialized(bytes32 position) public view {
        uint256 data;
        assertEq(unstructuredStorage.getStorageUint256(position), data);
    }

    function test_setStorageBool() public {
        bytes32 position = keccak256("FOO");
        assertEq(unstructuredStorage.getStorageBool(position), false);

        unstructuredStorage.setStorageBool(position, true);
        assertEq(unstructuredStorage.getStorageBool(position), true);

        unstructuredStorage.setStorageBool(position, false);
        assertEq(unstructuredStorage.getStorageBool(position), false);
    }

    function test_setStorageAddress() public {
        bytes32 position = keccak256("FOO");
        address data = vm.addr(1);

        assertEq(unstructuredStorage.getStorageAddress(position), address(0));
        unstructuredStorage.setStorageAddress(position, data);
        assertEq(unstructuredStorage.getStorageAddress(position), data);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_setStorageAddress(address data, bytes32 position) public {
        assertEq(unstructuredStorage.getStorageAddress(position), address(0));
        unstructuredStorage.setStorageAddress(position, data);
        assertEq(unstructuredStorage.getStorageAddress(position), data);
    }

    function test_setStorageBytes32() public {
        bytes32 position = keccak256("FOO");
        bytes32 data = keccak256("BAR");
        bytes32 unInitializedData;

        assertEq(unstructuredStorage.getStorageBytes32(position), unInitializedData);
        unstructuredStorage.setStorageBytes32(position, data);
        assertEq(unstructuredStorage.getStorageBytes32(position), data);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_setStorageBytes32(bytes32 data, bytes32 position) public {
        bytes32 unInitializedData;

        assertEq(unstructuredStorage.getStorageBytes32(position), unInitializedData);
        unstructuredStorage.setStorageBytes32(position, data);
        assertEq(unstructuredStorage.getStorageBytes32(position), data);
    }

    function test_setStorageUint256() public {
        bytes32 position = keccak256("FOO");
        uint256 data = 1;
        uint256 unInitializedData;

        assertEq(unstructuredStorage.getStorageUint256(position), unInitializedData);
        unstructuredStorage.setStorageUint256(position, data);
        assertEq(unstructuredStorage.getStorageUint256(position), data);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 2048
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_setStorageUint256(uint256 data, bytes32 position) public {
        uint256 unInitializedData;

        assertEq(unstructuredStorage.getStorageUint256(position), unInitializedData);
        unstructuredStorage.setStorageUint256(position, data);
        assertEq(unstructuredStorage.getStorageUint256(position), data);
    }
}

contract ExposedUnstructuredStorage {
    function getStorageBool(bytes32 position) public view returns (bool) {
        return UnstructuredStorage.getStorageBool(position);
    }

    function getStorageAddress(bytes32 position) public view returns (address) {
        return UnstructuredStorage.getStorageAddress(position);
    }

    function getStorageBytes32(bytes32 position) public view returns (bytes32) {
        return UnstructuredStorage.getStorageBytes32(position);
    }

    function getStorageUint256(bytes32 position) public view returns (uint256) {
        return UnstructuredStorage.getStorageUint256(position);
    }

    function setStorageBool(bytes32 position, bool data) public {
        return UnstructuredStorage.setStorageBool(position, data);
    }

    function setStorageAddress(bytes32 position, address data) public {
        return UnstructuredStorage.setStorageAddress(position, data);
    }

    function setStorageBytes32(bytes32 position, bytes32 data) public {
        return UnstructuredStorage.setStorageBytes32(position, data);
    }

    function setStorageUint256(bytes32 position, uint256 data) public {
        return UnstructuredStorage.setStorageUint256(position, data);
    }
}
