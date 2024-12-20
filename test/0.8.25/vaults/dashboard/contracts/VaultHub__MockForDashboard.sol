// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract IStETH {
    function mintExternalShares(address _receiver, uint256 _amountOfShares) external {}

    function burnExternalShares(uint256 _amountOfShares) external {}
}

contract VaultHub__MockForDashboard {
    uint256 internal constant BPS_BASE = 100_00;
    IStETH public immutable steth;

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
}
