// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IStakingRouter} from "contracts/0.8.25/interfaces/IStakingRouter.sol";

contract StakingRouter_Mock is IStakingRouter {
    // An event to track when reportUnexitedValidator is called
    event UnexitedValidatorReported(
        uint256 moduleId,
        uint256 nodeOperatorId,
        bytes publicKey,
        uint256 secondsSinceEligibleExitRequest
    );

    function reportUnexitedValidator(
        uint256 moduleId,
        uint256 nodeOperatorId,
        bytes calldata publicKey,
        uint256 secondsSinceEligibleExitRequest
    ) external {
        // Emit an event so that testing frameworks can detect this call
        emit UnexitedValidatorReported(moduleId, nodeOperatorId, publicKey, secondsSinceEligibleExitRequest);
    }
}
