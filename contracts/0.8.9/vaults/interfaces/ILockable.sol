// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

interface ILockable {
    function lastReport() external view returns (
        uint128 value,
        int128 netCashFlow
    );
    function value() external view returns (uint256);
    function locked() external view returns (uint256);
    function netCashFlow() external view returns (int256);

    function update(uint256 value, int256 ncf, uint256 locked) external;
    function rebalance(uint256 amountOfETH) external;
}
