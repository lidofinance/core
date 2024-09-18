// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

interface ILiquid {
    function mint(address _receiver, uint256 _amountOfShares) external;
    function burn(uint256 _amountOfShares) external;
}
