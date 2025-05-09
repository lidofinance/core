// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IVaultControl} from "contracts/0.8.25/vaults/interfaces/IVaultControl.sol";

contract VaultHub__MockForStakingVault {
    address public immutable LIDO_LOCATOR;
    uint256 public constant REPORT_FRESHNESS_DELTA = 1 days;

    mapping(address => VaultHub.VaultSocket) public sockets;

    constructor(address _lidoLocator) {
        LIDO_LOCATOR = _lidoLocator;
    }

    event Mock__Rebalanced(address indexed vault, uint256 amount);

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.sender, msg.value);
    }

    function addVaultSocket(address vault) external {
        sockets[vault] = IVaultControl.VaultSocket({
            vault: vault,
            shareLimit: 0,
            owner: address(0),
            liabilityShares: 0,
            locked: 0,
            inOutDelta: 0,
            report: IVaultControl.Report(0, 0),
            reportTimestamp: 0,
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
}
