// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

contract VaultHub__MockForAccountingReport {
    uint256 public badDebtToInternalizeAsOfLastRefSlot;

    function mock__badDebtToInternalizeAsOfLastRefSlot() external view returns (uint256) {
        return badDebtToInternalizeAsOfLastRefSlot;
    }

    function setBadDebtToInternalizeAsOfLastRefSlot(uint256 _badDebt) external {
        badDebtToInternalizeAsOfLastRefSlot = _badDebt;
    }

    function decreaseInternalizedBadDebt(uint256 _badDebt) external {
        badDebtToInternalizeAsOfLastRefSlot -= _badDebt;
    }
}
