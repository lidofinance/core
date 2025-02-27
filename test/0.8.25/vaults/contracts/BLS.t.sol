// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";

import {BLS, SSZ} from "contracts/0.8.25/lib/BLS.sol";

contract BLSHarness {
    function verifyDepositMessage(
        bytes calldata pubkey,
        bytes32 withdrawal,
        uint64 amount,
        bytes memory signature,
        BLS.Fp memory pubkeyYComponent,
        BLS.Fp2 memory signatureYComponent
    ) public view {
        BLS.verifyDeposit(pubkey, withdrawal, amount, signature, pubkeyYComponent, signatureYComponent);
    }

    function decodeG2Point(bytes memory encodedX, BLS.Fp2 memory Y) public pure returns (BLS.G2Point memory) {
        return BLS.decodeG2Point(encodedX, Y);
    }

    function depositMessageSigningRoot(
        bytes calldata pubkey,
        bytes32 withdrawal,
        uint64 amount
    ) public view returns (bytes32) {
        return SSZ.depositMessageSigningRoot(pubkey, withdrawal, amount);
    }

    function hashToFieldFp2(
        bytes calldata pubkey,
        bytes32 withdrawal,
        uint64 amount
    ) public view returns (BLS.Fp2[2] memory) {
        bytes32 _msg = SSZ.depositMessageSigningRoot(pubkey, withdrawal, amount);
        return BLS.hashToFieldFp2(_msg, BLS.DST);
    }

    function hashToCurveG2(
        bytes calldata pubkey,
        bytes32 withdrawal,
        uint64 amount
    ) public view returns (BLS.G2Point memory) {
        return BLS.hashToCurveG2(SSZ.depositMessageSigningRoot(pubkey, withdrawal, amount));
    }
}

struct PrecomputedDepositMessage {
    bytes pubkey;
    bytes32 withdrawal;
    uint256 amount;
    bytes signature;
    BLS.Fp pubkeyYComponent;
    BLS.Fp2 signatureYComponent;
    bytes32 validMsgHash;
}

contract BLSVerifyingKeyTest is Test {
    BLSHarness harness;

    constructor() {
        harness = new BLSHarness();
    }

    function test_verifyDeposit() external view {
        PrecomputedDepositMessage memory deposit = STATIC_DEPOSIT_MESSAGE();
        harness.verifyDepositMessage(
            deposit.pubkey,
            deposit.withdrawal,
            uint64(deposit.amount),
            deposit.signature,
            deposit.pubkeyYComponent,
            deposit.signatureYComponent
        );
    }

    function test_depositMessageHashTreeRoot() public view {
        PrecomputedDepositMessage memory deposit = STATIC_DEPOSIT_MESSAGE();
        bytes32 root = harness.depositMessageSigningRoot(deposit.pubkey, deposit.withdrawal, uint64(deposit.amount));
        StdAssertions.assertEq32(root, deposit.validMsgHash);
    }

    function wrapFp(bytes memory data) internal pure returns (BLS.Fp memory) {
        require(data.length == 48, "Invalid Fp length");
        uint256 a = BLS.sliceToUint(data, 0, 16);
        uint256 b = BLS.sliceToUint(data, 16, 48);
        return BLS.Fp(a, b);
    }

    function wrapFp2(bytes memory x, bytes memory y) internal pure returns (BLS.Fp2 memory) {
        return BLS.Fp2(wrapFp(x), wrapFp(y));
    }

    function STATIC_DEPOSIT_MESSAGE() internal pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                hex"b79902f435d268d6d37ac3ab01f4536a86c192fa07ba5b63b5f8e4d0e05755cfeab9d35fbedb9c02919fe02a81f8b06d",
                0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f,
                1 ether,
                hex"b357f146f53de27ae47d6d4bff5e8cc8342d94996143b2510452a3565701c3087a0ba04bed41d208eb7d2f6a50debeac09bf3fcf5c28d537d0fe4a52bb976d0c19ea37a31b6218f321a308f8017e5fd4de63df270f37df58c059c75f0f98f980",
                wrapFp(
                    hex"19b71bd2a9ebf09809b6c380a1d1de0c2d9286a8d368a2fc75ad5ccc8aec572efdff29d50b68c63e00f6ce017c24e083"
                ),
                wrapFp2(
                    hex"10d96c5dcc6e32bcd43e472317e18ad94dde89c9361d79bec5378c72214083ea40f3dc43ee759025eb4c25150e1943bf",
                    hex"160f8d804d277c7a079f451bce224fd42397e75676d965a1ebe79e53beeb2cb48be01f4dc93c0bad8ae7560c3e8048fb"
                ),
                0xa0ea5aa96388d0375c9181eac29fa198cea873c818efe7442bd49c03948f2a69
            );
    }
}
