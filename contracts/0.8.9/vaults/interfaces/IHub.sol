// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import {ILockable} from "./ILockable.sol";

interface IHub {
    function connectVault(ILockable _vault, uint256 _capShares, uint256 _minimumBondShareBP) external;
    function disconnectVault(ILockable _vault, uint256 _index) external;
    function mintSharesBackedByVault(address _receiver, uint256 _amountOfShares) external returns (uint256);
    function burnSharesBackedByVault(uint256 _amountOfShares) external;
    function forgive() external payable;

    event VaultConnected(address indexed vault, uint256 capShares, uint256 minBondRateBP);
    event VaultDisconnected(address indexed vault);
    event MintedSharesOnVault(address indexed vault, uint256 totalSharesMintedOnVault);
    event BurnedSharesOnVault(address indexed vault, uint256 totalSharesMintedOnVault);
    event VaultRebalanced(address indexed vault, uint256 newBondRateBP, uint256 ethExtracted);
}
