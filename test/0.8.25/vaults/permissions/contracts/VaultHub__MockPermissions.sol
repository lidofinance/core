// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

contract VaultHub__MockPermissions {
    event Mock__SharesMinted(address indexed _stakingVault, address indexed _recipient, uint256 _shares);
    event Mock__SharesBurned(address indexed _stakingVault, uint256 _shares);
    event Mock__Rebalanced(uint256 _ether);
    event Mock__VoluntaryDisconnect(address indexed _stakingVault);

    function mintShares(address _stakingVault, address _recipient, uint256 _shares) external {
        emit Mock__SharesMinted(_stakingVault, _recipient, _shares);
    }

    function burnShares(address _stakingVault, uint256 _shares) external {
        emit Mock__SharesBurned(_stakingVault, _shares);
    }

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.value);
    }

    function queueSelfDisconnect(address _stakingVault) external {
        emit Mock__VoluntaryDisconnect(_stakingVault);
    }
}
