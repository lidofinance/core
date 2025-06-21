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
