// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import {ILockable} from "./ILockable.sol";

interface IHub {
    function connectVault(
        ILockable _vault,
        uint256 _capShares,
        uint256 _minimumBondShareBP,
        uint256 _treasuryFeeBP) external;

    event VaultConnected(address indexed vault, uint256 capShares, uint256 minBondRateBP, uint256 treasuryFeeBP);
    event VaultDisconnected(address indexed vault);
    event VaultReported(address indexed vault, uint256 value, int256 netCashFlow, uint256 locked);
}
