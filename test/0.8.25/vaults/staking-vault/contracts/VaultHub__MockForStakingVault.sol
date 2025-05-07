// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

contract VaultHub__MockForStakingVault {
    address public immutable LIDO_LOCATOR;
    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;
    uint64 public latestReportDataTimestamp;

    mapping(address => VaultHub.VaultSocket) public sockets;

    constructor(address _lidoLocator) {
        LIDO_LOCATOR = _lidoLocator;
    }

    event Mock__Rebalanced(address indexed vault, uint256 amount);

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.sender, msg.value);
    }

    function addVaultSocket(address vault) external {
        sockets[vault] = VaultHub.VaultSocket({
            vault: vault,
            liabilityShares: 0,
            shareLimit: 0,
            reserveRatioBP: 0,
            forcedRebalanceThresholdBP: 0,
            treasuryFeeBP: 0,
            pendingDisconnect: false,
            feeSharesCharged: 0
        });
    }

    function vaultSocket(address vault) external view returns (VaultHub.VaultSocket memory) {
        return sockets[vault];
    }

    function updateReportData(uint64 timestamp, bytes32, string calldata) external {
        latestReportDataTimestamp = timestamp;
    }

    function latestReportData() external view returns (uint64 timestamp, bytes32 treeRoot, string memory reportCid) {
        return (latestReportDataTimestamp, bytes32(0), "");
    }
}
