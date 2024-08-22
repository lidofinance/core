// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import {IStaking} from "./IStaking.sol";
import {IConnected} from "./IConnected.sol";

interface ILiquid is IConnected, IStaking {
    function mintStETH(address _receiver, uint256 _amountOfShares) external;
    function burnStETH(address _from, uint256 _amountOfShares) external;
    function shrink(uint256 _amountOfETH) external;
}
