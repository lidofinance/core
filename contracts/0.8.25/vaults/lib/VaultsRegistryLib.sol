// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "../VaultHub.sol";

library VaultsRegistryLib {
    function init(VaultHub.VaultsRegistry storage _self) internal {
        _self.vaults.push(address(0));
    }

    function size(VaultHub.VaultsRegistry storage _self) internal view returns (uint256) {
        return _self.vaults.length - 1;
    }

    function at(VaultHub.VaultsRegistry storage _self, uint256 _index) internal view returns (address) {
        if (_index == 0) revert ZeroIndex();
        return _self.vaults[_index];
    }

    function indexOf(VaultHub.VaultsRegistry storage _self, address _vault) internal view returns (uint256) {
        return con(_self, _vault).vaultIndex;
    }

    function con(
        VaultHub.VaultsRegistry storage _self,
        address _vault
    ) internal view returns (VaultHub.VaultConnection storage) {
        if (_vault == address(0)) revert VaultZeroAddress();

        VaultHub.VaultConnection storage connection = _self.connections[_vault];

        if (connection.vaultIndex == 0) revert NotConnectedToHub(_vault);
        if (connection.pendingDisconnect) revert VaultIsDisconnecting(_vault);

        return connection;
    }

    function rec(
        VaultHub.VaultsRegistry storage _self,
        address _vault
    ) internal view returns (VaultHub.VaultRecord storage) {
        return _self.records[_vault];
    }

    function add(
        VaultHub.VaultsRegistry storage _self,
        address _vault,
        VaultHub.VaultConnection memory _connection,
        VaultHub.VaultRecord memory _record
    ) internal {
        uint256 vaultIndex = _self.vaults.length;
        _self.vaults.push(_vault);

        _connection.vaultIndex = uint96(vaultIndex);

        _self.connections[_vault] = _connection;
        _self.records[_vault] = _record;
    }

    function remove(
        VaultHub.VaultsRegistry storage _self,
        address _vault,
        VaultHub.VaultConnection storage _connection
    ) internal {
        uint96 vaultIndex = _connection.vaultIndex;

        address lastVault = _self.vaults[_self.vaults.length - 1];
        _self.connections[lastVault].vaultIndex = vaultIndex;
        _self.vaults[vaultIndex] = lastVault;
        _self.vaults.pop();

        delete _self.connections[_vault];
        delete _self.records[_vault];
    }

    error VaultZeroAddress();
    error NotConnectedToHub(address vault);
    error VaultIsDisconnecting(address vault);
    error ZeroIndex();
}
