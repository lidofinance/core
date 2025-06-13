// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";

import {BLS12_381, SSZ} from "contracts/common/lib/BLS.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

struct PrecomputedDepositMessage {
    IStakingVault.Deposit deposit;
    BLS12_381.DepositY depositYComponents;
    bytes32 withdrawalCredentials;
}

// harness to test methods with calldata args
contract BLSHarness {
    function verifyDepositMessage(PrecomputedDepositMessage calldata message) public view {
        BLS12_381.verifyDepositMessage(
            message.deposit.pubkey,
            message.deposit.signature,
            message.deposit.amount,
            message.depositYComponents,
            message.withdrawalCredentials,
            0x03000000f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a9
        );
    }

    function depositMessageSigningRoot(PrecomputedDepositMessage calldata message) public view returns (bytes32) {
        return
            BLS12_381.depositMessageSigningRoot(
                message.deposit.pubkey,
                message.deposit.amount,
                message.withdrawalCredentials,
                0x03000000f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a9
            );
    }
}

contract BLSVerifyingKeyTest is Test {
    BLSHarness harness;

    constructor() {
        harness = new BLSHarness();
    }

    function test_verifySigningRoot() external view {
        PrecomputedDepositMessage memory message = LOCAL_MESSAGE_1();
        bytes32 root = harness.depositMessageSigningRoot(message);
        StdAssertions.assertEq(root, 0xa0ea5aa96388d0375c9181eac29fa198cea873c818efe7442bd49c03948f2a69);
    }

    function test_revertOnInCorrectDeposit() external {
        PrecomputedDepositMessage memory deposit = CORRUPTED_MESSAGE();
        vm.expectRevert();
        harness.verifyDepositMessage(deposit);
    }

    function test_verifyDeposit_LOCAL_1() external view {
        PrecomputedDepositMessage memory message = LOCAL_MESSAGE_1();
        harness.verifyDepositMessage(message);
    }

    function test_verifyDeposit_LOCAL_2() external view {
        PrecomputedDepositMessage memory message = LOCAL_MESSAGE_2();
        harness.verifyDepositMessage(message);
    }

    function test_verifyDeposit_MAINNET() external view {
        PrecomputedDepositMessage memory message = BENCHMARK_MAINNET_MESSAGE();
        harness.verifyDepositMessage(message);
    }

    function test_computeDepositDomainMainnet() public view {
        bytes32 depositDomain = BLS12_381.computeDepositDomain(bytes4(0));
        assertEq(depositDomain, hex"03000000f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a9");
    }

    function test_computeDepositDomainHoodi() public view {
        bytes32 depositDomain = BLS12_381.computeDepositDomain(bytes4(hex"10000910"));
        assertEq(depositDomain, hex"03000000719103511efa4f1362ff2a50996cccf329cc84cb410c5e5c7d351d03");
    }

    function LOCAL_MESSAGE_1() internal pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                IStakingVault.Deposit(
                    hex"b79902f435d268d6d37ac3ab01f4536a86c192fa07ba5b63b5f8e4d0e05755cfeab9d35fbedb9c02919fe02a81f8b06d",
                    hex"b357f146f53de27ae47d6d4bff5e8cc8342d94996143b2510452a3565701c3087a0ba04bed41d208eb7d2f6a50debeac09bf3fcf5c28d537d0fe4a52bb976d0c19ea37a31b6218f321a308f8017e5fd4de63df270f37df58c059c75f0f98f980",
                    1 ether,
                    bytes32(0) // deposit data root is not checked
                ),
                BLS12_381.DepositY(
                    BLS12_381.Fp(
                        0x0000000000000000000000000000000019b71bd2a9ebf09809b6c380a1d1de0c,
                        0x2d9286a8d368a2fc75ad5ccc8aec572efdff29d50b68c63e00f6ce017c24e083
                    ),
                    BLS12_381.Fp2(
                        0x00000000000000000000000000000000160f8d804d277c7a079f451bce224fd4,
                        0x2397e75676d965a1ebe79e53beeb2cb48be01f4dc93c0bad8ae7560c3e8048fb,
                        0x0000000000000000000000000000000010d96c5dcc6e32bcd43e472317e18ad9,
                        0x4dde89c9361d79bec5378c72214083ea40f3dc43ee759025eb4c25150e1943bf
                    )
                ),
                0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f
            );
    }

    function LOCAL_MESSAGE_2() internal pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                IStakingVault.Deposit(
                    hex"95886cccfd40156b84b29e22098f3b1b3d1811275507cdf10a3d4c29217635cc389156565a9e156c6f4797602520d959",
                    hex"87eb3d449f8b70f6aa46f7f204cdb100bdc2742fae3176cec9b864bfc5460907deed2bbb7dac911b4e79d5c9df86483c013c5ba55ab4691b6f8bd16197538c3f2413dc9c56f37cb6bd78f72dbe876f8ae2a597adbf7574eadab2dd2aad59a291",
                    1 ether,
                    bytes32(0xe019f8a516377a7bd24e571ddf9410a73e7f11968515a0241bb7993a72a9a846) // deposit data root is not checked
                ),
                BLS12_381.DepositY(
                    BLS12_381.Fp(
                        0x00000000000000000000000000000000065bd597c1126394e2c2e357f9bde064,
                        0xfe5928f590adac55563d299c738458f9fb15494364ce3ee4a0a45190853f63fe
                    ),
                    BLS12_381.Fp2(
                        0x000000000000000000000000000000000f20e48e1255852b16cb3bc79222d426,
                        0x8eed3a566036b5608775e10833dc043b33c1f762eff29fb75c4479bea44ead3d,
                        0x000000000000000000000000000000000a9fffa1483846f01e6dd1a3212afb14,
                        0x6a523aec73dcb6c8a5a97b42b037162fb7767df9e4e11fc9e89f4c4ff0f37a42
                    )
                ),
                0x0200000000000000000000008daf17a20c9dba35f005b6324f493785d239719d
            );
    }

    function CORRUPTED_MESSAGE() internal pure returns (PrecomputedDepositMessage memory message) {
        message = LOCAL_MESSAGE_1();
        message.withdrawalCredentials = bytes32(0x0);
    }

    function BENCHMARK_MAINNET_MESSAGE() internal pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                IStakingVault.Deposit(
                    hex"88841e426f271030ad2257537f4eabd216b891da850c1e0e2b92ee0d6e2052b1dac5f2d87bef51b8ac19d425ed024dd1",
                    hex"99a9e9abd7d4a4de2d33b9c3253ff8440ad237378ce37250d96d5833fe84ba87bbf288bf3825763c04c3b8cdba323a3b02d542cdf5940881f55e5773766b1b185d9ca7b6e239bdd3fb748f36c0f96f6a00d2e1d314760011f2f17988e248541d",
                    32 ether,
                    bytes32(0)
                ),
                BLS12_381.DepositY(
                    BLS12_381.Fp(
                        0x0000000000000000000000000000000004c46736f0aa8ec7e6e4c1126c12079f,
                        0x09dc28657695f13154565c9c31907422f48df41577401bab284458bf4ebfb45d
                    ),
                    BLS12_381.Fp2(
                        0x0000000000000000000000000000000010e7847980f47ceb3f994a97e246aa1d,
                        0x563dfb50c372156b0eaee0802811cd62da8325ebd37a1a498ad4728b5852872f,
                        0x0000000000000000000000000000000000c4aac6c84c230a670b4d4c53f74c0b,
                        0x2ca4a6a86fe720d0640d725d19d289ce4ac3a9f8a9c8aa345e36577c117e7dd6
                    )
                ),
                0x004AAD923FC63B40BE3DDE294BDD1BBB064E34A4A4D51B68843FEA44532D6147
            );
    }

    /// @notice Slices a byte array
    function slice(bytes memory data, uint256 start, uint256 end) internal pure returns (bytes32 result) {
        uint256 len = end - start;
        // Slice length exceeds 32 bytes"
        assert(len <= 32);

        /// @solidity memory-safe-assembly
        assembly {
            // The bytes array in memory begins with its length at the first 32 bytes.
            // So we add 32 to get the pointer to the actual data.
            let ptr := add(data, 32)
            // Load 32 bytes from memory starting at dataPtr+start.
            let word := mload(add(ptr, start))
            // Shift right by (32 - len)*8 bits to discard any extra bytes.
            result := shr(mul(sub(32, len), 8), word)
        }
    }

    function wrapFp(bytes memory data) internal pure returns (BLS12_381.Fp memory) {
        require(data.length == 48, "Invalid Fp length");

        bytes32 a = slice(data, 0, 16);
        bytes32 b = slice(data, 16, 48);

        return BLS12_381.Fp(a, b);
    }

    function wrapFp2(bytes memory x, bytes memory y) internal pure returns (BLS12_381.Fp2 memory) {
        return BLS12_381.Fp2(wrapFp(x).a, wrapFp(x).b, wrapFp(y).a, wrapFp(y).b);
    }
}
