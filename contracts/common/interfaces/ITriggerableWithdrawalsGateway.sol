// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v4.4/access/IAccessControlEnumerable.sol";

import {IStakingRouter} from "./IStakingRouter.sol";

interface ITriggerableWithdrawalsGateway is IAccessControlEnumerable {
    // Errors
    error ZeroArgument(string name);
    error AdminCannotBeZero();
    error InsufficientFee(uint256 feeRequired, uint256 passedValue);
    error FeeRefundFailed();
    error ExitRequestsLimitExceeded(uint256 requestsCount, uint256 remainingLimit);

    // Events
    event ExitRequestsLimitSet(uint256 maxExitRequestsLimit, uint256 exitsPerFrame, uint256 frameDurationInSec);

    // Constants (external view functions for public constants)
    function PAUSE_ROLE() external view returns (bytes32);
    function RESUME_ROLE() external view returns (bytes32);
    function ADD_FULL_WITHDRAWAL_REQUEST_ROLE() external view returns (bytes32);
    function TW_EXIT_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function VERSION() external view returns (uint256);
    function TWR_LIMIT_POSITION() external view returns (bytes32);

    // External functions
    function resume() external;
    function pauseFor(uint256 _duration) external;
    function pauseUntil(uint256 _pauseUntilInclusive) external;
    function triggerFullWithdrawals(
        IStakingRouter.ValidatorExitData[] calldata validatorsData,
        address refundRecipient,
        uint256 exitType
    ) external payable;
    function setExitRequestLimit(
        uint256 maxExitRequestsLimit,
        uint256 exitsPerFrame,
        uint256 frameDurationInSec
    ) external;
    function getExitRequestLimitFullInfo()
        external
        view
        returns (
            uint256 maxExitRequestsLimit,
            uint256 exitsPerFrame,
            uint256 frameDurationInSec,
            uint256 prevExitRequestsLimit,
            uint256 currentExitRequestsLimit
        );
}