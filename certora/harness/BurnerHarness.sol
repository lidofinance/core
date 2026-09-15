// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { Burner } from "contracts/0.8.9/Burner.sol";

contract BurnerHarness is Burner {
    constructor(address _locator, address _stETH) Burner(_locator, _stETH) {
    }

    
    function getExcessStETHShares() external view returns (uint256) {
        return _getExcessStETHShares();
    }
}
