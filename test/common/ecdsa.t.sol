// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.4.24 <0.9.0;

import "forge-std/Test.sol";

import {ECDSA} from "contracts/common/lib/ECDSA.sol";

contract ECDSATest is Test {
    function test_recover_Works() public pure {
        uint256 eoaPk = 1;
        address eoa = vm.addr(eoaPk);

        bytes32 hash = ("TEST");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(eoaPk, hash);

        address signer = ECDSA.recover(hash, v, r, s);

        assertEq(signer, eoa);
    }

    // https://eips.ethereum.org/EIPS/eip-2098#test-cases
    function test_recover_WorksWithCompactSignature() public pure {
        uint256 eoaPk = 1;
        address eoa = vm.addr(eoaPk);

        bytes32 hash = ("TEST");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(eoaPk, hash);
        uint8 yParity = v - 27; // Assume yParity is 0 or 1, normalized from the canonical 27 or 28

        // Ensure yParity is shifted within a uint256 context, then cast to bytes32
        bytes32 vs = bytes32(uint256(yParity) << 255) | s;

        address signer = ECDSA.recover(hash, r, vs);

        assertEq(signer, eoa);
    }
}
