// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

contract VaultHub__MockForAccountingReport {
    uint256 public badDebtToInternalize;

    function mock__badDebtToInternalize() external view returns (uint256) {
        return badDebtToInternalize;
    }

    function setBadDebtToInternalize(uint256 _badDebt) external {
        badDebtToInternalize = _badDebt;
    }

    function decreaseInternalizedBadDebt(uint256 _badDebt) external {
        badDebtToInternalize -= _badDebt;
    }
}
