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

struct PrecomputedDepositMessage {
    IStakingVault.Deposit deposit;
    BLS.DepositYComponents depositYComponents;
    bytes32 withdrawalCredentials;
}

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

// harness to test methods with calldata args
contract BLSHarness is StdUtils {
    function verifyDepositMessage(PrecomputedDepositMessage calldata message) public view {
        BLS.verifyDepositMessage(message.deposit, message.depositYComponents, message.withdrawalCredentials);
    }

    function depositMessageSigningRoot(PrecomputedDepositMessage calldata message) public view returns (bytes32) {
        return SSZ.depositMessageSigningRoot(message.deposit, message.withdrawalCredentials);
    }

    function hashToCurve(PrecomputedDepositMessage calldata message) public view {
        console.log("msgG2");
        BLS.G2Point memory msgG2 = BLS.hashToCurveG2(depositMessageSigningRoot(message));
        console.logBytes(abi.encode(msgG2));

        console.log("pubkeyG1");
        BLS.G1Point memory pubkeyG1 = BLS.decodeG1Point(message.deposit.pubkey, message.depositYComponents.pubkeyY);
        console.logBytes(abi.encode(pubkeyG1));

        console.log("signatureG2");
        BLS.G2Point memory signatureG2 = BLS.decodeG2Point(
            message.deposit.signature,
            message.depositYComponents.signatureY
        );
        console.logBytes(abi.encode(signatureG2));

        console.log("NEGATED_G1_GENERATOR");
        console.logBytes(abi.encode(BLS.NEGATED_G1_GENERATOR()));
    }
}

contract BLSVerifyingKeyTest is Test {
    BLSHarness harness;

    constructor() {
        harness = new BLSHarness();
    }

    function test_verifySigningRoot() external view {
        PrecomputedDepositMessage memory message = STATIC_DEPOSIT_MESSAGE();
        bytes32 root = harness.depositMessageSigningRoot(message);
        StdAssertions.assertEq(root, 0xa0ea5aa96388d0375c9181eac29fa198cea873c818efe7442bd49c03948f2a69);
    }

    function test_verifyDeposit() external view {
        PrecomputedDepositMessage memory message = STATIC_DEPOSIT_MESSAGE();
        harness.verifyDepositMessage(message);
    }

    function test_verifyMainnetDeposit() external view {
        PrecomputedDepositMessage memory message = STATIC_MAINNET_MESSAGE();
        harness.verifyDepositMessage(message);
    }

    function test_revertOnInCorrectDeposit() external {
        PrecomputedDepositMessage memory deposit = CORRUPTED_STATIC_DEPOSIT_MESSAGE();
        vm.expectRevert();
        harness.verifyDepositMessage(deposit);
    }

    function test_hashToCurve() external view {
        PrecomputedDepositMessage memory message = STATIC_DEPOSIT_MESSAGE();
        harness.hashToCurve(message);

        console.log("Mainnet message");

        PrecomputedDepositMessage memory _message = STATIC_MAINNET_MESSAGE();
        harness.hashToCurve(_message);
    }

    function STATIC_DEPOSIT_MESSAGE() internal pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                IStakingVault.Deposit(
                    hex"b79902f435d268d6d37ac3ab01f4536a86c192fa07ba5b63b5f8e4d0e05755cfeab9d35fbedb9c02919fe02a81f8b06d",
                    hex"b357f146f53de27ae47d6d4bff5e8cc8342d94996143b2510452a3565701c3087a0ba04bed41d208eb7d2f6a50debeac09bf3fcf5c28d537d0fe4a52bb976d0c19ea37a31b6218f321a308f8017e5fd4de63df270f37df58c059c75f0f98f980",
                    1 ether,
                    bytes32(0) // deposit data root is not checked
                ),
                BLS.DepositYComponents(
                    wrapFp(
                        hex"19b71bd2a9ebf09809b6c380a1d1de0c2d9286a8d368a2fc75ad5ccc8aec572efdff29d50b68c63e00f6ce017c24e083"
                    ),
                    wrapFp2(
                        hex"160f8d804d277c7a079f451bce224fd42397e75676d965a1ebe79e53beeb2cb48be01f4dc93c0bad8ae7560c3e8048fb",
                        hex"10d96c5dcc6e32bcd43e472317e18ad94dde89c9361d79bec5378c72214083ea40f3dc43ee759025eb4c25150e1943bf"
                    )
                ),
                0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f
            );
    }

    function CORRUPTED_STATIC_DEPOSIT_MESSAGE() internal pure returns (PrecomputedDepositMessage memory message) {
        message = STATIC_DEPOSIT_MESSAGE();
        message.withdrawalCredentials = bytes32(0x0);
    }

    function STATIC_MAINNET_MESSAGE() internal pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                IStakingVault.Deposit(
                    hex"88841e426f271030ad2257537f4eabd216b891da850c1e0e2b92ee0d6e2052b1dac5f2d87bef51b8ac19d425ed024dd1",
                    hex"99a9e9abd7d4a4de2d33b9c3253ff8440ad237378ce37250d96d5833fe84ba87bbf288bf3825763c04c3b8cdba323a3b02d542cdf5940881f55e5773766b1b185d9ca7b6e239bdd3fb748f36c0f96f6a00d2e1d314760011f2f17988e248541d",
                    32 ether,
                    bytes32(0)
                ),
                BLS.DepositYComponents(
                    wrapFp(
                        hex"04c46736f0aa8ec7e6e4c1126c12079f09dc28657695f13154565c9c31907422f48df41577401bab284458bf4ebfb45d"
                    ),
                    wrapFp2(
                        hex"10e7847980f47ceb3f994a97e246aa1d563dfb50c372156b0eaee0802811cd62da8325ebd37a1a498ad4728b5852872f",
                        hex"00c4aac6c84c230a670b4d4c53f74c0b2ca4a6a86fe720d0640d725d19d289ce4ac3a9f8a9c8aa345e36577c117e7dd6"
                    )
                ),
                0x004AAD923FC63B40BE3DDE294BDD1BBB064E34A4A4D51B68843FEA44532D6147
            );
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
}
