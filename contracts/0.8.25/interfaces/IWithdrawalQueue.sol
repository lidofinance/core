// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface IWithdrawalQueue {
    function prefinalize(
        uint256[] memory _batches,
        uint256 _maxShareRate
    ) external view returns (uint256 ethToLock, uint256 sharesToBurn);

    function isPaused() external view returns (bool);
}
