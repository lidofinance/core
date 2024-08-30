// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForDepositSecurityModule {
    bool internal canDepositState;

    event StakingModuleDeposited(uint256 maxDepositsCount, uint24 stakingModuleId, bytes depositCalldata);
    event Deposited(uint256 maxDeposits);

    constructor() {
        canDepositState = true;
    }

    function setCanDeposit(bool _canDeposit) external {
        canDepositState = _canDeposit;
    }

    function deposit(
        uint256 maxDepositsCount,
        uint256 stakingModuleId,
        bytes calldata depositCalldata
    ) external returns (uint256 keysCount) {
        emit StakingModuleDeposited(maxDepositsCount, uint24(stakingModuleId), depositCalldata);
        return maxDepositsCount;
    }

    function canDeposit() external view returns (bool) {
        return canDepositState;
    }
}
