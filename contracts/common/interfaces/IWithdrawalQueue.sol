// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

interface IWithdrawalQueue {
    function prefinalize(
        uint256[] memory _batches,
        uint256 _maxShareRate
    ) external view returns (uint256 ethToLock, uint256 sharesToBurn);

    function isPaused() external view returns (bool);
}
