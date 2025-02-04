// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Validator, SSZ} from "../../lib/SSZ.sol";

import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";

contract CLProofVerifier {
    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    function _validateWCProof(
        Validator calldata _validator,
        bytes32[] calldata _proof,
        uint64 beaconBlockTimestamp
    ) internal view returns (bytes32) {
        if (
            !MerkleProof.verifyCalldata(_proof, _getParentBlockRoot(beaconBlockTimestamp), SSZ.hashTreeRoot(_validator))
        ) {
            revert InvalidProof();
        }
        return _validator.withdrawalCredentials;
    }

    // virtual for testing
    function _getParentBlockRoot(uint64 blockTimestamp) internal view virtual returns (bytes32) {
        (bool success, bytes memory data) = BEACON_ROOTS.staticcall(abi.encode(blockTimestamp));

        if (!success || data.length == 0) {
            revert RootNotFound();
        }

        return abi.decode(data, (bytes32));
    }

    // proving errors
    error RootNotFound();
    error InvalidProof();
}
