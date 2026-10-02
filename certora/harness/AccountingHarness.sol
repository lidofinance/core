// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { Accounting } from "contracts/0.8.9/Accounting.sol";
import { ILidoLocator } from "contracts/common/interfaces/ILidoLocator.sol";
import { ILido } from "contracts/common/interfaces/ILido.sol";
import { ReportValues } from "contracts/common/interfaces/ReportValues.sol";

contract AccountingHarness is Accounting {
    constructor(
        ILidoLocator _lidoLocator,
        ILido _lido
    ) Accounting(_lidoLocator, _lido) {}

    function treasury() external returns (address) {
        return LIDO_LOCATOR.treasury();
    }

    function calculateTotalProtocolFeeShares(
        ReportValues calldata _report,
        CalculatedValues memory _update,
        uint256 _internalSharesBeforeFees,
        uint256 _totalFee,
        uint256 _feePrecisionPoints
    ) external pure returns (uint256 sharesToMintAsFees) {
        return _calculateTotalProtocolFeeShares(
            _report, _update, _internalSharesBeforeFees, _totalFee, _feePrecisionPoints
        );
    }
}
