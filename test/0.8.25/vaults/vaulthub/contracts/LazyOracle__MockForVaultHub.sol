// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

import "hardhat/console.sol";

contract LazyOracle__MockForVaultHub {
    uint256 public latestReportTimestamp;

    mapping(address vault => bool isQuarantined) public isVaultQuarantined;

    function mock__setIsVaultQuarantined(address _vault, bool _isQuarantined) external {
        isVaultQuarantined[_vault] = _isQuarantined;
    }

    function removeVaultQuarantine(address _vault) external {
        delete isVaultQuarantined[_vault];
    }

    function setLatestReportTimestamp(uint256 _timestamp) external {
        latestReportTimestamp = _timestamp;
    }

    function refreshReportTimestamp() external {
        latestReportTimestamp = block.timestamp;
    }

    function mock__report(
        VaultHub _vaultHub,
        address _vault,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportMaxLiabilityShares,
        uint256 _reportSlashingReserve
    ) external {
        _vaultHub.applyVaultReport(
            _vault,
            _reportTimestamp,
            _reportTotalValue,
            _reportInOutDelta,
            _reportCumulativeLidoFees,
            _reportLiabilityShares,
            _reportMaxLiabilityShares,
            _reportSlashingReserve
        );
    }
}
