// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.8.9;

import {BeaconRootData, ValidatorWitness} from "contracts/common/interfaces/ValidatorWitness.sol";

struct TopUpData {
    uint256 moduleId;
    uint256[] keyIndices;
    uint256[] operatorIds;
    uint256[] validatorIndices;
    BeaconRootData beaconRootData;
    ValidatorWitness[] validatorWitness;
    uint256[] pendingBalanceGwei;
}
