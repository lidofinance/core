// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.4.24;

import "contracts/0.4.24/Lido.sol";
import {StakeLimitUnstructuredStorage} from "contracts/0.4.24/lib/StakeLimitUtils.sol";

contract LidoHarness is Lido {
    using StakeLimitUnstructuredStorage for bytes32;

    function stakingModuleMaxDepositsCount(uint256 _stakingModuleId, uint256 _maxValue) public view returns (uint256) {
        IStakingRouter stakingRouter = IStakingRouter(_getLidoLocator().stakingRouter());
        return stakingRouter.getStakingModuleMaxDepositsCount(_stakingModuleId, _maxValue);
    }

    function LidoEthBalance() public view returns(uint256) {
        return address(this).balance;
    }

    function getEthBalance(address account) public view returns(uint256) {
        return account.balance;
    }

    function getInternalEther() external view returns (uint256) {
        return _getInternalEther();
    }

    function getShareRateNumerator() external view returns (uint256) {
        return _getShareRateNumerator();
    }
    
    function getShareRateDenominator() external view returns (uint256) {
        return _getShareRateDenominator();
    }

    function getPrevStakeLimit() external view returns (uint96) {
        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();
        return stakeLimitData.prevStakeLimit;
    }

    function getPrevStakeBlockNumber() external view returns (uint32) {
        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();
        return stakeLimitData.prevStakeBlockNumber;
    }

    function getMaxStakeLimit() external view returns (uint96) {
        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();
        return stakeLimitData.maxStakeLimit;
    }

    function getMaxStakeLimitGrowthBlocks() external view returns (uint32) {
        StakeLimitState.Data memory stakeLimitData = STAKING_STATE_POSITION.getStorageStakeLimitStruct();
        return stakeLimitData.maxStakeLimitGrowthBlocks;
    }

    function getDepositedValidators() external view returns (uint256) {
        return _getDepositedValidators();
    }

    function getBalanceAndClValidators() external view returns (uint256, uint256) {
        return _getClBalanceAndClValidators();
    }
}
