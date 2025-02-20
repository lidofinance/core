// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

interface ISideloader {
    function onSideload(
        address _vault,
        address _sideloader,
        uint256 _amountOfShares,
        bytes calldata _data
    ) external returns (bytes32);
}
