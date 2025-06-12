// SPDX-License-Identifier: MIT

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {SSZ} from "./SSZ.sol";

/**
 * @notice Modified & stripped BLS Lib to support ETH beacon spec for validator deposit message verification.
 * @author Lido
 * @author Solady (https://github.com/Vectorized/solady/blob/dcdfab80f4e6cb9ac35c91610b2a2ec42689ec79/src/utils/ext/ithaca/BLS.sol)
 * @author Ithaca (https://github.com/ithacaxyz/odyssey-examples/blob/main/chapter1/contracts/src/libraries/BLS.sol)
 */
// solhint-disable contract-name-capwords
library BLS12_381 {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          STRUCTS                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    // We use flattened structs to make encoding more efficient.
    // All structs use Big endian encoding.
    // See: https://eips.ethereum.org/EIPS/eip-2537

    /// @dev A representation of a base field element (Fp) in the BLS12-381 curve.
    /// Due to the size of `p`,
    /// `0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab`
    /// the top 16 bytes are always zeroes.
    struct Fp {
        bytes32 a; // Upper 32 bytes.
        bytes32 b; // Lower 32 bytes.
    }

    /// @dev A representation of an extension field element (Fp2) in the BLS12-381 curve.
    struct Fp2 {
        bytes32 c0_a;
        bytes32 c0_b;
        bytes32 c1_a;
        bytes32 c1_b;
    }

    /// @dev A representation of a point on the G1 curve of BLS12-381.
    struct G1Point {
        bytes32 x_a;
        bytes32 x_b;
        bytes32 y_a;
        bytes32 y_b;
    }

    /// @dev A representation of a point on the G2 curve of BLS12-381.
    struct G2Point {
        bytes32 x_c0_a;
        bytes32 x_c0_b;
        bytes32 x_c1_a;
        bytes32 x_c1_b;
        bytes32 y_c0_a;
        bytes32 y_c0_b;
        bytes32 y_c1_a;
        bytes32 y_c1_b;
    }

    /// @dev Y coordinates of uncompressed pubkey and signature
    struct DepositY {
        Fp pubkeyY;
        Fp2 signatureY;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         CONSTANTS                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev mask to remove sign bit from Fp via bitwise AND
    bytes32 internal constant FP_NO_SIGN_MASK = 0x1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    /// @notice Domain for deposit message signing
    /// @dev per https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#domain-types
    bytes4 internal constant DOMAIN_DEPOSIT_TYPE = 0x03000000;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                    PRECOMPILE ADDRESSES                    */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/
    /// @dev SHA256 precompile address.
    address internal constant SHA256 = 0x0000000000000000000000000000000000000002;

    /// @dev Mod Exp precompile address.
    address internal constant MOD_EXP = 0x0000000000000000000000000000000000000005;

    /// @dev For addition of two points on the BLS12-381 G2 curve.
    address internal constant BLS12_G2ADD = 0x000000000000000000000000000000000000000d;

    /// @dev For performing a pairing check on the BLS12-381 curve.
    address internal constant BLS12_PAIRING_CHECK = 0x000000000000000000000000000000000000000F;

    /// @dev For mapping a Fp2 to a point on the BLS12-381 G2 curve.
    address internal constant BLS12_MAP_FP2_TO_G2 = 0x0000000000000000000000000000000000000011;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        CUSTOM ERRORS                       */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    // A custom error for each precompile helps us in debugging which precompile has failed.

    /// @dev The G2Add operation failed.
    error G2AddFailed();

    /// @dev The pairing operation failed.
    error PairingFailed();

    /// @dev The MapFpToG2 operation failed.
    error MapFp2ToG2Failed();

    /// @dev Input has Infinity points (zero points).
    error InputHasInfinityPoints();

    /// @dev provided BLS signature is invalid
    error InvalidSignature();

    /// @dev provided pubkey length is not 48
    error InvalidPubkeyLength();

    /// @dev provided block header is invalid
    error InvalidBlockHeader();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         OPERATIONS                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /**
     * @notice Computes a point in G2 from a message. Modified to accept bytes32 and have DSL per ETH 2.0 spec
     * @param message the message to hash and map to G2 point on BLS curve
     * @dev original at https://github.com/Vectorized/solady/blob/dcdfab80f4e6cb9ac35c91610b2a2ec42689ec79/src/utils/ext/ithaca/BLS.sol#L275
     * @dev added comments and modified to use bytes32 instead of bytes and correct DSL per https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#bls-signatures
     *  */
    function hashToG2(bytes32 message) internal view returns (G2Point memory result) {
        /// @solidity memory-safe-assembly
        assembly {
            /// @dev Constructs the domain separation tag for hashing
            function dstPrime(o_, i_) -> _o {
                mstore8(o_, i_) // Write a single byte at `o_` with value `i_` (counter/index)
                mstore(add(o_, 0x01), "BLS_SIG_BLS12381G2_XMD:SHA-256_S") // Write main part of DST (32 bytes)
                mstore(add(o_, 0x21), "SWU_RO_POP_\x2b") // Write final part (12 bytes, includes '+' as 0x2b)
                _o := add(0x2d, o_) // Return pointer to the end of DST (total 45 bytes added)
            }

            /// @dev Calls SHA256 precompile with `data_` of length `n_`, returns 32-byte hash
            function sha2(data_, n_) -> _h {
                if iszero(and(eq(returndatasize(), 0x20), staticcall(gas(), SHA256, data_, n_, 0x00, 0x20))) {
                    revert(calldatasize(), 0x00) // Revert on failure
                }
                _h := mload(0x00) // Load and return hash result
            }

            /// @dev Modular reduction using MOD_EXP precompile (0x05)
            /// @param s_ Pointer to structure: [base offset][base size][modulus size][modulus]
            /// @param b_ Pointer to base value (64 bytes for fp2 element)
            function modfield(s_, b_) {
                mcopy(add(s_, 0x60), b_, 0x40) // Copy 64-byte fp2 element into structure
                if iszero(and(eq(returndatasize(), 0x40), staticcall(gas(), MOD_EXP, s_, 0x100, b_, 0x40))) {
                    revert(calldatasize(), 0x00) // Revert on failure
                }
            }

            /// @dev Map an fp2 field element to a point in G2 curve using BLS12 precompile (0x0a)
            function mapToG2(s_, r_) {
                if iszero(
                    and(eq(returndatasize(), 0x100), staticcall(gas(), BLS12_MAP_FP2_TO_G2, s_, 0x80, r_, 0x100))
                ) {
                    mstore(0x00, 0x89083b91) // Revert with MapFp2ToG2Failed()
                    revert(0x1c, 0x04)
                }
            }

            // === Begin Main Logic ===

            let b := mload(0x40) // Allocate free memory pointer `b`
            let s := add(b, 0x100) // Pointer to working buffer after `b`
            mstore(add(s, 0x40), message) // Store the message at `s + 0x40`
            let o := add(add(s, 0x40), 0x20) // Pointer after message
            mstore(o, shl(240, 256)) // Store 256 as 2-byte BE (0x0100), padded left

            // === DST prime and initial hash ===
            let b0 := sha2(s, sub(dstPrime(add(0x02, o), 0), s)) // First SHA2 with DST index 0
            mstore(0x20, b0) // Save `b0` for use in XOF loop
            mstore(s, b0) // Store b0 at start of buffer
            mstore(b, sha2(s, sub(dstPrime(add(0x20, s), 1), s))) // Store next hash at `b`

            // === XOF-style hash chaining ===
            let j := b // Pointer to next position in output chain
            for {
                let i := 2
            } 1 {

            } {
                // XOR `b0` with previous output and hash it
                mstore(s, xor(b0, mload(j)))
                j := add(j, 0x20)
                mstore(j, sha2(s, sub(dstPrime(add(0x20, s), i), s))) // SHA2 with DST index `i`
                i := add(i, 1)
                if eq(i, 9) {
                    break
                } // Loop from i = 2 to i = 8 (7 iterations)
            }

            // === Prepare MOD_EXP input structure ===
            // Format: baseLen=0x40, base=..., modulusLen=0x20, modulus=...

            // Set up structure offsets
            mstore(add(s, 0x00), 0x40) // base size = 64
            mstore(add(s, 0x20), 0x20) // modulus size = 32
            mstore(add(s, 0x40), 0x40) // base size again for second call

            // Prime modulus for BLS12-381 field
            mstore(add(s, 0xa0), 1) // dummy flag
            mstore(add(s, 0xc0), 0x000000000000000000000000000000001a0111ea397fe69a4b1ba7b6434bacd7)
            mstore(add(s, 0xe0), 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab)

            // Modular reduction on each 64-byte chunk at b, b+0x40, b+0x80, b+0xc0
            modfield(s, add(b, 0x00))
            modfield(s, add(b, 0x40))
            modfield(s, add(b, 0x80))
            modfield(s, add(b, 0xc0))

            // Map two fp2 elements to G2
            mapToG2(b, result) // result at offset 0
            mapToG2(add(0x80, b), add(0x100, result)) // second point at result + 0x100

            // Add the two G2 points together with BLS12_G2ADD precompile (0x0f)
            if iszero(and(eq(returndatasize(), 0x100), staticcall(gas(), BLS12_G2ADD, result, 0x200, result, 0x100))) {
                mstore(0x00, 0xc55e5e33) // Revert with G2AddFailed()
                revert(0x1c, 0x04)
            }
        }
    }

    /**
     * @notice Verifies the deposit message signature using BLS12-381 pairing check.
     * @param pubkey The BLS public key of the deposit.
     * @param signature The BLS signature of the deposit message.
     * @param amount The amount of the deposit in wei.
     * @param depositY Y coordinates of the uncompressed pubkey and signature.
     * @param withdrawalCredentials The withdrawal credentials associated with the deposit.
     * @param depositDomain The domain of the deposit message for the current chain.
     * @dev Reverts with `InvalidSignature` if the signature is invalid.
     * @dev Reverts with `InputHasInfinityPoints` if the input contains infinity points (zero values).
     */
    function verifyDepositMessage(
        bytes calldata pubkey,
        bytes calldata signature,
        uint256 amount,
        DepositY calldata depositY,
        bytes32 withdrawalCredentials,
        bytes32 depositDomain
    ) internal view {
        // Hash the deposit message and map it to G2 point on the curve
        G2Point memory msgG2 = hashToG2(depositMessageSigningRoot(pubkey, amount, withdrawalCredentials, depositDomain));

        // BLS Pairing check input
        // pubkeyG1 | msgG2 | NEGATED_G1_GENERATOR | signatureG2
        bytes32[24] memory input;

        // Load pubkeyG1 directly from calldata to input array
        // pubkeyG1.X = 16byte pad | flag_mask & deposit.pubkey(0 - 16 bytes) | deposit.pubkey(16 - 48 bytes)
        // pubkeyG1.Y as is from calldata
        /// @solidity memory-safe-assembly
        assembly {
            // load first 32 bytes of pubkey and apply sign mask
            mstore(
                add(input, 0x10), // to input[0.5-1.5] (16-46 bytes)
                and(calldataload(pubkey.offset), FP_NO_SIGN_MASK)
            )

            // load rest of 16 bytes of pubkey
            calldatacopy(
                add(input, 0x30), // to input[1.5-2]
                add(pubkey.offset, 0x20), // from last 16 bytes of pubkey
                0x10 // 16 bytes
            )

            //  Load all of depositY.pubkeyY
            calldatacopy(
                add(input, 0x40), // to input[2-3]
                depositY, // from depositY.pubkeyY
                0x40 // 64 bytes
            )
        }

        // validate that pubkeyG1 is not infinity point
        // required per https://eips.ethereum.org/EIPS/eip-2537#abi-for-pairing-check
        if (input[0] == 0 && input[1] == 0 && input[2] == 0 && input[3] == 0) {
            revert InputHasInfinityPoints();
        }

        // Message on Curve G2
        // no way to load directly from function return to memory
        input[4] = msgG2.x_c0_a;
        input[5] = msgG2.x_c0_b;
        input[6] = msgG2.x_c1_a;
        input[7] = msgG2.x_c1_b;
        input[8] = msgG2.y_c0_a;
        input[9] = msgG2.y_c0_b;
        input[10] = msgG2.y_c1_a;
        input[11] = msgG2.y_c1_b;

        // Negate G1 generator
        input[12] = 0x0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0f;
        input[13] = 0xc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb;
        input[14] = 0x00000000000000000000000000000000114d1d6855d545a8aa7d76c8cf2e21f2;
        input[15] = 0x67816aef1db507c96655b9d5caac42364e6f38ba0ecb751bad54dcd6b939c2ca;

        // Signature G2
        // Signature G2 X (deposit.signature has Fp2 flipped)
        //  - signatureG2.X_c1 = 16byte pad | deposit.signature(48 - 64 bytes) | deposit.signature(64 - 96 bytes)
        //  - signatureG2.X_c2 = 16byte pad | flag_mask & deposit.signature(0 - 16 bytes) | deposit.signature(16 - 48 bytes)
        // SignatureG2 Y as is from calldata
        /// @solidity memory-safe-assembly
        assembly {
            // Load signatureG2.X_c2 skipping 16 bytes of zero padding
            calldatacopy(
                add(input, 0x210), // to input[16.5-20]
                add(signature.offset, 0x30), // from  deposit.signature(48-96 bytes)
                0x30 // 48 bytes of length
            )

            // Load signatureG2.X_c1 first 32 bytes and apply sign mask
            mstore(
                add(input, 0x250), // to input[18.5-19.5]
                and(calldataload(signature.offset), FP_NO_SIGN_MASK)
            )

            // Load rest of 16 bytes of signatureG2.X_c1
            calldatacopy(
                add(input, 0x270), // to input[19.5-20]
                add(signature.offset, 0x20), // from deposit.signature(32-48 bytes)
                0x10 // 16 bytes
            )

            // Load all of depositY.signatureY to input[20-23]
            calldatacopy(
                add(input, 0x280), // copy to input[20]
                add(depositY, 0x40), // from calldata at depositY.signatureY
                0x80 // data of signatureY length
            )
        }

        // validate that signatureG2 is not infinity
        if (
            input[16] == 0 &&
            input[17] == 0 &&
            input[18] == 0 &&
            input[19] == 0 &&
            input[20] == 0 &&
            input[21] == 0 &&
            input[22] == 0 &&
            input[23] == 0
        ) {
            revert InputHasInfinityPoints();
        }

        bool isPaired;
        /// @solidity memory-safe-assembly
        assembly {
            if iszero(
                and(
                    eq(returndatasize(), 0x20), // check that return data is only 32 bytes (executes after staticall)
                    staticcall(
                        gas(),
                        BLS12_PAIRING_CHECK,
                        input, // full input array
                        0x300, // 24 * 32 bytes length
                        0x00, // output to scratch space
                        0x20 // only 1 slot
                    )
                )
            ) {
                mstore(0x00, 0x4df45e2f) // `PairingFailed()`.
                revert(0x1c, 0x04)
            }
            // load result to bool
            isPaired := mload(0x00)
        }

        if (!isPaired) {
            revert InvalidSignature();
        }
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         UTILITY                            */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @notice Extracted part from `SSZ.verifyProof` for hashing two leaves
    /// @dev Combines 2 bytes32 in 64 bytes input for sha256 precompile
    function sha256Pair(bytes32 left, bytes32 right) internal view returns (bytes32 result) {
        /// @solidity memory-safe-assembly
        assembly {
            // Store `left` at memory position 0x00
            mstore(0x00, left)
            // Store `right` at memory position 0x20
            mstore(0x20, right)

            // Call SHA-256 precompile (0x02) with 64-byte input at memory 0x00
            let success := staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20)
            if iszero(success) {
                revert(0, 0)
            }

            // Load the resulting hash from memory
            result := mload(0x00)
        }
    }

    /// @notice Extracted and modified part from `SSZ.hashTreeRoot` for hashing validator pubkey from calldata
    /// @dev Reverts if `pubkey` length is not 48
    function pubkeyRoot(bytes calldata pubkey) internal view returns (bytes32 _pubkeyRoot) {
        if (pubkey.length != 48) revert InvalidPubkeyLength();

        /// @solidity memory-safe-assembly
        assembly {
            // write 32 bytes to 32-64 bytes of scratch space
            // to ensure last 49-64 bytes of pubkey are zeroed
            mstore(0x20, 0)
            // Copy 48 bytes of `pubkey` to start of scratch space
            calldatacopy(0x00, pubkey.offset, 48)

            // Call the SHA-256 precompile (0x02) with the 64-byte input
            if iszero(staticcall(gas(), 0x02, 0x00, 0x40, 0x00, 0x20)) {
                revert(0, 0)
            }

            // Load the resulting SHA-256 hash
            _pubkeyRoot := mload(0x00)
        }
    }

    /// @notice calculation of deposit domain based on fork version
    /// @dev per https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_domain
    function computeDepositDomain(bytes4 genesisForkVersion) internal view returns (bytes32 depositDomain) {
        bytes32 forkDataRoot = sha256Pair(genesisForkVersion, bytes32(0));
        depositDomain = DOMAIN_DEPOSIT_TYPE | (forkDataRoot >> 32);
    }

    /**
     * @notice calculates the signing root for deposit message
     * @dev per https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#compute_signing_root
     * @dev not be confused with `depositDataRoot`, used for verifying BLS deposit signature
     */
    function depositMessageSigningRoot(
        bytes calldata pubkey,
        uint256 amount,
        bytes32 withdrawalCredentials,
        bytes32 depositDomain
    ) internal view returns (bytes32 root) {
        root = sha256Pair(
            // merkle root of the deposit message
            sha256Pair(
                sha256Pair(
                    // pubkey must be hashed to be used as leaf
                    pubkeyRoot(pubkey),
                    withdrawalCredentials
                ),
                sha256Pair(
                    SSZ.toLittleEndian(amount / 1 gwei),
                    // filler to make leaf count power of 2
                    bytes32(0)
                )
            ),
            depositDomain
        );
    }
}
