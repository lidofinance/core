// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IDashboard} from "contracts/0.8.25/vaults/ValidatorConsolidationRequests.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

/**
 * @notice This is a mock of the Dashboard contract.
 */
contract Dashboard__Mock is IDashboard {
    VaultHub.VaultConnection public mock__vaultConnection;

    event RewardsAdjustmentIncreased(uint256 _amount);

    function increaseRewardsAdjustment(uint256 _amount) external {
        emit RewardsAdjustmentIncreased(_amount);
    }

    function vaultConnection() public view returns (VaultHub.VaultConnection memory) {
        return mock__vaultConnection;
    }

    function mock__setVaultConnection(VaultHub.VaultConnection memory _vaultConnection) external {
        mock__vaultConnection = _vaultConnection;
    }
}
