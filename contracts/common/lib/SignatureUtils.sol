// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

/* See contracts/COMPILERS.md */
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24 <0.9.0;

import {ECDSA} from "./ECDSA.sol";


library SignatureUtils {
    /**
     * @dev The selector of the ERC1271's `isValidSignature(bytes32 hash, bytes signature)` function,
     * serving at the same time as the magic value that the function should return upon success.
     *
     * See https://eips.ethereum.org/EIPS/eip-1271.
     *
     * bytes4(keccak256("isValidSignature(bytes32,bytes)")
     */
    bytes4 internal constant ERC1271_IS_VALID_SIGNATURE_SELECTOR = 0x1626ba7e;

    /**
     * @dev Checks signature validity.
     *
     * If the signer address doesn't contain any code, assumes that the address is externally owned
     * and the signature is a ECDSA signature generated using its private key. Otherwise, issues a
     * static call to the signer address to check the signature validity using the ERC-1271 standard.
     */
    function isValidSignature(
        address signer,
        bytes32 msgHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal view returns (bool) {
        if (_hasCode(signer)) {
            bytes memory sig = abi.encodePacked(r, s, v);
            // Solidity <0.5 generates a regular CALL instruction even if the function being called
            // is marked as `view`, and the only way to perform a STATICCALL is to use assembly
            bytes memory data = abi.encodeWithSelector(ERC1271_IS_VALID_SIGNATURE_SELECTOR, msgHash, sig);
            bytes32 retval;
            /// @solidity memory-safe-assembly
            assembly {
                // allocate memory for storing the return value
                let outDataOffset := mload(0x40)
                mstore(0x40, add(outDataOffset, 32))
                // issue a static call and load the result if the call succeeded
                let success := staticcall(gas(), signer, add(data, 32), mload(data), outDataOffset, 32)
                if and(eq(success, 1), eq(returndatasize(), 32)) {
                    retval := mload(outDataOffset)
                }
            }
            return retval == bytes32(ERC1271_IS_VALID_SIGNATURE_SELECTOR);
        } else {
            return ECDSA.recover(msgHash, v, r, s) == signer;
        }
    }

    function _hasCode(address addr) internal view returns (bool) {
        uint256 size;
        /// @solidity memory-safe-assembly
        assembly { size := extcodesize(addr) }
        return size > 0;
    }
}
