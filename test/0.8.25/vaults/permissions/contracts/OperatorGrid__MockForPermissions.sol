// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

contract OperatorGrid__MockForPermissions {
    event Mock__TierChanged(address indexed _vault, uint256 _tierId, uint256 _requestedShareLimit);

    function changeTier(address _vault, uint256 _tierId, uint256 _requestedShareLimit) external returns (bool) {
        emit Mock__TierChanged(_vault, _tierId, _requestedShareLimit);
        return true;
    }
}
