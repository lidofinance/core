// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

interface Connected {
    function BOND_BP() external view returns (uint256);

    function lastReport() external view returns (
        uint96 clBalance,
        uint96 elBalance,
        uint96 netCashFlow
    );
    function locked() external view returns (uint256);
    function netCashFlow() external view returns (int256);

    function getValue() external view returns (uint256);

    function update(uint256 cl, uint256 el, uint256 ncf, uint256 locked) external;
}
