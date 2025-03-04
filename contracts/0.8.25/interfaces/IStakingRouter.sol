// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface IStakingRouter {
    function reportUnexitedValidator(
        uint256 moduleId,
        uint256 nodeOperatorId,
        bytes calldata publicKey,
        uint256 secondsSinceEligibleExitRequest
    ) external;
}
