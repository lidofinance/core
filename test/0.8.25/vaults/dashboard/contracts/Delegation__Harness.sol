// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {NodeOperatorFee} from "contracts/0.8.25/vaults/dashboard/NodeOperatorFee.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

contract NodeOperatorFee__Harness is NodeOperatorFee {
    address public stakingVaultAddress;

    constructor(address _stakingVault) {
        stakingVaultAddress = _stakingVault;
    }

    function initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) public {
        super._initialize(_defaultAdmin, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);
    }

    function stakingVault() public view override returns (IStakingVault) {
        return IStakingVault(stakingVaultAddress);
    }

    function vaultHub() public view override returns (VaultHub) {
        return VaultHub(stakingVault().vaultHub());
    }
}
