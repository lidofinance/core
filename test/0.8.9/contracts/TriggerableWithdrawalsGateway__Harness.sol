pragma solidity 0.8.9;

import {TriggerableWithdrawalsGateway} from "contracts/0.8.9/TriggerableWithdrawalsGateway.sol";

contract TriggerableWithdrawalsGateway__Harness is TriggerableWithdrawalsGateway {
    uint256 internal _time = 2513040315;

    constructor(
        address admin,
        address lidoLocator,
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) TriggerableWithdrawalsGateway(admin, lidoLocator, maxExitRequestsLimit, exitsPerFrame, frameDurationInSec) {}

    function getTimestamp() external view returns (uint256) {
        return _time;
    }

    function _getTimestamp() internal view override returns (uint256) {
        return _time;
    }

    function advanceTimeBy(uint256 timeAdvance) external {
        _time += timeAdvance;
    }

    // Wrap internal functions for testing
    function refundFee(uint256 fee, address recipient) external payable {
        uint256 refund = _checkFee(fee);
        _refundFee(refund, recipient);
    }
}
