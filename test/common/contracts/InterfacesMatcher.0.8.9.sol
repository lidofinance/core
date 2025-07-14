// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {HashConsensus} from "contracts/0.8.9/oracle/HashConsensus.sol";

// This contract is utilized to align interfaces with contracts
// without requiring modifications to the contract source. This approach
// prevents discrepancies between the repository's contract source and the
// contract source code deployed to a source explorer (e.g., Etherscan).
abstract contract InterfacesMatcher_0_8_9 {
    constructor() {
        IHashConsensus(address(new HashConsensus(0, 0, 0, 0, 0, address(0), address(0))));
    }
}
