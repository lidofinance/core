// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract VaultHub__MockForPermissions {
    event MockSharesMinted(
        address indexed sender,
        address indexed stakingVault,
        address indexed recipient,
        uint256 shares
    );
    event MockSharesBurned(address indexed sender, address indexed recipient, uint256 shares);
    event MockVoluntaryDisconnect(address indexed sender, address indexed stakingVault);

    function mintShares(address _stakingVault, address _recipient, uint256 _shares) public {
        emit MockSharesMinted(msg.sender, _stakingVault, _recipient, _shares);
    }

    function burnShares(address _stakingVault, uint256 _shares) public {
        emit MockSharesBurned(msg.sender, _stakingVault, _shares);
    }

    function voluntaryDisconnect(address _stakingVault) public {
        emit MockVoluntaryDisconnect(msg.sender, _stakingVault);
    }
}
