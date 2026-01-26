// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.8.9;

struct TopUpData {
    uint256 moduleId;
    uint256[] keyIndices;
    uint256[] operatorIds;
    uint256[] validatorIndices;
    BeaconRootData beaconRootData;
    ValidatorWitness[] validatorWitness;
    uint256[] pendingBalanceGwei;
}

struct BeaconRootData {
    uint64 childBlockTimestamp; // for EIP-4788 lookup
    uint64 slot; // header slot
    uint64 proposerIndex; // header proposer
}

struct ValidatorWitness {
    // Merkle path: Validator[i] → … → state_root → beacon_block_root
    bytes32[] proofValidator;
    // Full Validator container fields (minus WC)
    bytes pubkey;
    uint64 effectiveBalance;
    uint64 activationEligibilityEpoch;
    uint64 activationEpoch;
    uint64 exitEpoch;
    uint64 withdrawableEpoch;
    bool slashed;
}
