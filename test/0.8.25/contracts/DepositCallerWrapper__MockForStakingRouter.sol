// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.25;

interface IStakingRouter {
    function deposit(uint256 _stakingModuleId, bytes calldata _depositCalldata) external payable;
    function getStakingModuleMaxInitialDepositsAmount(
        uint256 _stakingModuleId,
        uint256 _depositableEth
    ) external view returns (uint256, uint256);
}

/// @notice Test-only wrapper that must be set as the authorized Lido caller in the router.
contract DepositCallerWrapper__MockForStakingRouter {
    IStakingRouter public immutable stakingRouter;

    constructor(IStakingRouter _router) {
        stakingRouter = _router;
    }

    /// @notice Store temp values as operators and number of deposits per operator + deposit
    /// No refund logic; requires exact msg.value.
    function deposit(
        uint256 stakingModuleId,
        uint256[] calldata operators,
        uint256[] calldata counts
    ) external payable {
        stakingRouter.deposit{value: msg.value}(stakingModuleId, bytes(""));
    }
}
