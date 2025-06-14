// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

contract VaultHub__MockForOperatorGrid {
    mapping(address => VaultHub.VaultConnection) public vaultConnections;
    mapping(address => VaultHub.VaultRecord) public vaultRecords;

    function mock__setVaultConnection(address _vault, VaultHub.VaultConnection calldata _vaultConnection) external {
        vaultConnections[_vault] = _vaultConnection;
    }

    function mock__deleteVaultConnection(address _vault) external {
        delete vaultConnections[_vault];
    }

    function vaultConnection(address _vault) external view returns (VaultHub.VaultConnection memory) {
        return vaultConnections[_vault];
    }

    function mock__setVaultRecord(address vault, VaultHub.VaultRecord memory record) external {
        vaultRecords[vault] = record;
    }

    function vaultRecord(address vault) external view returns (VaultHub.VaultRecord memory) {
        return vaultRecords[vault];
    }

    function isVaultConnected(address _vault) external view returns (bool) {
        return vaultConnections[_vault].vaultIndex != 0;
    }

    function liabilityShares(address _vault) external view returns (uint256) {
        return vaultRecords[_vault].liabilityShares;
    }

    function updateConnection(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) external {
        VaultHub.VaultConnection storage connection = vaultConnections[_vault];
        if (connection.owner == address(0)) revert NotConnectedToHub(_vault);

        connection.shareLimit = uint96(_shareLimit);
        connection.reserveRatioBP = uint16(_reserveRatioBP);
        connection.forcedRebalanceThresholdBP = uint16(_forcedRebalanceThresholdBP);
        connection.infraFeeBP = uint16(_infraFeeBP);
        connection.liquidityFeeBP = uint16(_liquidityFeeBP);
        connection.reservationFeeBP = uint16(_reservationFeeBP);

        emit VaultConnectionUpdated(
            _vault,
            _shareLimit,
            _reserveRatioBP,
            _forcedRebalanceThresholdBP,
            _infraFeeBP,
            _liquidityFeeBP,
            _reservationFeeBP
        );
    }

    event VaultConnectionUpdated(
        address indexed vault,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );

    error NotConnectedToHub(address vault);
}
