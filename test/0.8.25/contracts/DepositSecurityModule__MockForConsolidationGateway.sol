// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

contract DepositSecurityModule__MockForConsolidationGateway {
    bool public isDepositsPaused;

    function mock__setDepositsPaused(bool _paused) external {
        isDepositsPaused = _paused;
    }
}
