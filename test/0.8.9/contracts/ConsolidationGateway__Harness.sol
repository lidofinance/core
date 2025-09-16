pragma solidity 0.8.9;

import {ConsolidationGateway} from "contracts/0.8.9/ConsolidationGateway.sol";

contract ConsolidationGateway__Harness is ConsolidationGateway {
    uint256 internal _time = 2513040315;

    constructor(
        address admin,
        address lidoLocator,
        uint256 maxConsolidationRequestsLimit,
        uint256 consolidationsPerFrame,
        uint256 frameDurationInSec
    )
        ConsolidationGateway(
            admin,
            lidoLocator,
            maxConsolidationRequestsLimit,
            consolidationsPerFrame,
            frameDurationInSec
        )
    {}

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
