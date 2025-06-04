// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

contract OperatorGrid__MockForPermissions {
    event Mock__TierChangeRequested(address indexed _vault, uint256 _tierId, uint256 _requestedShareLimit);

    function requestTierChange(address _vault, uint256 _tierId, uint256 _requestedShareLimit) external {
        emit Mock__TierChangeRequested(_vault, _tierId, _requestedShareLimit);
    }
}
