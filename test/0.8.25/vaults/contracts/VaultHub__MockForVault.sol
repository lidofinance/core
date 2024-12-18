// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract VaultHub__MockForVault {
    function mintSharesBackedByVault(address _recipient, uint256 _amountOfShares) external returns (uint256 locked) {}

    function burnSharesBackedByVault(uint256 _amountOfShares) external {}

    function rebalance() external payable {}
}
