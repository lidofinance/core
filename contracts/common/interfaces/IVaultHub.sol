// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24 <0.9.0;


interface IVaultHub {
    function badDebtToInternalizeAsOfLastRefSlot() external view returns (uint256);

    function decreaseInternalizedBadDebt(uint256 _amountOfShares) external;
}
