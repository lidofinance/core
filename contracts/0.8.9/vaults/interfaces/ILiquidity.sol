// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;


interface ILiquidity {
    function mintSharesBackedByVault(address _receiver, uint256 _amountOfShares) external returns (uint256);
    function burnSharesBackedByVault(uint256 _amountOfShares) external;
    function rebalance() external payable;

    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurnt, uint256 newBondRateBP);
}
