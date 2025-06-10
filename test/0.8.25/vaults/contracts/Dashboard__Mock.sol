// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {INodeOperatorFee} from "contracts/0.8.25/vaults/ValidatorConsolidationRequests.sol";

/**
 * @notice This is a mock of the Dashboard contract.
 */
contract Dashboard__Mock is INodeOperatorFee {
    event RewardsAdjustmentIncreased(uint256 _amount);

    function increaseRewardsAdjustment(uint256 _amount) external {
        emit RewardsAdjustmentIncreased(_amount);
    }
}
