// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";

contract VaultHub__MockForLazyOracle {
    using DoubleRefSlotCache for DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH];

    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;

    address[] public mock__vaults;
    mapping(address vault => VaultHub.VaultConnection connection) public mock__vaultConnections;
    mapping(address vault => VaultHub.VaultRecord record) public mock__vaultRecords;

    address public mock__lastReportedVault;
    uint256 public mock__lastReported_timestamp;
    uint256 public mock__lastReported_totalValue;
    int256 public mock__lastReported_inOutDelta;
    uint256 public mock__lastReported_cumulativeLidoFees;
    uint256 public mock__lastReported_liabilityShares;
    uint256 public mock__lastReported_maxLiabilityShares;
    uint256 public mock__lastReported_slashingReserve;

    constructor() {
        mock__vaults.push(address(0));
    }

    function mock__addVault(address vault) external {
        mock__vaults.push(vault);
    }

    function mock__setVaultConnection(address vault, VaultHub.VaultConnection memory connection) external {
        mock__vaultConnections[vault] = connection;
    }

    function mock__setVaultRecord(address vault, VaultHub.VaultRecord memory record) external {
        mock__vaultRecords[vault] = record;
    }

    function vaultsCount() external view returns (uint256) {
        return mock__vaults.length - 1;
    }

    function vaultByIndex(uint256 index) external view returns (address) {
        return mock__vaults[index];
    }

    function inOutDeltaAsOfLastRefSlot(address vault) external view returns (int256) {
        return mock__vaultRecords[vault].inOutDelta.currentValue();
    }

    function vaultConnection(address vault) external view returns (VaultHub.VaultConnection memory) {
        return mock__vaultConnections[vault];
    }

    function maxLockableValue(address) external pure returns (uint256) {
        return 1000000000000000000;
    }

    function vaultRecord(address vault) external view returns (VaultHub.VaultRecord memory) {
        return mock__vaultRecords[vault];
    }

    function isReportFresh(address) external pure returns (bool) {
        return false;
    }

    function isPendingDisconnect(address) external pure returns (bool) {
        return false;
    }

    function applyVaultReport(
        address _vault,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportMaxLiabilityShares,
        uint256 _reportSlashingReserve
    ) external {
        mock__lastReportedVault = _vault;
        mock__lastReported_timestamp = _reportTimestamp;
        mock__lastReported_totalValue = _reportTotalValue;
        mock__lastReported_inOutDelta = _reportInOutDelta;
        mock__lastReported_cumulativeLidoFees = _reportCumulativeLidoFees;
        mock__lastReported_maxLiabilityShares = _reportMaxLiabilityShares;
        mock__lastReported_liabilityShares = _reportLiabilityShares;
        mock__lastReported_slashingReserve = _reportSlashingReserve;

        mock__vaultRecords[_vault].report.inOutDelta = int104(_reportInOutDelta);
        mock__vaultRecords[_vault].report.timestamp = uint48(_reportTimestamp);
        mock__vaultRecords[_vault].report.totalValue = uint104(_reportTotalValue);
    }
}
