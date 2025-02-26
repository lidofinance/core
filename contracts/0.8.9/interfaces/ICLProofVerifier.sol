// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

type Slot is uint64;
type GIndex is bytes32;

// As defined in phase0/beacon-chain.md:356
struct Validator {
    bytes pubkey;
    bytes32 withdrawalCredentials;
    uint64 effectiveBalance;
    bool slashed;
    uint64 activationEligibilityEpoch;
    uint64 activationEpoch;
    uint64 exitEpoch;
    uint64 withdrawableEpoch;
}

// As defined in phase0/beacon-chain.md:436
struct BeaconBlockHeader {
    Slot slot;
    uint64 proposerIndex;
    bytes32 parentRoot;
    bytes32 stateRoot;
    bytes32 bodyRoot;
}

struct ValidatorWitness {
    uint64 validatorIndex;
    Validator validator;
    bytes32[] validatorProof;
}

struct ProvableBeaconBlockHeader {
    BeaconBlockHeader header; // Header of a block which root is a root at rootsTimestamp.
    uint64 rootsTimestamp; // To be passed to the EIP-4788 block roots contract.
}

// A witness for a block header which root is accessible via `historical_summaries` field.
struct HistoricalHeaderWitness {
    BeaconBlockHeader header;
    GIndex rootGIndex;
    bytes32[] proof;
}

interface ICLProofVerifier {
    function verifyValidatorProof(
        ProvableBeaconBlockHeader calldata beaconBlock,
        ValidatorWitness calldata witness
    ) external view;

    function verifyHistoricalValidatorProof(
        ProvableBeaconBlockHeader calldata beaconBlock,
        HistoricalHeaderWitness calldata oldBlock,
        ValidatorWitness calldata witness
    ) external view;
}
