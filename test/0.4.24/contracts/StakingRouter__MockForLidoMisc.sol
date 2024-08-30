// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract StakingRouter__MockForLidoMisc {
    event Mock__DepositCalled();

    uint256 private stakingModuleMaxDepositsCount;

    function getWithdrawalCredentials() external view returns (bytes32) {
        return 0x010000000000000000000000b9d7934878b5fb9610b3fe8a5e441e8fad7e293f; // Lido Withdrawal Creds
    }

    function getTotalFeeE4Precision() external view returns (uint16) {
        return 1000; // 10%
    }

    function TOTAL_BASIS_POINTS() external view returns (uint256) {
        return 10000; // 100%
    }

    function getStakingFeeAggregateDistributionE4Precision()
        external
        view
        returns (uint16 treasuryFee, uint16 modulesFee)
    {
        treasuryFee = 500;
        modulesFee = 500;
    }

    function getStakingModuleMaxDepositsCount(
        uint256 _stakingModuleId,
        uint256 _maxDepositsValue
    ) public view returns (uint256) {
        return stakingModuleMaxDepositsCount;
    }

    function deposit(
        uint256 _depositsCount,
        uint256 _stakingModuleId,
        bytes calldata _depositCalldata
    ) external payable {
        emit Mock__DepositCalled();
    }

    function mock__getStakingModuleMaxDepositsCount(uint256 newValue) external {
        stakingModuleMaxDepositsCount = newValue;
    }
}
