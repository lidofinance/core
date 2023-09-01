// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccountingOracle, ILido} from "../oracle/AccountingOracle.sol";


contract AccountingOracleMock {
    address public immutable LIDO;
    uint256 public immutable SECONDS_PER_SLOT;

    uint256 internal _lastRefSlot;

    constructor(address lido, uint256 secondsPerSlot) {
        LIDO = lido;
        SECONDS_PER_SLOT = secondsPerSlot;
    }

    function submitReportData(
        AccountingOracle.ReportData calldata data,
        uint256 /* contractVersion */
    ) external {
        uint256 slotsElapsed = data.refSlot - _lastRefSlot;
        _lastRefSlot = data.refSlot;

        ILido(LIDO).handleOracleReport(
            data.refSlot * SECONDS_PER_SLOT,
            slotsElapsed * SECONDS_PER_SLOT,
            data.numValidators,
            data.clBalanceGwei * 1e9,
            data.withdrawalVaultBalance,
            data.elRewardsVaultBalance,
            data.sharesRequestedToBurn,
            data.withdrawalFinalizationBatches,
            data.simulatedShareRate
        );
    }

    function getLastProcessingRefSlot() external view returns (uint256) {
        return _lastRefSlot;
    }
}
