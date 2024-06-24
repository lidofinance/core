// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import {Basic} from "./Basic.sol";
import {Connected} from "./Connected.sol";

interface Liquid is Connected, Basic {
    function mintStETH(address _receiver, uint256 _amountOfShares) external;
    function burnStETH(address _from, uint256 _amountOfShares) external;
    function shrink(uint256 _amountOfETH) external;
}
