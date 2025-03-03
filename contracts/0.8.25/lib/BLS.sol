// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SSZ} from "./SSZ.sol";

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

// for base structs & operations: https://github.com/paradigmxyz/forge-alphanet/blob/main/src/sign/BLS.sol
// for decodeG1Point/decodeG2Point: https://github.com/ralexstokes/deposit-verifier
library BLS {
    /// @dev A base field element (Fp) is encoded as 64 bytes by performing the
    /// BigEndian encoding of the corresponding (unsigned) integer. Due to the size of p,
    /// the top 16 bytes are always zeroes.
    struct Fp {
        uint256 a;
        uint256 b;
    }

    /// @dev For elements of the quadratic extension field (Fp2), encoding is byte concatenation of
    /// individual encoding of the coefficients totaling in 128 bytes for a total encoding.
    /// c0 + c1 * v
    struct Fp2 {
        Fp c0;
        Fp c1;
    }

    /// @dev Points of G1 and G2 are encoded as byte concatenation of the respective
    /// encodings of the x and y coordinates.
    /// total size is 128 bytes
    struct G1Point {
        Fp x;
        Fp y;
    }

    /// @dev Points of G1 and G2 are encoded as byte concatenation of the respective
    /// encodings of the x and y coordinates.
    /// total size is 256 bytes
    struct G2Point {
        Fp2 x;
        Fp2 y;
    }

    struct DepositYComponents {
        Fp pubkeyY;
        Fp2 signatureY;
    }

    uint256 constant SUBGROUP_ORDER = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001;

    bytes constant DST = bytes("BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_");
    uint16 constant MSG_LENGTH = 256;

    bytes1 constant BLS_BYTE_WITHOUT_FLAGS_MASK = bytes1(0x1f);
    uint256 constant FP_NO_SIGN_BIT_MASK = uint256(0x01fffffffffffffffffffffffffffffff);

    /// @notice PRECOMPILED CONTRACT ADDRESSES
    address constant SHA256 = 0x0000000000000000000000000000000000000002;
    address constant MOD_EXP = 0x0000000000000000000000000000000000000005;

    ///  forge
    // MUL is deprecated in actual EIP in favor of MSM trivial case
    // We are supposed to use MSM address but change it to MUL because of forge
    // old MSM will fail on trivial 1 point multiplication
    //address constant BLS12_G1MUL = 0x000000000000000000000000000000000000000C;
    //address constant BLS12_G1MSM = 0x000000000000000000000000000000000000000d;
    address constant BLS12_G1MSM = 0x000000000000000000000000000000000000000C;

    address constant BLS12_G2ADD = 0x000000000000000000000000000000000000000E;
    // Same for G2
    // address constant BLS12_G2MUL = 0x000000000000000000000000000000000000000F;
    // address constant BLS12_G2MSM = 0x0000000000000000000000000000000000000010;
    address constant BLS12_G2MSM = 0x000000000000000000000000000000000000000F;
    address constant BLS12_PAIRING_CHECK = 0x0000000000000000000000000000000000000011;
    address constant BLS12_MAP_FP2_TO_G2 = 0x0000000000000000000000000000000000000013;

    /** Correct Pectra addresses & gas values for precompile calls
    address constant BLS12_G2ADD = 0x000000000000000000000000000000000000000b;
    uint256 constant BLS12_G2ADD_GAS = 600;

    address constant BLS12_G1MSM = 0x000000000000000000000000000000000000000C;
    uint256 constant BLS12_G1MSM_GAS = 12000;

    address constant BLS12_G2MSM = 0x000000000000000000000000000000000000000E;
    uint256 constant BLS12_G2MSM_GAS = 22500;

    address constant BLS12_PAIRING_CHECK = 0x000000000000000000000000000000000000000F;
    uint256 constant BLS12_PAIRING_CHECK_GAS = 102900;

    address constant BLS12_MAP_FP2_TO_G2 = 0x0000000000000000000000000000000000000011;
    uint256 constant BLS12_MAP_FP2_TO_G2_GAS = 23800;

    */

    // Negated G1 generator compressed as raw bytes to save gas
    // per https://eips.ethereum.org/EIPS/eip-2537#curve-parameters
    // G1Point(
    //     Fp(
    //         31827880280837800241567138048534752271,
    //         88385725958748408079899006800036250932223001591707578097800747617502997169851
    //     ),
    //     Fp(
    //         22997279242622214937712647648895181298,
    //         46816884707101390882112958134453447585552332943769894357249934112654335001290
    //     )
    // );
    function NEGATED_G1_GENERATOR() internal pure returns (G1Point memory) {
        return
            abi.decode(
                hex"0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb00000000000000000000000000000000114d1d6855d545a8aa7d76c8cf2e21f267816aef1db507c96655b9d5caac42364e6f38ba0ecb751bad54dcd6b939c2ca",
                (G1Point)
            );
    }

    /// @notice Slices a byte array to a uint256
    function sliceToUint(bytes memory data, uint256 start, uint256 end) internal pure returns (uint256 result) {
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

    /// @notice Checks if provided point is at Infinity on the BLS curve
    /// @param point G1Point to check
    function isG1Infinity(G1Point memory point) internal pure returns (bool) {
        return point.x.a == 0 && point.x.b == 0 && point.y.a == 0 && point.y.b == 0;
    }

    /// @notice Checks if provided point is at Infinity on the BLS curve
    /// @param point G2Point to check
    function isG2Infinity(G2Point memory point) internal pure returns (bool) {
        return
            point.x.c0.a == 0 &&
            point.x.c0.b == 0 &&
            point.x.c1.a == 0 &&
            point.x.c1.b == 0 &&
            point.y.c0.a == 0 &&
            point.y.c0.b == 0 &&
            point.y.c1.a == 0 &&
            point.y.c1.b == 0;
    }

    function validateG1Point(G1Point memory point) internal view {
        if (isG1Infinity(point)) {
            revert InputHasInfinityPoints();
        }
        G1Point memory check = G1Mul(point, SUBGROUP_ORDER);

        if (!isG1Infinity(check)) {
            revert InputNotOnSubgroup();
        }
    }

    function validateG2Point(G2Point memory point) internal view {
        if (isG2Infinity(point)) {
            revert InputHasInfinityPoints();
        }
        G2Point memory check = G2Mul(point, SUBGROUP_ORDER);
        if (!isG2Infinity(check)) {
            revert InputNotOnSubgroup();
        }
    }

    function G1Mul(G1Point memory point, uint256 scalar) internal view returns (G1Point memory result) {
        bytes memory input = bytes.concat(abi.encode(point, scalar));

        (bool success, bytes memory output) = address(BLS12_G1MSM).staticcall(input);
        if (!success) {
            revert BLSG1MsmFailed();
        }
        return abi.decode(output, (G1Point));
    }

    function G2Mul(G2Point memory point, uint256 scalar) internal view returns (G2Point memory result) {
        bytes memory input = bytes.concat(abi.encode(point, scalar));

        // we have to use deprecated G2MUL because in forge
        (bool success, bytes memory output) = address(BLS12_G2MSM).staticcall(input);
        if (!success) {
            revert BLSG2MsmFailed();
        }
        return abi.decode(output, (G2Point));
    }

    function decodeG1Point(bytes calldata encodedX, Fp calldata Y) internal pure returns (G1Point memory) {
        uint256 a = sliceToUint(encodedX, 0, 16) & FP_NO_SIGN_BIT_MASK;
        uint256 b = sliceToUint(encodedX, 16, 48);
        Fp memory X = Fp(a, b);
        return G1Point(X, Y);
    }

    function decodeG2Point(bytes calldata encodedX, Fp2 calldata Y) internal pure returns (G2Point memory) {
        // Signature compressed encoding has are X Fp components packed in reverse with Z sign bit at the start

        uint256 c0_a = sliceToUint(encodedX, 48, 64); //  Fp.a is 16 bytes
        uint256 c0_b = sliceToUint(encodedX, 64, 96); //  Fp.b is 32 bytes

        uint256 c1_a = sliceToUint(encodedX, 0, 16) & FP_NO_SIGN_BIT_MASK;
        uint256 c2_b = sliceToUint(encodedX, 16, 48);
        Fp2 memory X = Fp2(Fp(c0_a, c0_b), Fp(c1_a, c2_b));
        return G2Point(X, Y);
    }

    function mapFp2ToG2(Fp2 memory element) internal view returns (G2Point memory result) {
        // exactly 23800 gas per https://eips.ethereum.org/EIPS/eip-2537#gas-schedule
        (bool success, bytes memory output) = BLS12_MAP_FP2_TO_G2.staticcall(abi.encode(element));

        if (!success) {
            revert BLSMapFp2ToG2Failed();
        }

        return abi.decode(output, (G2Point));
    }

    // solady struct is used to avoid memory corruption
    // TODO: switch to 100% solady lib methods
    struct _G2Point {
        bytes32 x_c0_a;
        bytes32 x_c0_b;
        bytes32 x_c1_a;
        bytes32 x_c1_b;
        bytes32 y_c0_a;
        bytes32 y_c0_b;
        bytes32 y_c1_a;
        bytes32 y_c1_b;
    }

    // Solady hashToG2 modified to accept bytes32 instead of bytes
    function hashToG2(bytes32 message) internal view returns (G2Point memory) {
        uint256[8] memory result;
        assembly ("memory-safe") {
            function dstPrime(o_, i_) -> _o {
                mstore8(o_, i_) // 1.
                mstore(add(o_, 0x01), "BLS_SIG_BLS12381G2_XMD:SHA-256_S") // 32.
                mstore(add(o_, 0x21), "SWU_RO_POP_\x2b") // 12.
                _o := add(0x2d, o_)
            }

            function sha2(data_, n_) -> _h {
                if iszero(and(eq(returndatasize(), 0x20), staticcall(gas(), SHA256, data_, n_, 0x00, 0x20))) {
                    revert(calldatasize(), 0x00)
                }
                _h := mload(0x00)
            }

            function modfield(s_, b_) {
                mcopy(add(s_, 0x60), b_, 0x40)
                if iszero(and(eq(returndatasize(), 0x40), staticcall(gas(), MOD_EXP, s_, 0x100, b_, 0x40))) {
                    revert(calldatasize(), 0x00)
                }
            }

            function mapToG2(s_, r_) {
                if iszero(
                    and(eq(returndatasize(), 0x100), staticcall(gas(), BLS12_MAP_FP2_TO_G2, s_, 0x80, r_, 0x100))
                ) {
                    mstore(0x00, 0x89083b91) // `MapFp2ToG2Failed()`.
                    revert(0x1c, 0x04)
                }
            }

            let b := mload(0x40)
            let s := add(b, 0x100)
            mstore(add(s, 0x40), message)
            let o := add(add(s, 0x40), 0x20)
            mstore(o, shl(240, 256))
            let b0 := sha2(s, sub(dstPrime(add(0x02, o), 0), s))
            mstore(0x20, b0)
            mstore(s, b0)
            mstore(b, sha2(s, sub(dstPrime(add(0x20, s), 1), s)))
            let j := b
            for {
                let i := 2
            } 1 {

            } {
                mstore(s, xor(b0, mload(j)))
                j := add(j, 0x20)
                mstore(j, sha2(s, sub(dstPrime(add(0x20, s), i), s)))
                i := add(i, 1)
                if eq(i, 9) {
                    break
                }
            }

            mstore(add(s, 0x00), 0x40)
            mstore(add(s, 0x20), 0x20)
            mstore(add(s, 0x40), 0x40)
            mstore(add(s, 0xa0), 1)
            mstore(add(s, 0xc0), 0x000000000000000000000000000000001a0111ea397fe69a4b1ba7b6434bacd7)
            mstore(add(s, 0xe0), 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab)
            modfield(s, add(b, 0x00))
            modfield(s, add(b, 0x40))
            modfield(s, add(b, 0x80))
            modfield(s, add(b, 0xc0))

            mapToG2(b, result)
            mapToG2(add(0x80, b), add(0x100, result))

            if iszero(and(eq(returndatasize(), 0x100), staticcall(gas(), BLS12_G2ADD, result, 0x200, result, 0x100))) {
                mstore(0x00, 0xc55e5e33) // `G2AddFailed()`.
                revert(0x1c, 0x04)
            }
        }

        return
            G2Point(
                Fp2(Fp(result[0], result[1]), Fp(result[2], result[3])),
                Fp2(Fp(result[4], result[5]), Fp(result[6], result[7]))
            );
    }

    function verifyDepositMessage(
        IStakingVault.Deposit calldata deposit,
        DepositYComponents calldata depositY,
        bytes32 withdrawalCredentials
    ) internal view {
        bytes32 root = SSZ.depositMessageSigningRoot(deposit, withdrawalCredentials);
        G2Point memory msgG2 = hashToG2(root);
        // might be exsessive, need to check
        validateG2Point(msgG2);

        // can be optimized by correctly copying calldata bytes to precompile input
        // pubkeyG1 = ( 16byte pad | flag_mask & deposit.pubkey | depositY.pubkeyY)
        G1Point memory pubkeyG1 = decodeG1Point(deposit.pubkey, depositY.pubkeyY);
        validateG1Point(pubkeyG1);

        // signatureG2 is tricker as signature has Fp
        G2Point memory signatureG2 = decodeG2Point(deposit.signature, depositY.signatureY);
        validateG2Point(signatureG2);

        bytes memory input = bytes.concat(abi.encode(pubkeyG1, msgG2, NEGATED_G1_GENERATOR(), signatureG2));

        (bool success, bytes memory output) = BLS12_PAIRING_CHECK.staticcall(input);

        if (!success) {
            revert BLSPairingFailed();
        }

        bool result = abi.decode(output, (bool));

        if (!result) {
            revert InvalidSignature();
        }
    }

    // Precompile errors
    error BLSG1MsmFailed();
    error BLSG2MsmFailed();
    error ModExpFailed();
    error BLSG2AddFailed();
    error BLSPairingFailed();
    error BLSMapFp2ToG2Failed();

    // Signature errors
    error InvalidSignature();
    error InputHasInfinityPoints();
    error InputNotOnSubgroup();
}
