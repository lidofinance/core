// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.8.9;

struct TopUpData {
    uint256 moduleId;
    // key indexes and operator ids needed to verify key belong to module
    uint256[] keyIndices;
    uint256[] operatorIds;
    uint256[] validatorIndices;
    BeaconRootData beaconRootData;
    ValidatorWitness[] validatorWitness;
    BalanceWitness[] balanceWitness;
    PendingWitness[][] pendingWitness;
}

// тоже пакуем
struct BeaconRootData {
    uint64 childBlockTimestamp; // for EIP-4788 lookup
    uint64 slot; // header slot
    uint64 proposerIndex; // header proposer
}
// 

struct ValidatorWitness {
    // Merkle path: Validator[i] → … → state_root → beacon_block_root
    bytes32[] proofValidator;
    //  bytes32[] proofBalance;
    // Full Validator container fields (minus WC)
    bytes pubkey;

    // доп слово 
    uint64 effectiveBalance;
    uint64 activationEligibilityEpoch;
    uint64 activationEpoch;
    //  uint64 balanceGwei;

    // допустим  пакуем 256 пакуем
    uint64 exitEpoch;
    uint64 withdrawableEpoch;
    bool slashed;
}

struct BalanceWitness {
    // Merkle path: balances[i] → … → state_root → beacon_block_root
    bytes32[] proofBalance;
    // balances[i] value
    uint64 balanceGwei; // 
}

// pack 256 - uint32, uint64 , unit64 (160 вметсто 256 * 3)

struct PendingWitness {
    bytes32[] proof;
    bytes signature;
    uint64 amount;
    uint64 slot;
    uint32 index;
}
