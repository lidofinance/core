// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface IStakingRouter {
    function getStakingRewardsDistribution()
        external
        view
        returns (
            address[] memory recipients,
            uint256[] memory stakingModuleIds,
            uint96[] memory stakingModuleFees,
            uint96 totalFee,
            uint256 precisionPoints
        );

    function reportRewardsMinted(uint256[] calldata _stakingModuleIds, uint256[] calldata _totalShares) external;

    function reportValidatorExitDelay(
        uint256 _moduleId,
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) external;
}
