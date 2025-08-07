// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// NB: for testing purposes only
pragma solidity 0.8.9;

interface ISecondOpinionOracle {
    function getReport(
        uint256 refSlot
    )
        external
        view
        returns (
            bool success,
            uint256 clBalanceGwei,
            uint256 withdrawalVaultBalanceWei,
            uint256 numValidators,
            uint256 exitedValidators
        );
}

contract SecondOpinionOracle__Mock is ISecondOpinionOracle {
    struct Report {
        bool success;
        uint256 clBalanceGwei;
        uint256 withdrawalVaultBalanceWei;
        uint256 numValidators;
        uint256 exitedValidators;
    }

    mapping(uint256 => Report) public reports;

    function addReport(uint256 refSlot, Report memory report) external {
        reports[refSlot] = report;
    }

    function addPlainReport(uint256 refSlot, uint256 clBalanceGwei, uint256 withdrawalVaultBalanceWei) external {
        reports[refSlot] = Report({
            success: true,
            clBalanceGwei: clBalanceGwei,
            withdrawalVaultBalanceWei: withdrawalVaultBalanceWei,
            numValidators: 0,
            exitedValidators: 0
        });
    }

    function removeReport(uint256 refSlot) external {
        delete reports[refSlot];
    }

    function getReport(
        uint256 refSlot
    )
        external
        view
        override
        returns (
            bool success,
            uint256 clBalanceGwei,
            uint256 withdrawalVaultBalanceWei,
            uint256 numValidators,
            uint256 exitedValidators
        )
    {
        Report memory report = reports[refSlot];
        return (
            report.success,
            report.clBalanceGwei,
            report.withdrawalVaultBalanceWei,
            report.numValidators,
            report.exitedValidators
        );
    }
}
