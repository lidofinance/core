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
    address constant MOD_EXP = address(0x05);

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

    function hashToFieldFp2(bytes32 message) internal view returns (Fp2[2] memory) {
        // 1. len_in_bytes = count * m * L
        // so always 2 * 2 * 64 = 256
        // 2. uniform_bytes = expand_message(msg, DST, len_in_bytes)
        bytes32[] memory pseudoRandomBytes = expandMsgXmd(message);
        Fp2[2] memory u;
        // No loop here saves 800 gas hardcoding offset an additional 300
        // 3. for i in (0, ..., count - 1):
        // 4.   for j in (0, ..., m - 1):
        // 5.     elm_offset = L * (j + i * m)
        // 6.     tv = substr(uniform_bytes, elm_offset, HTF_L)
        // uint8 HTF_L = 64;
        // bytes memory tv = new bytes(64);
        // 7.     e_j = OS2IP(tv) mod p
        // 8.   u_i = (e_0, ..., e_(m - 1))
        // tv = bytes.concat(pseudo_random_bytes[0], pseudo_random_bytes[1]);
        u[0].c0 = modfield(pseudoRandomBytes[0], pseudoRandomBytes[1]);
        u[0].c1 = modfield(pseudoRandomBytes[2], pseudoRandomBytes[3]);
        u[1].c0 = modfield(pseudoRandomBytes[4], pseudoRandomBytes[5]);
        u[1].c1 = modfield(pseudoRandomBytes[6], pseudoRandomBytes[7]);
        // 9. return (u_0, ..., u_(count - 1))
        return u;
    }

    // passing two bytes32 instead of bytes memory saves approx 700 gas per call
    // Computes the mod against the bls12-381 field modulus
    function modfield(bytes32 _b1, bytes32 _b2) internal view returns (Fp memory r) {
        (bool success, bytes memory output) = MOD_EXP.staticcall(
            abi.encode(
                // arg[0] = base.length
                0x40,
                // arg[1] = exp.length
                0x20,
                // arg[2] = mod.length
                0x40,
                // arg[3] = base.bits
                // places the first 32 bytes of _b1 and the last 32 bytes of _b2
                _b1,
                _b2,
                // arg[4] = exp
                // exponent always 1
                1,
                // arg[5] = mod
                // this field_modulus as hex 4002409555221667393417789825735904156556882819939007885332058136124031650490837864442687629129015664037894272559787
                // we add the 0 prefix so that the result will be exactly 64 bytes
                // saves 300 gas per call instead of sending it along every time
                // places the first 32 bytes and the last 32 bytes of the field modulus
                0x000000000000000000000000000000001a0111ea397fe69a4b1ba7b6434bacd7,
                0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab
            )
        );
        if (!success) {
            revert ModExpFailed();
        }
        return abi.decode(output, (Fp));
    }

    function hashToCurveG2(bytes32 message) internal view returns (G2Point memory) {
        // 1. u = hash_to_field(msg, 2)
        Fp2[2] memory u = hashToFieldFp2(message);
        // 2. Q0 = map_to_curve(u[0])
        G2Point memory q0 = mapFp2ToG2(u[0]);
        // 3. Q1 = map_to_curve(u[1])
        G2Point memory q1 = mapFp2ToG2(u[1]);
        // 4. R = Q0 + Q1

        // G2ADD address is 0x0e
        (bool success, bytes memory output) = BLS12_G2ADD.staticcall(abi.encode(q0, q1));
        if (!success) {
            revert BLSG2AddFailed();
        }
        return abi.decode(output, (G2Point));
    }

    /// @notice Computes a field point from a message
    /// @dev Follows https://datatracker.ietf.org/doc/html/rfc9380#section-5.3
    /// @dev bytes32[] because len_in_bytes is always a multiple of 32 in our case even 128
    /// @param message byte32 to be hashed
    /// @return A field point
    function expandMsgXmd(bytes32 message) internal pure returns (bytes32[] memory) {
        // 1.  ell = ceil(len_in_bytes / b_in_bytes)
        // b_in_bytes seems to be 32 for sha256
        // ceil the division
        uint256 ell = (MSG_LENGTH - 1) / 32 + 1;

        bytes memory dstPrime = bytes.concat(DST, bytes1(uint8(DST.length)));

        // 4.  Z_pad = I2OSP(0, s_in_bytes)
        // this should be sha256 blocksize so 64 bytes
        bytes memory zPad = new bytes(64);

        // 5.  l_i_b_str = I2OSP(len_in_bytes, 2)
        // length in byte string?
        bytes2 libStr = bytes2(MSG_LENGTH);

        // 6.  msg_prime = Z_pad || msg || l_i_b_str || I2OSP(0, 1) || DST_prime
        bytes memory msgPrime = bytes.concat(zPad, message, libStr, hex"00", dstPrime);

        // 7.  b_0 = H(msg_prime)
        bytes32 b_0 = sha256(msgPrime);

        bytes32[] memory b = new bytes32[](ell);

        // 8.  b_1 = H(b_0 || I2OSP(1, 1) || DST_prime)
        b[0] = sha256(bytes.concat(b_0, hex"01", dstPrime));

        // 9.  for i in (2, ..., ell):
        for (uint8 i = 2; i <= ell; i++) {
            // 10.    b_i = H(strxor(b_0, b_(i - 1)) || I2OSP(i, 1) || DST_prime)
            bytes memory tmp = abi.encodePacked(b_0 ^ b[i - 2], i, dstPrime);
            b[i - 1] = sha256(tmp);
        }
        // 11. uniform_bytes = b_1 || ... || b_ell
        // 12. return substr(uniform_bytes, 0, len_in_bytes)
        // Here we don't need the uniform_bytes because b is already properly formed
        return b;
    }

    function verifyDepositMessage(
        IStakingVault.Deposit calldata deposit,
        DepositYComponents calldata depositY,
        bytes32 withdrawalCredentials
    ) internal view {
        bytes32 message = SSZ.depositMessageSigningRoot(deposit, withdrawalCredentials);
        G2Point memory msgG2 = hashToCurveG2(message);
        // might be exsessive, need to check
        validateG2Point(msgG2);

        G1Point memory pubkeyG1 = decodeG1Point(deposit.pubkey, depositY.pubkeyY);
        validateG1Point(pubkeyG1);

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
