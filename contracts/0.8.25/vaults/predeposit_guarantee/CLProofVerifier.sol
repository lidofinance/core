// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {GIndex} from "../../lib/GIndex.sol";
import {Validator, SSZ} from "../../lib/SSZ.sol";

struct ValidatorWitness {
    Validator validator;
    bytes32[] proof;
    GIndex generalIndex;
    uint64 beaconBlockTimestamp;
}

contract CLProofVerifier {
    using SSZ for Validator;
    // See `BEACON_ROOTS_ADDRESS` constant in the EIP-4788.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    // Is gI safe for user input?
    // it securely narrows search only to validators reducing hash collusion risk
    // but makes us store GIndex of the first validator in the contract
    // which it turn makes us dependant on the hardfork(as GI can change with it)
    // and makes it harder for us to revoke ownership and ossify the contract
    function _validateWCProof(ValidatorWitness calldata _witness) internal view returns (bytes32) {
        if (_witness.generalIndex.index() <= 1) {
            revert InvalidGeneralIndex();
        }
        SSZ.verifyProof({
            proof: _witness.proof,
            root: _getParentBlockRoot(_witness.beaconBlockTimestamp),
            leaf: _witness.validator.hashTreeRoot(),
            gI: _witness.generalIndex
        });
        return _witness.validator.withdrawalCredentials;
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
    error InvalidGeneralIndex();
    error RootNotFound();
}
