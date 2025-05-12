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
    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;
    uint64 public latestReportDataTimestamp;

    constructor(IStETH _steth, address _lidoLocator) {
        steth = _steth;
        LIDO_LOCATOR = _lidoLocator;
    }

    event VaultConnected(address vault);
    event Mock__VaultDisconnectInitiated(address vault);
    event Mock__Rebalanced(uint256 amount);

    mapping(address => VaultHub.VaultConnection) public vaultConnections;
    mapping(address => VaultHub.VaultRecord) public vaultRecords;

    function mock__setVaultConnection(address vault, VaultHub.VaultConnection memory connection) external {
        vaultConnections[vault] = connection;
    }

    function vaultConnection(address vault) external view returns (VaultHub.VaultConnection memory) {
        return vaultConnections[vault];
    }

    function mock__setVaultRecord(address vault, VaultHub.VaultRecord memory record) external {
        vaultRecords[vault] = record;
    }

    function vaultRecord(address vault) external view returns (VaultHub.VaultRecord memory) {
        return vaultRecords[vault];
    }

    function disconnect(address vault) external {
        emit Mock__VaultDisconnectInitiated(vault);
    }

    function deleteVaultConnection(address vault) external {
        delete vaultConnections[vault];
        delete vaultRecords[vault];
    }

    function connectVault(address vault) external {
        emit VaultConnected(vault);
    }

    function mintShares(address vault, address recipient, uint256 amount) external {
        if (vault == address(0)) revert ZeroArgument("_vault");
        if (recipient == address(0)) revert ZeroArgument("recipient");
        if (amount == 0) revert ZeroArgument("amount");

        steth.mintExternalShares(recipient, amount);
        vaultRecords[vault].liabilityShares += uint96(amount);
    }

    function burnShares(address _vault, uint256 _amountOfShares) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");

        steth.burnExternalShares(_amountOfShares);
        vaultRecords[_vault].liabilityShares -= uint96(_amountOfShares);
    }

    function voluntaryDisconnect(address _vault) external {
        emit Mock__VaultDisconnectInitiated(_vault);
    }

    function rebalance() external payable {
        vaultRecords[msg.sender].liabilityShares = 0;

        emit Mock__Rebalanced(msg.value);
    }

    function updateReportData(uint64 timestamp, bytes32, string calldata) external {
        latestReportDataTimestamp = timestamp;
    }

    function latestReportData() external view returns (uint64 timestamp, bytes32 treeRoot, string memory reportCid) {
        return (latestReportDataTimestamp, bytes32(0), "");
    }

    error ZeroArgument(string argument);
}
