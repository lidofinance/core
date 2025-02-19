// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "hardhat/console.sol";

// https://github.com/paradigmxyz/forge-alphanet/blob/main/src/sign/BLS.sol
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

    function _u(uint256 x) internal pure returns (bytes32) {
        return bytes32(x);
    }

    function unwrapG2(G2Point memory p) internal pure returns (bytes memory) {
        return abi.encodePacked(p.x.c0.a, p.x.c0.b, p.x.c1.a, p.x.c1.b, p.y.c0.a, p.y.c0.b, p.y.c1.a, p.y.c1.b);
    }

    function MapFp2ToG2(Fp2 memory element) internal view returns (G2Point memory result) {
        // MAP_FP2_TO_G2 address is 0x13
        (bool success, bytes memory output) = address(0x13).staticcall(abi.encode(element));
        require(success, "MAP_FP2_TO_G2 failed");
        return abi.decode(output, (G2Point));
    }

    function hashToFieldFp2(bytes memory message, bytes memory dst) private view returns (Fp2[2] memory) {
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
        (bool success, bytes memory output) = address(0x5).staticcall(
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

    function hashToCurveG2(bytes memory message) internal view returns (G2Point memory) {
        // 1. u = hash_to_field(msg, 2)
        Fp2[2] memory u = hashToFieldFp2(message, bytes("BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_"));
        // 2. Q0 = map_to_curve(u[0])
        G2Point memory q0 = MapFp2ToG2(u[0]);
        // 3. Q1 = map_to_curve(u[1])
        G2Point memory q1 = MapFp2ToG2(u[1]);
        // 4. R = Q0 + Q1
        return G2Add(q0, q1);
    }

    /// @notice G2ADD operation
    /// @param a First G2 point
    /// @param b Second G2 point
    /// @return result Resulted G2 point
    function G2Add(G2Point memory a, G2Point memory b) internal view returns (G2Point memory result) {
        // G2ADD address is 0x0e
        (bool success, bytes memory output) = address(0x0e).staticcall(abi.encode(a, b));
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
        bytes memory message,
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

    uint256 constant WEI_PER_GWEI = 1e9;
    uint256 constant PUBLIC_KEY_LENGTH = 48;
    bytes32 constant DEPOSIT_DOMAIN = 0x0300000000000000000000000000000000000000000000000000000000000000;

    // Return a `wei` value in units of Gwei and serialize as a (LE) `bytes8`.
    function serializeAmount(uint256 amount) private pure returns (bytes memory) {
        uint256 depositAmount = amount / WEI_PER_GWEI;

        bytes memory encodedAmount = new bytes(8);

        for (uint256 i = 0; i < 8; i++) {
            encodedAmount[i] = bytes1(uint8(depositAmount / (2 ** (8 * i))));
        }

        return encodedAmount;
    }

    function computeSigningRoot(
        bytes memory publicKey,
        bytes32 withdrawalCredentials,
        uint256 amount
    ) public pure returns (bytes32) {
        bytes memory serializedPublicKey = new bytes(64);
        for (uint256 i = 0; i < PUBLIC_KEY_LENGTH; i++) {
            serializedPublicKey[i] = publicKey[i];
        }

        bytes32 publicKeyRoot = sha256(serializedPublicKey);
        bytes32 firstNode = sha256(abi.encodePacked(publicKeyRoot, withdrawalCredentials));

        bytes memory amountRoot = new bytes(64);
        bytes memory serializedAmount = serializeAmount(amount);
        for (uint256 i = 0; i < 8; i++) {
            amountRoot[i] = serializedAmount[i];
        }
        bytes32 secondNode = sha256(amountRoot);

        bytes32 depositMessageRoot = sha256(abi.encodePacked(firstNode, secondNode));

        return sha256(abi.encodePacked(depositMessageRoot, DEPOSIT_DOMAIN));
    }

    /// @notice PAIRING operation
    /// @param g1Points Array of G1 points
    /// @param g2Points Array of G2 points
    /// @return result Returns whether pairing result is equal to the multiplicative identity (1).
    function Pairing(G1Point[] memory g1Points, G2Point[] memory g2Points) internal view returns (bool result) {
        bytes memory input;
        for (uint256 i = 0; i < g1Points.length; i++) {
            input = bytes.concat(input, abi.encode(g1Points[i], g2Points[i]));
        }

        // PAIRING address is 0x11
        (bool success, bytes memory output) = address(0x11).staticcall(input);
        require(success, "Pairing failed");
        return abi.decode(output, (bool));
    }

    function verifyDeposit(
        bytes memory pubkey, // must be 48 bytes
        bytes32 withdrawal, // 32 bytes
        uint256 amount,
        bytes memory signature // must be 96 bytes
    ) internal view {
        require(pubkey.length == 48, "Invalid pubkey length");
        require(signature.length == 96, "Invalid signature length");

        // In the Ethereum deposit contract the “signing root” is computed as the SSZ hash_tree_root
        // of DepositMessage.
        bytes memory msgHash = abi.encodePacked(computeSigningRoot(pubkey, withdrawal, amount));

        // Compute the “hash-to-G2” of the message.
        // In a real implementation, use a proper hash_to_curve per the BLS12-381 spec.
        G2Point memory msgG2 = hashToCurveG2(msgHash); // expected to be 96 bytes

        // The pairing precompile expects an input consisting of the concatenation of:
        //   (pubkey, msgG2) and (NEG_G1_GENERATOR , signature)
        // where each G1 element is 48 bytes and each G2 element is 96 bytes.
        //require(abi.encode(msgG2).length == 96, "Invalid msgG2 length");
        //require(abi.encode(NEGATED_G1_GENERATOR()).length == 96, "Invalid NEG_G1_GENERATOR length");
        bytes memory input;
        bytes.concat(input, abi.encode(pubkey, msgG2));
        bytes.concat(input, abi.encode(NEGATED_G1_GENERATOR(), signature));

        require(input.length == 48 + 96 + 48 + 96, "Invalid input length");

        // Call the pairing precompile (using staticcall)
        (bool success, bytes memory result) = address(0x11).staticcall(input);
        if (!success) {
            revert InvalidSignature();
        }
        // The precompile returns a 32-byte value. A nonzero value indicates a valid pairing check.
        uint256 output = abi.decode(result, (uint256));
        if (output == 0) {
            revert InvalidSignature();
        }
    }

    error InvalidSignature();
}
