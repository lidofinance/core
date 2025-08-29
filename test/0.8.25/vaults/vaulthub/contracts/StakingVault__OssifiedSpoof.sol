// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract StakingVault__OssifiedSpoof {
    address public pendingOwner;

    function setPendingOwner(address _pendingOwner) external {
        pendingOwner = _pendingOwner;
    }

    function isOssified() external view returns (bool) {
        return false;
    }
}
