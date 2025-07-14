// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {HashConsensus} from "contracts/0.8.9/oracle/HashConsensus.sol";

// This contract is used to match the interfaces and the contracts
// without need to modify the contract source - to avoid discrepancy between the contract
// source in the repository and the contract source code deployed to sources explorer.
abstract contract InterfacesMatcher_0_8_9 {
    constructor() {
        IHashConsensus(address(new HashConsensus(0, 0, 0, 0, 0, address(0), address(0))));
    }
}
