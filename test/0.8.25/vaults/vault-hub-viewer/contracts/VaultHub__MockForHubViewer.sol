// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract IStETH {
    function mintExternalShares(address _receiver, uint256 _amountOfShares) external {}

    function burnExternalShares(uint256 _amountOfShares) external {}
}

contract VaultHub__MockForHubViewer {
    uint256 internal constant BPS_BASE = 100_00;
    IStETH public immutable steth;
    // keccak256(abi.encode(uint256(keccak256("VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_HUB_STORAGE_LOCATION =
        0xb158a1a9015c52036ff69e7937a7bb424e82a8c4cbec5c5309994af06d825300;

    constructor(IStETH _steth) {
        steth = _steth;
    }

    event Mock__VaultDisconnected(address vault);
    event Mock__Rebalanced(uint256 amount);

    mapping(address => VaultHub.VaultSocket) public vaultSockets;

    function mock__setVaultSocket(address vault, VaultHub.VaultSocket memory socket) external {
        vaultSockets[vault] = socket;
    }

    function mock_vaultLock(address vault, uint256 amount) external {
        IStakingVault(vault).lock(amount);
    }

    function vaultSocket(address vault) external view returns (VaultHub.VaultSocket memory) {
        return vaultSockets[vault];
    }

    function vaultSocketIndex(address vault) public view returns (uint256) {
        return _getVaultHubStorage().vaultIndex[vault];
    }

    function vaultsCount() public view returns (uint256) {
        return _getVaultHubStorage().sockets.length;
    }

    function vault(uint256 _index) public view returns (address) {
        return _getVaultHubStorage().sockets[_index].vault;
    }

    function mock_vaultSocket() public view returns (VaultHub.VaultSocket[] memory) {
        return _getVaultHubStorage().sockets;
    }

    function disconnectVault(address vault) external {
        emit Mock__VaultDisconnected(vault);
    }

    function mintSharesBackedByVault(address /* vault */, address recipient, uint256 amount) external {
        steth.mintExternalShares(recipient, amount);
    }

    function burnSharesBackedByVault(address /* vault */, uint256 amount) external {
        steth.burnExternalShares(amount);
    }

    function voluntaryDisconnect(address _vault) external {
        emit Mock__VaultDisconnected(_vault);
    }

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.value);
    }

    function mock_connectVault(address _vault) external {
        VaultHub.VaultHubStorage storage $ = _getVaultHubStorage();

        VaultHub.VaultSocket memory vr = VaultHub.VaultSocket(
            _vault,
            0, // sharesMinted
            uint96(0),
            uint16(0),
            uint16(0),
            uint16(0),
            false // isDisconnected
        );

        $.vaultIndex[_vault] = $.sockets.length;
        $.sockets.push(vr);
    }

    function _getVaultHubStorage() private pure returns (VaultHub.VaultHubStorage storage $) {
        assembly {
            $.slot := VAULT_HUB_STORAGE_LOCATION
        }
    }
}
