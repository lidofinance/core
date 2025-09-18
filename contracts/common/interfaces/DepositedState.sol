// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.5.0;

struct DepositedState {
    /// tightly packed deposit data ordered from older to newer by slot
    uint256[] slotsDeposits;
    /// Index of next element to read
    uint256 cursor;
}