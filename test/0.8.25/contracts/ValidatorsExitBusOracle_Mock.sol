// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IValidatorsExitBusOracle, RequestStatus} from "contracts/0.8.25/interfaces/IValidatorsExitBusOracle.sol";

contract ValidatorsExitBusOracle_Mock is IValidatorsExitBusOracle {
    mapping(bytes32 => RequestStatus) private _statuses;

    function setExitRequestsStatus(bytes32 exitRequestsHash, RequestStatus calldata status) external {
        _statuses[exitRequestsHash] = status;
    }

    /**
     * @dev Implements the IValidatorsExitBusOracle interface function.
     * Returns the stored RequestStatus for the given exitRequestsHash.
     */
    function getExitRequestsStatus(bytes32 exitRequestsHash) external view override returns (RequestStatus memory) {
        return _statuses[exitRequestsHash];
    }
}
