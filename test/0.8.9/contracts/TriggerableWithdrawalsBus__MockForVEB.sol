// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {WithdrawalIntent} from "contracts/common/interfaces/WithdrawalIntent.sol";

/// @notice Records the withdrawal intents passed by the VEBO, in the order they were passed
contract TriggerableWithdrawalsBus__MockForVEB {
    WithdrawalIntent[] internal _intents;
    uint256 public addWithdrawalIntentsCalls;
    uint256 public receivedIntentsCount;
    bool public revertOnAdd;
    /// @dev Storing intents from zero slots is expensive, so large reports can switch it off
    bool public storeIntents = true;

    function setRevertOnAdd(bool _revert) external {
        revertOnAdd = _revert;
    }

    function setStoreIntents(bool _store) external {
        storeIntents = _store;
    }

    function addWithdrawalIntents(WithdrawalIntent[] calldata intents) external {
        require(!revertOnAdd, "TWB mock: revert");
        ++addWithdrawalIntentsCalls;
        receivedIntentsCount += intents.length;
        if (!storeIntents) return;
        for (uint256 i = 0; i < intents.length; ++i) {
            WithdrawalIntent storage intent = _intents.push();
            intent.amount = intents[i].amount;
            intent.pubkey = intents[i].pubkey;
        }
    }

    function getWithdrawalIntents() external view returns (WithdrawalIntent[] memory) {
        return _intents;
    }
}
