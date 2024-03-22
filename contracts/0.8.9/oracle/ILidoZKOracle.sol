// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

interface ILidoZKOracle {
    function getReport(uint256 refSlot) external view returns  (
        bool success,
        uint256 clBalanceGwei,
        uint256 numValidators,
        uint256 exitedValidators
	);
}

