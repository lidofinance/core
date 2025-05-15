pragma solidity 0.8.9;

import {TriggerableWithdrawalGateway} from "contracts/0.8.9/TriggerableWithdrawalGateway.sol";

contract TriggerableWithdrawalGateway__Harness is TriggerableWithdrawalGateway {
    uint256 internal _time = 2513040315;

    constructor(address lidoLocator) TriggerableWithdrawalGateway(lidoLocator) {}

    function getTimestamp() external view returns (uint256) {
        return _time;
    }

    function _getTimestamp() internal view override returns (uint256) {
        return _time;
    }

    function advanceTimeBy(uint256 timeAdvance) external {
        _time += timeAdvance;
    }
}
