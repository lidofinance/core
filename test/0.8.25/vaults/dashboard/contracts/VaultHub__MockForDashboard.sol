// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {StakingVaultDeposit} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract IStETH {
    function mintExternalShares(address _receiver, uint256 _amountOfShares) external {}

    function burnExternalShares(uint256 _amountOfShares) external {}
}

contract VaultHub__MockForDashboard {
    uint256 internal constant BPS_BASE = 100_00;
    IStETH public immutable steth;
    address public immutable LIDO_LOCATOR;
    uint256 public constant CONNECT_DEPOSIT = 1 ether;
    uint256 public constant REPORT_FRESHNESS_DELTA = 1 days;

    constructor(IStETH _steth, address _lidoLocator) {
        steth = _steth;
        LIDO_LOCATOR = _lidoLocator;
    }

    event VaultConnected(address vault);
    event Mock__VaultDisconnected(address vault);
    event Mock__Rebalanced(uint256 amount);

    mapping(address => VaultHub.VaultSocket) public vaultSockets;

    function mock__setVaultSocket(address vault, VaultHub.VaultSocket memory socket) external {
        vaultSockets[vault] = socket;
    }

    function vaultSocket(address vault) external view returns (VaultHub.VaultSocket memory) {
        return vaultSockets[vault];
    }

    function disconnect(address vault) external {
        emit Mock__VaultDisconnected(vault);
    }

    function deleteVaultSocket(address vault) external {
        delete vaultSockets[vault];
    }

    function connectVault(address vault) external {
        emit VaultConnected(vault);
    }

    function mintShares(address vault, address recipient, uint256 amount) external {
        if (vault == address(0)) revert ZeroArgument("_vault");
        if (recipient == address(0)) revert ZeroArgument("recipient");
        if (amount == 0) revert ZeroArgument("amount");

        steth.mintExternalShares(recipient, amount);
        vaultSockets[vault].liabilityShares = uint96(vaultSockets[vault].liabilityShares + amount);
    }

    function burnShares(address _vault, uint256 _amountOfShares) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");
        steth.burnExternalShares(_amountOfShares);
        vaultSockets[_vault].liabilityShares = uint96(vaultSockets[_vault].liabilityShares - _amountOfShares);
    }

    function voluntaryDisconnect(address _vault) external {
        emit Mock__VaultDisconnected(_vault);
    }

    function rebalance() external payable {
        vaultSockets[msg.sender].liabilityShares = 0;

        emit Mock__Rebalanced(msg.value);
    }

    error ZeroArgument(string argument);
}
