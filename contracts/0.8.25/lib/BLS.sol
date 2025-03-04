// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SSZ} from "./SSZ.sol";

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

/// @notice modified&stripped Solady BLS Lib to support ETH beacon spec for validator deposit message verification
/// @author Lido
/// @author Solady (https://github.com/vectorized/solady/blob/main/src/utils/BLS.sol)
/// @author Ithaca (https://github.com/ithacaxyz/odyssey-examples/blob/main/chapter1/contracts/src/libraries/BLS.sol)
///
/// @dev Precompile addresses come from the BLS addresses submodule in AlphaNet, see
/// See: (https://github.com/paradigmxyz/alphanet/blob/main/crates/precompile/src/addresses.rs)
///
/// Note:
/// - This implementation uses `mcopy`, since any chain that is edgy enough to
///   implement the BLS precompiles will definitely have implemented cancun.
/// - For efficiency, we use the legacy `staticcall` to call the precompiles.
///   For the intended use case in an entry points that requires gas-introspection,
///   which requires legacy bytecode, this won't be a blocker.
library BLS {
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
    struct DepositYComponents {
        Fp pubkeyY;
        Fp2 signatureY;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         CONSTANTS                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev mask to remove sign bit from Fp via bitwise AND
    bytes32 constant FP_NO_SIGN_MASK = 0x1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                    PRECOMPILE ADDRESSES                    */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    // Correct Pectra addreses are not avaliable in forge

    /// @dev SHA256 precompile address.
    address internal constant SHA256 = 0x0000000000000000000000000000000000000002;

    /// @dev Mod Exp precompile address.
    address constant MOD_EXP = 0x0000000000000000000000000000000000000005;

    /// @dev For addition of two points on the BLS12-381 G2 curve.
    //address internal constant BLS12_G2ADD = 0x000000000000000000000000000000000000000d;
    address internal constant BLS12_G2ADD = 0x000000000000000000000000000000000000000E;

    /// @dev For performing a pairing check on the BLS12-381 curve.
    //address internal constant BLS12_PAIRING_CHECK = 0x000000000000000000000000000000000000000F;
    address internal constant BLS12_PAIRING_CHECK = 0x0000000000000000000000000000000000000011;

    /// @dev For mapping a Fp2 to a point on the BLS12-381 G2 curve.
    //address internal constant BLS12_MAP_FP2_TO_G2 = 0x0000000000000000000000000000000000000011;
    address internal constant BLS12_MAP_FP2_TO_G2 = 0x0000000000000000000000000000000000000013;

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

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         OPERATIONS                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Computes a point in G2 from a message. Modified to accept bytes32 and have DSL per ETH 2.0 spec
    function hashToG2(bytes32 message) internal view returns (G2Point memory result) {
        /// @solidity memory-safe-assembly
        assembly {
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
    }

    function verifyDepositMessage(
        IStakingVault.Deposit calldata deposit,
        DepositYComponents calldata depositY,
        bytes32 withdrawalCredentials
    ) internal view {
        // Hash the deposit message and map it to G2 point on the curve
        G2Point memory msgG2 = hashToG2(SSZ.depositMessageSigningRoot(deposit, withdrawalCredentials));

        // BLS Pairing check input
        // pubkeyG1 | msgG2 | NEGATED_G1_GENERATOR | signatureG2
        bytes32[24] memory input;

        // Load pubkeyG1 directly from calldata to input array
        // pubkeyG1.X = 16byte pad | flag_mask & deposit.pubkey(0 - 16 bytes) | deposit.pubkey(16 - 48 bytes)
        // pubkeyG1.Y as is from calldata
        bytes calldata pubkey = deposit.pubkey;
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
        bytes calldata signature = deposit.signature;
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
}
