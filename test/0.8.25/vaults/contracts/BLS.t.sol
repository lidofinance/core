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
}

struct PrecomputedDepositMessage {
    bytes pubkey;
    bytes32 withdrawal;
    uint64 amount;
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

    function test_decodeG2Point() public view {
        PrecomputedDepositMessage memory deposit = STATIC_DEPOSIT_MESSAGE();
        BLS.G2Point memory g2 = harness.decodeG2Point(deposit.signature, deposit.signatureYComponent);

        BLS.Fp memory computed_x_c0 = wrapFp(
            hex"12273c21949d56e83c491af148c760f9b38b233eb782c293a60fa2ffe0ee109db23aa9d8c69305c758bb229a1132a365"
        );

        StdAssertions.assertEq(abi.encode(g2.x.c0), abi.encode(computed_x_c0));

        BLS.Fp memory computed_x_c1 = wrapFp(
            hex"15a4323c090fb311b0f4f082b1b1004c5efb7a3b283415aac499be6045a8d3840ab57e714f2144fabe761e1fde46d1d5"
        );

        StdAssertions.assertEq(abi.encode(g2.x.c1), abi.encode(computed_x_c1));

        // SignatureY is put into G2 as is
        // SignatureY c0
        StdAssertions.assertEq(abi.encode(g2.y.c0), abi.encode(deposit.signatureYComponent.c0));
        // SignatureY c1
        StdAssertions.assertEq(abi.encode(g2.y.c1), abi.encode(deposit.signatureYComponent.c1));
    }

    function wrapFp(bytes memory data) internal pure returns (BLS.Fp memory) {
        require(data.length == 48, "Invalid Fp length");
        uint256 a = BLS.sliceToUint(data, 0, 16);
        uint256 b = BLS.sliceToUint(data, 16, 48);
        return BLS.Fp(a, b);
    }

    function pad16(bytes memory data) internal pure returns (bytes memory) {
        return bytes.concat(hex"00000000000000000000000000000000", data);
    }

    function STATIC_DEPOSIT_MESSAGE() internal pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                hex"b79902f435d268d6d37ac3ab01f4536a86c192fa07ba5b63b5f8e4d0e05755cfeab9d35fbedb9c02919fe02a81f8b06d",
                0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f,
                1 ether,
                hex"95a4323c090fb311b0f4f082b1b1004c5efb7a3b283415aac499be6045a8d3840ab57e714f2144fabe761e1fde46d1d512273c21949d56e83c491af148c760f9b38b233eb782c293a60fa2ffe0ee109db23aa9d8c69305c758bb229a1132a365",
                wrapFp(
                    hex"19b71bd2a9ebf09809b6c380a1d1de0c2d9286a8d368a2fc75ad5ccc8aec572efdff29d50b68c63e00f6ce017c24e083"
                ),
                BLS.Fp2(
                    wrapFp(
                        hex"0d12d727285533d0ec733bcd80cd1e15d002c19985aaa3ad40fca85f73e1a7f96f50d0c78add58b7d55a4ebd11051f37"
                    ),
                    wrapFp(
                        hex"0b8cfab59498fbe811a1a5009beb975a5c144acfbd9423a279d75a2cce89312366d1ca701697d05c15689820eb4cd96d"
                    )
                ),
                0xa0ea5aa96388d0375c9181eac29fa198cea873c818efe7442bd49c03948f2a69
            );
    }
}
