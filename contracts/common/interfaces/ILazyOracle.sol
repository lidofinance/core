// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

/**
 * Interface to connect AccountingOracle with LazyOracle and force type consistency
 */
interface ILazyOracle {
    function updateReportData(
        uint256 _timestamp,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataReportCid
    ) external;
}
