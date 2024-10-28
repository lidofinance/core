// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract VaultHub__MockForVault {
    function mintStethBackedByVault(address _recipient, uint256 _tokens) external returns (uint256 locked) {}

    function burnStethBackedByVault(uint256 _tokens) external {}

    function rebalance() external payable {}
}
