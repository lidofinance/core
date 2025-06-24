// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

/**
 * @notice This is a mock of the Dashboard contract.
 */
contract Dashboard__Mock {
    VaultHub.VaultConnection public mock__vaultConnection;
    address public mock_stakingVault;

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

    function mock__setStakingVault(address _stakingVault) external {
        mock_stakingVault = _stakingVault;
    }

    function stakingVault() public view returns (address) {
        return mock_stakingVault;
    }
}
