// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SSZ} from "./SSZ.sol";

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
    struct G1Point {
        Fp x;
        Fp y;
    }

    /// @dev Points of G1 and G2 are encoded as byte concatenation of the respective
    /// encodings of the x and y coordinates.
    struct G2Point {
        Fp2 x;
        Fp2 y;
    }

    bytes1 constant BLS_BYTE_WITHOUT_FLAGS_MASK = bytes1(0x1f);

    /// @notice PRECOMPILED CONTRACT ADDRESSES
    address constant MOD_EXP = address(0x05);
    // forge
    address constant BLS12_G2ADD = address(0x0e);
    address constant BLS12_PAIRING_CHECK = address(0x10);
    address constant BLS12_MAP_FP2_TO_G2 = address(0x13);

    // revm
    // address constant BLS12_G2ADD = address(0x0d);
    // address constant BLS12_PAIRING_CHECK = address(0x0f);
    // address constant BLS12_MAP_FP2_TO_G2 = address(0x11);

    // TODO make constant
    function NEGATED_G1_GENERATOR() internal pure returns (G1Point memory) {
        return
            G1Point(
                Fp(
                    31827880280837800241567138048534752271,
                    88385725958748408079899006800036250932223001591707578097800747617502997169851
                ),
                Fp(
                    22997279242622214937712647648895181298,
                    46816884707101390882112958134453447585552332943769894357249934112654335001290
                )
            );
    }

    function sliceToUint(bytes memory data, uint256 start, uint256 end) internal pure returns (uint256 result) {
        require(end >= start, "Invalid slice");
        uint256 len = end - start;
        require(len <= 32, "Slice length exceeds 32 bytes");

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

    function decodeG1Point(bytes memory encodedX, Fp memory Y) internal pure returns (G1Point memory) {
        encodedX[0] = encodedX[0] & BLS_BYTE_WITHOUT_FLAGS_MASK;
        uint256 a = sliceToUint(encodedX, 0, 16);
        uint256 b = sliceToUint(encodedX, 16, 48);
        Fp memory X = Fp(a, b);
        return G1Point(X, Y);
    }

    function decodeG2Point(bytes memory encodedX, Fp2 memory Y) internal pure returns (G2Point memory) {
        encodedX[0] = encodedX[0] & BLS_BYTE_WITHOUT_FLAGS_MASK;
        // NOTE: the "flag bits" of the second half of `encodedX` are always == 0x0

        // NOTE: order is important here for decoding point...
        uint256 aa = sliceToUint(encodedX, 48, 64);
        uint256 ab = sliceToUint(encodedX, 64, 96);
        uint256 ba = sliceToUint(encodedX, 0, 16);
        uint256 bb = sliceToUint(encodedX, 16, 48);
        Fp2 memory X = Fp2(Fp(aa, ab), Fp(ba, bb));
        return G2Point(X, Y);
    }

    function mapFp2ToG2(Fp2 memory element) public view returns (G2Point memory result) {
        (bool success, bytes memory output) = BLS12_MAP_FP2_TO_G2.staticcall(abi.encode(element));
        require(success, "MAP_FP2_TO_G2 failed");
        return abi.decode(output, (G2Point));
    }

    function hashToFieldFp2(bytes32 message, bytes memory dst) private view returns (Fp2[2] memory) {
        // 1. len_in_bytes = count * m * L
        // so always 2 * 2 * 64 = 256
        uint16 lenInBytes = 256;
        // 2. uniform_bytes = expand_message(msg, DST, len_in_bytes)
        bytes32[] memory pseudoRandomBytes = expandMsgXmd(message, dst, lenInBytes);
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
        u[0].c0 = _modfield(pseudoRandomBytes[0], pseudoRandomBytes[1]);
        u[0].c1 = _modfield(pseudoRandomBytes[2], pseudoRandomBytes[3]);
        u[1].c0 = _modfield(pseudoRandomBytes[4], pseudoRandomBytes[5]);
        u[1].c1 = _modfield(pseudoRandomBytes[6], pseudoRandomBytes[7]);
        // 9. return (u_0, ..., u_(count - 1))
        return u;
    }

    // passing two bytes32 instead of bytes memory saves approx 700 gas per call
    // Computes the mod against the bls12-381 field modulus
    function _modfield(bytes32 _b1, bytes32 _b2) private view returns (Fp memory r) {
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
        require(success, "MODEXP failed");
        return abi.decode(output, (Fp));
    }

    function hashToCurveG2(bytes32 message) internal view returns (G2Point memory) {
        // 1. u = hash_to_field(msg, 2)
        Fp2[2] memory u = hashToFieldFp2(message, bytes("BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_"));
        // 2. Q0 = map_to_curve(u[0])
        G2Point memory q0 = mapFp2ToG2(u[0]);
        // 3. Q1 = map_to_curve(u[1])
        G2Point memory q1 = mapFp2ToG2(u[1]);
        // 4. R = Q0 + Q1

        // G2ADD address is 0x0e
        (bool success, bytes memory output) = BLS12_G2ADD.staticcall(abi.encode(q0, q1));
        require(success, "G2ADD failed");
        return abi.decode(output, (G2Point));
    }

    /// @notice Computes a field point from a message
    /// @dev Follows https://datatracker.ietf.org/doc/html/rfc9380#section-5.3
    /// @dev bytes32[] because len_in_bytes is always a multiple of 32 in our case even 128
    /// @param message Arbitrarylength byte string to be hashed
    /// @param dst The domain separation tag of at most 255 bytes
    /// @param lenInBytes The length of the requested output in bytes
    /// @return A field point
    function expandMsgXmd(
        bytes32 message,
        bytes memory dst,
        uint16 lenInBytes
    ) private pure returns (bytes32[] memory) {
        // 1.  ell = ceil(len_in_bytes / b_in_bytes)
        // b_in_bytes seems to be 32 for sha256
        // ceil the division
        uint256 ell = (lenInBytes - 1) / 32 + 1;

        // 2.  ABORT if ell > 255 or len_in_bytes > 65535 or len(DST) > 255
        require(ell <= 255, "len_in_bytes too large for sha256");
        // Not really needed because of parameter type
        // require(lenInBytes <= 65535, "len_in_bytes too large");
        // no length normalizing via hashing
        require(dst.length <= 255, "dst too long");

        bytes memory dstPrime = bytes.concat(dst, bytes1(uint8(dst.length)));

        // 4.  Z_pad = I2OSP(0, s_in_bytes)
        // this should be sha256 blocksize so 64 bytes
        bytes memory zPad = new bytes(64);

        // 5.  l_i_b_str = I2OSP(len_in_bytes, 2)
        // length in byte string?
        bytes2 libStr = bytes2(lenInBytes);

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

    function pairing(G1Point[] memory g1Points, G2Point[] memory g2Points) internal view returns (bool result) {
        bytes memory input;
        for (uint256 i = 0; i < g1Points.length; i++) {
            input = bytes.concat(input, abi.encode(g1Points[i], g2Points[i]));
        }

        (bool success, bytes memory output) = BLS12_PAIRING_CHECK.staticcall(input);
        if (!success) {
            revert InvalidSignature();
        }
        return abi.decode(output, (bool));
    }

    function verifyDeposit(
        bytes calldata pubkey, // must be 48 bytes
        bytes32 withdrawal, // 32 bytes
        uint256 amount,
        bytes memory signature, // must be 96 bytes
        Fp memory pubkeyYComponent,
        Fp2 memory signatureYComponent
    ) internal view {
        require(pubkey.length == 48, "Invalid pubkey length");
        require(signature.length == 96, "Invalid signature length");

        // In the Ethereum deposit contract the “signing root” is computed as the SSZ hash_tree_root
        bytes32 msgHash = SSZ.depositMessageSigningRoot(pubkey, withdrawal, amount);
        G2Point memory msgG2 = hashToCurveG2(msgHash);

        G2Point memory signatureG2 = decodeG2Point(signature, signatureYComponent);
        G1Point memory pubkeyG1 = decodeG1Point(pubkey, pubkeyYComponent);

        G1Point[] memory g1Points = new BLS.G1Point[](2);
        G2Point[] memory g2Points = new BLS.G2Point[](2);

        g1Points[0] = pubkeyG1;
        g1Points[1] = NEGATED_G1_GENERATOR();

        g2Points[0] = msgG2;
        g2Points[1] = signatureG2;

        pairing(g1Points, g2Points);
    }

    error InvalidSignature();
}
