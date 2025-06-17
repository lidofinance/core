// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import "@openzeppelin/contracts-v4.4/utils/cryptography/ECDSA.sol";

// This is a reference implementation of ERC1271Wallet contract from ERC-1271 standard
// It recognizes the signature of the owner as a valid signature
// It is used for testing purposes only
contract ERC1271Wallet {
    address public owner;

    constructor(address _owner) {
        owner = _owner;
    }

    /**
     * @notice Verifies that the signer is the owner of the signing contract.
     */
    function isValidSignature(bytes32 _hash, bytes calldata _signature) external view returns (bytes4) {
        // Validate signatures
        if (ECDSA.recover(_hash, _signature) == owner) {
            return 0x1626ba7e;
        } else {
            return bytes4(0);
        }
    }
}
