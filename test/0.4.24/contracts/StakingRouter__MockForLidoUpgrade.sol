// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract CSModule__MockForLidoUpgrade {
    address private constant accountingAddress = 0xAC00000000000000000000000000000000000000;

    function accounting() external pure returns (address) {
        return accountingAddress;
    }
}

contract StakingRouter__MockForLidoUpgrade {
    struct StakingModule {
        /// @notice Unique id of the staking module.
        uint24 id;
        /// @notice Address of the staking module.
        address stakingModuleAddress;
        /// @notice Part of the fee taken from staking rewards that goes to the staking module.
        uint16 stakingModuleFee;
        /// @notice Part of the fee taken from staking rewards that goes to the treasury.
        uint16 treasuryFee;
        /// @notice Maximum stake share that can be allocated to a module, in BP.
        /// @dev Formerly known as `targetShare`.
        uint16 stakeShareLimit;
        /// @notice Staking module status if staking module can not accept the deposits or can
        /// participate in further reward distribution.
        uint8 status;
        /// @notice Name of the staking module.
        string name;
        /// @notice block.timestamp of the last deposit of the staking module.
        /// @dev NB: lastDepositAt gets updated even if the deposit value was 0 and no actual deposit happened.
        uint64 lastDepositAt;
        /// @notice block.number of the last deposit of the staking module.
        /// @dev NB: lastDepositBlock gets updated even if the deposit value was 0 and no actual deposit happened.
        uint256 lastDepositBlock;
        /// @notice Number of exited validators.
        uint256 exitedValidatorsCount;
        /// @notice Module's share threshold, upon crossing which, exits of validators from the module will be prioritized, in BP.
        uint16 priorityExitShareThreshold;
        /// @notice The maximum number of validators that can be deposited in a single block.
        /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
        /// See docs for the `OracleReportSanityChecker.setAppearedValidatorsPerDayLimit` function.
        uint64 maxDepositsPerBlock;
        /// @notice The minimum distance between deposits in blocks.
        /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
        /// See docs for the `OracleReportSanityChecker.setAppearedValidatorsPerDayLimit` function).
        uint64 minDepositBlockDistance;
    }

    address private immutable ACCOUNTING;

    constructor() {
        ACCOUNTING = address(new CSModule__MockForLidoUpgrade());
    }

    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory) {
        if (_stakingModuleId == 1) {
            return
                StakingModule({
                    id: 1,
                    stakingModuleAddress: 0x00f00BA000000000000000000000000000001111,
                    stakingModuleFee: 1000,
                    treasuryFee: 1000,
                    stakeShareLimit: 1000,
                    status: 1,
                    name: "NodeOperatorsRegistry",
                    lastDepositAt: 1000,
                    lastDepositBlock: 1000,
                    exitedValidatorsCount: 1000,
                    priorityExitShareThreshold: 1000,
                    maxDepositsPerBlock: 1000,
                    minDepositBlockDistance: 1000
                });
        }
        if (_stakingModuleId == 2) {
            return
                StakingModule({
                    id: 2,
                    stakingModuleAddress: 0x00f00Ba000000000000000000000000000002222,
                    stakingModuleFee: 1000,
                    treasuryFee: 1000,
                    stakeShareLimit: 1000,
                    status: 1,
                    name: "SimpleDVT",
                    lastDepositAt: 1000,
                    lastDepositBlock: 1000,
                    exitedValidatorsCount: 1000,
                    priorityExitShareThreshold: 1000,
                    maxDepositsPerBlock: 1000,
                    minDepositBlockDistance: 1000
                });
        }
        if (_stakingModuleId == 3) {
            return
                StakingModule({
                    id: 3,
                    stakingModuleAddress: ACCOUNTING,
                    stakingModuleFee: 1000,
                    treasuryFee: 1000,
                    stakeShareLimit: 1000,
                    status: 1,
                    name: "CSM",
                    lastDepositAt: 1000,
                    lastDepositBlock: 1000,
                    exitedValidatorsCount: 1000,
                    priorityExitShareThreshold: 1000,
                    maxDepositsPerBlock: 1000,
                    minDepositBlockDistance: 1000
                });
        }
        revert("Invalid staking module id");
    }
}
