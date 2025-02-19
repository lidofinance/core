// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import "forge-std/Test.sol";
import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";

import {BLS} from "contracts/0.8.25/lib/BLS.sol";

// const STATIC_DEPOSIT = {
//   pubkey: "",
//   withdrawalCredentials: "0x0092c20062cee70389f1cb4fa566a2be5e2319ff43965db26dbaa3ce90b9df99",
//   amount: ether("1"),
//   signature:
//     "0x985f365b3459176da437560337cc074d153663f65e3c6bab28197e34cd7f926fa940176ba43484fb5297f679bc869f5d10ee62f64a119d756182005fbb28046c0541f627b430cabfeb3599ebaa1b8efd08de562ec03a8d78c2f9e1b6f01d8aba",
// };

contract BLSVerifyingKeyTest is Test {
    function test_verifyDeposit() external view {
        bytes
            memory pubkey = hex"a1d1ad0714035353258038e964ae9675dc0252ee22cea896825c01458e1807bfad2f9969338798548d9858a571f7425c";

        bytes32 withdrawal = 0x0092c20062cee70389f1cb4fa566a2be5e2319ff43965db26dbaa3ce90b9df99;
        uint256 amount = 1 ether;
        bytes
            memory signature = hex"985f365b3459176da437560337cc074d153663f65e3c6bab28197e34cd7f926fa940176ba43484fb5297f679bc869f5d10ee62f64a119d756182005fbb28046c0541f627b430cabfeb3599ebaa1b8efd08de562ec03a8d78c2f9e1b6f01d8aba";
        BLS.verifyDeposit(pubkey, withdrawal, amount, signature);
    }

    function verifySignature(
        bytes calldata pubkey, // must be 48 bytes
        bytes32 withdrawal, // 32 bytes
        uint64 amount,
        bytes calldata signature
    ) external view {}
}
