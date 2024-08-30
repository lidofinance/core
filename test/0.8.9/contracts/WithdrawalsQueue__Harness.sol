// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {WithdrawalQueue, IWstETH} from "contracts/0.8.9/WithdrawalQueue.sol";

contract WithdrawalsQueue__Harness is WithdrawalQueue {
    event Mock__Transfer(address indexed from, address indexed to, uint256 requestId);

    constructor(address _wstETH) WithdrawalQueue(IWstETH(_wstETH)) {}

    function harness__enqueue(
        uint128 _amountOfStETH,
        uint128 _amountOfShares,
        address _owner
    ) external returns (uint256 requestId) {
        return _enqueue(_amountOfStETH, _amountOfShares, _owner);
    }

    function harness__claim(uint256 _requestId, uint256 _hint, address _recipient) external {
        return _claim(_requestId, _hint, _recipient);
    }

    function harness__getClaimableEther(uint256 _requestId, uint256 _hint) external view returns (uint256) {
        return _getClaimableEther(_requestId, _hint);
    }

    function harness__finalize(uint256 _lastRequestIdToBeFinalized, uint256 _maxShareRate) external payable {
        _finalize(_lastRequestIdToBeFinalized, msg.value, _maxShareRate);
    }

    // Implementing the virtual function from WithdrawalQueue
    function _emitTransfer(address _from, address _to, uint256 _requestId) internal override {
        emit Mock__Transfer(_from, _to, _requestId);
    }
}
