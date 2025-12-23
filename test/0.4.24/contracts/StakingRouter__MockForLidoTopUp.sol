// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract StakingRouter__MockForLidoTopUp {
    event Mock__TopUpCalled(
        uint256 stakingModuleId,
        uint256[] keyIndices,
        uint256[] operatorIds,
        bytes pubkeysPacked,
        uint256[] topUpLimitsGwei
    );

    uint256 private _topUpDepositAmount;
    uint256 public topUpCalls;
    bool public shouldRevert;

    function getTopUpDepositAmount(
        uint256, // _stakingModuleId,
        uint256, // _depositableEth,
        uint256[] calldata // _topUpLimits
    ) external view returns (uint256) {
        return _topUpDepositAmount;
    }

    function topUp(
        uint256 _stakingModuleId,
        uint256[] calldata _keyIndices,
        uint256[] calldata _operatorIds,
        bytes calldata _pubkeysPacked,
        uint256[] calldata _topUpLimitsGwei
    ) external payable {
        require(!shouldRevert, "StakingRouter: revert");
        ++topUpCalls;
        emit Mock__TopUpCalled(_stakingModuleId, _keyIndices, _operatorIds, _pubkeysPacked, _topUpLimitsGwei);
    }

    function mock__setTopUpDepositAmount(uint256 newValue) external {
        _topUpDepositAmount = newValue;
    }

    function mock__setShouldRevert(bool value) external {
        shouldRevert = value;
    }
}
