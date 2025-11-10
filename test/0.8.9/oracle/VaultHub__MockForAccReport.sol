// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {IVaultHub} from "contracts/common/interfaces/IVaultHub.sol";

contract VaultHub__MockForAccountingReport is IVaultHub {
    uint256 private badDebtToInternalize_;

    function mock__badDebtToInternalize() external view returns (uint256) {
        return badDebtToInternalize_;
    }

    function setBadDebtToInternalize(uint256 _badDebt) external {
        badDebtToInternalize_ = _badDebt;
    }

    function decreaseInternalizedBadDebt(uint256 _badDebt) external {
        badDebtToInternalize_ -= _badDebt;
    }

    function badDebtToInternalize() external view override returns (uint256) {
        return badDebtToInternalize_;
    }

    function badDebtToInternalizeForLastRefSlot() external view override returns (uint256) {
        return badDebtToInternalize_;
    }
}
