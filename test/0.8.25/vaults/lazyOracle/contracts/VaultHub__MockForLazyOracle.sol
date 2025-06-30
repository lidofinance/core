// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {RefSlotCache} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";
import "hardhat/console.sol";

contract VaultHub__MockForLazyOracle {
    using RefSlotCache for RefSlotCache.Int112WithRefSlotCache;

    address[] public mock__vaults;
    mapping(address vault => VaultHub.VaultConnection connection) public mock__vaultConnections;
    mapping(address vault => VaultHub.VaultRecord record) public mock__vaultRecords;

    address public mock__lastReportedVault;
    uint256 public mock__lastReported_timestamp;
    uint256 public mock__lastReported_totalValue;
    int256 public mock__lastReported_inOutDelta;
    uint256 public mock__lastReported_cumulativeLidoFees;
    uint256 public mock__lastReported_liabilityShares;
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
        return mock__vaultRecords[vault].inOutDelta.value;
    }

    function vaultConnection(address vault) external view returns (VaultHub.VaultConnection memory) {
        return mock__vaultConnections[vault];
        // console.log("vaultConnection", vault);
        // VaultHub.VaultConnection memory connection = VaultHub.VaultConnection({
        //     owner: address(1),
        //     shareLimit: 1000000000000000000,
        //     vaultIndex: 1,
        //     pendingDisconnect: false,
        //     reserveRatioBP: 10000,
        //     forcedRebalanceThresholdBP: 10000,
        //     infraFeeBP: 10000,
        //     liquidityFeeBP: 10000,
        //     reservationFeeBP: 10000,
        //     isBeaconDepositsManuallyPaused: false
        // });
        // return connection;
    }

    function maxLockableValue(address vault) external view returns (uint256) {
        return 1000000000000000000;
    }

    function vaultRecord(address vault) external view returns (VaultHub.VaultRecord memory) {
        return mock__vaultRecords[vault];
    }

    function applyVaultReport(
        address _vault,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportSlashingReserve
    ) external {
        mock__lastReportedVault = _vault;
        mock__lastReported_timestamp = _reportTimestamp;
        mock__lastReported_totalValue = _reportTotalValue;
        mock__lastReported_inOutDelta = _reportInOutDelta;
        mock__lastReported_cumulativeLidoFees = _reportCumulativeLidoFees;
        mock__lastReported_liabilityShares = _reportLiabilityShares;
        mock__lastReported_slashingReserve = _reportSlashingReserve;

        mock__vaultRecords[_vault].report.inOutDelta = int112(_reportInOutDelta);
        mock__vaultRecords[_vault].inOutDelta.value = int112(_reportInOutDelta);
        mock__vaultRecords[_vault].inOutDelta.valueOnRefSlot = int112(_reportInOutDelta);
        mock__vaultRecords[_vault].inOutDelta.refSlot = uint32(_reportTimestamp);
        mock__vaultRecords[_vault].report.timestamp = uint32(_reportTimestamp);
        mock__vaultRecords[_vault].report.totalValue = uint112(_reportTotalValue);
    }

    // function vaultRecord(address vault) external view returns (VaultHub.VaultRecord memory) {
    //     VaultHub.VaultRecord memory record = VaultHub.VaultRecord({
    //         report: VaultHub.Report({totalValue: uint112(1), inOutDelta: int112(int256(2)), timestamp: uint32(3)}),
    //         locked: uint128(4),
    //         liabilityShares: 5,
    //         inOutDelta: RefSlotCache.Int112WithRefSlotCache({value: int112(int256(6)), valueOnRefSlot: 7, refSlot: 8})
    //     });

    //     return record;
    // }
}
