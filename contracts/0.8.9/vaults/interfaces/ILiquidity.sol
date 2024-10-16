// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;


interface ILiquidity {
    function mintStethBackedByVault(address _receiver, uint256 _amountOfTokens) external returns (uint256 totalEtherToLock);
    function burnStethBackedByVault(address _holder, uint256 _amountOfTokens) external;
    function rebalance() external payable;

    event MintedStETHOnVault(address indexed vault, uint256 amountOfTokens);
    event BurnedStETHOnVault(address indexed vault, uint256 amountOfTokens);
    event VaultRebalanced(address indexed vault, uint256 tokensBurnt, uint256 newBondRateBP);
}
