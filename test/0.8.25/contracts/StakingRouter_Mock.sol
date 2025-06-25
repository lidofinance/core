// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IStakingRouter} from "contracts/common/interfaces/IStakingRouter.sol";

contract StakingRouter_Mock is IStakingRouter {
    // An event to track when reportValidatorExitDelay is called
    event UnexitedValidatorReported(
        uint256 moduleId,
        uint256 nodeOperatorId,
        uint256 proofSlotTimestamp,
        bytes publicKey,
        uint256 secondsSinceEligibleExitRequest
    );

    function reportValidatorExitDelay(
        uint256 moduleId,
        uint256 nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata publicKey,
        uint256 secondsSinceEligibleExitRequest
    ) external {
        // Emit an event so that testing frameworks can detect this call
        emit UnexitedValidatorReported(
            moduleId,
            nodeOperatorId,
            _proofSlotTimestamp,
            publicKey,
            secondsSinceEligibleExitRequest
        );
    }

    function getStakingRewardsDistribution()
        external
        view
        returns (
            address[] memory /*recipients*/,
            uint256[] memory /*stakingModuleIds*/,
            uint96[] memory /*stakingModuleFees*/,
            uint96 /*totalFee*/,
            uint256 /*precisionPoints*/
        )
    {
        revert NotImplemented();
    }

    function reportRewardsMinted(
        uint256[] calldata /*_stakingModuleIds*/,
        uint256[] calldata /*_totalShares*/
    ) external {
        revert NotImplemented();
    }

    error NotImplemented();
}
