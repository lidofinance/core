// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.4.24;

contract LidoExecutionLayerRewardsVault__MockForLidoAccounting {
  event Mock__RewardsWithdrawn();

  function withdrawRewards(uint256 _maxAmount) external returns (uint256 amount) {
    // emiting mock event to test that the function was in fact called
    emit Mock__RewardsWithdrawn();
    return _maxAmount;
  }
}
