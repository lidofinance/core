// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import { VaultHub } from "contracts/0.8.25/vaults/VaultHub.sol";
import { StETH__MockForDashboard } from "./StETH__MockForDashboard.sol";

contract VaultHub__MockForDashboard {
    StETH__MockForDashboard public immutable steth;

    constructor(StETH__MockForDashboard _steth) {
        steth = _steth;
    }

    event Mock__VaultDisconnected(address vault);
    event Mock__Rebalanced(uint256 amount);

    mapping(address => VaultHub.VaultSocket) public vaultSockets;

    function mock__setVaultSocket(address vault, VaultHub.VaultSocket memory socket) external {
        vaultSockets[vault] = socket;
    }

    function vaultSocket(address vault) external view returns (VaultHub.VaultSocket memory) {
        return vaultSockets[vault];
    }

    function disconnectVault(address vault) external {
        emit Mock__VaultDisconnected(vault);
    }

    // solhint-disable-next-line no-unused-vars
    function mintSharesBackedByVault(address vault, address recipient, uint256 amount) external {
        steth.mint(recipient, amount);
    }

    // solhint-disable-next-line no-unused-vars
    function burnSharesBackedByVault(address vault, uint256 amount) external {
        steth.burn(amount);
    }

    function voluntaryDisconnect(address _vault) external {
        emit Mock__VaultDisconnected(_vault);
    }

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.value);
    }
}

