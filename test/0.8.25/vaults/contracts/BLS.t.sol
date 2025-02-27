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
        StdAssertions.assertEq32(root, bytes32(0xa0ea5aa96388d0375c9181eac29fa198cea873c818efe7442bd49c03948f2a69));
    }

    function test_decodeG2Point() public view {
        PrecomputedDepositMessage memory deposit = STATIC_DEPOSIT_MESSAGE();
        BLS.G2Point memory g2 = harness.decodeG2Point(deposit.signature, deposit.signatureYComponent);
        bytes
            memory computed_x_c0 = hex"0000000000000000000000000000000010ee62f64a119d756182005fbb28046c0541f627b430cabfeb3599ebaa1b8efd08de562ec03a8d78c2f9e1b6f01d8aba";
        StdAssertions.assertEq(abi.encode(g2.x.c0), computed_x_c0);
        bytes
            memory computed_x_c1 = hex"00000000000000000000000000000000185f365b3459176da437560337cc074d153663f65e3c6bab28197e34cd7f926fa940176ba43484fb5297f679bc869f5d";
        StdAssertions.assertEq(abi.encode(g2.x.c1), computed_x_c1);
        bytes
            memory computed_y_c0 = hex"00000000000000000000000000000000167e287898ebd8499168d6f1a3da94a4fb5bbbd010c96358874ca5136681f2e9913ac332313547fc2e98c9fcd8bc3540";
        StdAssertions.assertEq(abi.encode(g2.y.c0), computed_y_c0);
        bytes
            memory computed_y_c1 = hex"0000000000000000000000000000000006fb3b85bc3ba5df98816abd8915a1ec5cf0b7f82b0c88d11a050e2e5ee13544c9275e1f4de174953f9367fc26ac3224";
        StdAssertions.assertEq(abi.encode(g2.y.c1), computed_y_c1);
    }

    function wrapFp(bytes memory data) internal pure returns (BLS.Fp memory) {
        require(data.length == 48, "Invalid Fp length");
        uint256 a = BLS.sliceToUint(data, 0, 32);
        uint256 b = BLS.sliceToUint(data, 32, 64);
        return BLS.Fp(a, b);
    }

    function STATIC_DEPOSIT_MESSAGE() internal pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                hex"b79902f435d268d6d37ac3ab01f4536a86c192fa07ba5b63b5f8e4d0e05755cfeab9d35fbedb9c02919fe02a81f8b06d",
                0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f,
                1 ether,
                hex"985f365b3459176da437560337cc074d153663f65e3c6bab28197e34cd7f926fa940176ba43484fb5297f679bc869f5d10ee62f64a119d756182005fbb28046c0541f627b430cabfeb3599ebaa1b8efd08de562ec03a8d78c2f9e1b6f01d8aba",
                wrapFp(
                    hex"19b71bd2a9ebf09809b6c380a1d1de0c2d9286a8d368a2fc75ad5ccc8aec572efdff29d50b68c63e00f6ce017c24e083"
                ),
                BLS.Fp2(
                    wrapFp(
                        hex"08b9b665a03d017589c24290363dd260d1cf764ffaddda2fe9ba20082b54500f60edb432e367c655e7ceb6aa5d636f6e"
                    ),
                    wrapFp(
                        hex"0566f8e8e2674c17006cd5b485c1aa0e3fb4d207b953a65c709f181d145b2a4c2a146732301be6079cbd1cd0b3d81677"
                    )
                )
            );
    }
}
