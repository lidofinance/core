// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract StakingRouter__MockForLidoTopUp {
    event Mock__TopUpCalled(uint256 stakingModuleId, bytes pubkeysPacked, uint256[] topUpLimitsGwei);

    uint256 private _amount;
    bytes private _pubkeysPacked;
    uint256[] private _topUpAmounts;

    uint256 public topUpCalls;
    bool public shouldRevert;

    function getTopUpDepositAmount(
        uint256,
        uint256,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata,
        uint256[] calldata
    ) external view returns (uint256 amount, bytes memory pubkeysPacked, uint256[] memory allocations) {
        amount = _amount;
        pubkeysPacked = _pubkeysPacked;
        allocations = _topUpAmounts;
    }

    function topUp(
        uint256 stakingModuleId,
        bytes calldata pubkeysPacked,
        uint256[] calldata topUpAmountsGwei
    ) external payable {
        require(!shouldRevert, "StakingRouter: revert");
        ++topUpCalls;
        emit Mock__TopUpCalled(stakingModuleId, pubkeysPacked, topUpAmountsGwei);
    }

    function mock__setTopUpAmount(
        uint256 topUpDepositAmount,
        bytes calldata pubkeysPacked,
        uint256[] calldata topUpAmounts
    ) external {
        _amount = topUpDepositAmount;
        _pubkeysPacked = pubkeysPacked;
        _topUpAmounts = topUpAmounts;
    }

    function mock__setShouldRevert(bool value) external {
        shouldRevert = value;
    }
}
