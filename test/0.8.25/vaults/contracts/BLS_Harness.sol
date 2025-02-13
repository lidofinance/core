// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {BLS} from "contracts/0.8.25/lib/BLS.sol";

contract BLS__Harness {
    function verifySignature(
        bytes calldata pubkey, // must be 48 bytes
        bytes32 withdrawal, // 32 bytes
        uint64 amount,
        bytes calldata signature
    ) external view {
        BLS.verifyDeposit(pubkey, withdrawal, amount, signature);
    }
}
