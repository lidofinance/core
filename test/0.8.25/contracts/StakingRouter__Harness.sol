// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {StakingRouter} from "contracts/0.8.25/sr/StakingRouter.sol";
import {DepositsTempStorage} from "contracts/common/lib/DepositsTempStorage.sol";
import {SRLib} from "contracts/0.8.25/sr/SRLib.sol";
import {SRStorage} from "contracts/0.8.25/sr/SRStorage.sol";
import {StakingModuleStatus, ModuleStateAccounting} from "contracts/0.8.25/sr/SRTypes.sol";

contract StakingRouter__Harness is StakingRouter {
    constructor(
        address _depositContract,
        uint64 _secondsPerSlot,
        uint64 _genesisTime
    ) StakingRouter(_depositContract, _secondsPerSlot, _genesisTime) {}

    /// @notice FOR TEST: write operators & counts into the router's transient storage.
    function mock_storeTemp(uint256[] calldata operators, uint256[] calldata counts) external {
        DepositsTempStorage.storeOperators(operators);
        DepositsTempStorage.storeCounts(counts);
    }

    /// @notice FOR TEST: clear temp
    function mock_clearTemp() external {
        DepositsTempStorage.clearOperators();
        DepositsTempStorage.clearCounts();
    }

    function testing_setVersion(uint256 version) external {
        _getInitializableStorage_Mock()._initialized = uint64(version);
    }

    function testing_setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status) external {
        SRLib._setModuleStatus(_stakingModuleId, _status);
    }

    function testing_setStakingModuleAccounting(
        uint256 _stakingModuleId,
        uint96 clBalanceGwei,
        uint96 activeBalanceGwei,
        uint64 exitedValidatorsCount
    ) external {
        ModuleStateAccounting storage stateAcc = SRStorage.getStateAccounting(
            SRStorage.getModuleState(_stakingModuleId)
        );

        uint96 totalClBalanceGwei = SRStorage.getRouterStorage().totalClBalanceGwei;
        SRStorage.getRouterStorage().totalClBalanceGwei = totalClBalanceGwei - stateAcc.clBalanceGwei + clBalanceGwei;

        uint96 totalActiveBalanceGwei = SRStorage.getRouterStorage().totalActiveBalanceGwei;
        SRStorage.getRouterStorage().totalActiveBalanceGwei =
            totalActiveBalanceGwei -
            stateAcc.activeBalanceGwei +
            activeBalanceGwei;

        stateAcc.clBalanceGwei = clBalanceGwei;
        stateAcc.activeBalanceGwei = activeBalanceGwei;
        stateAcc.exitedValidatorsCount = exitedValidatorsCount;
    }

    function _getInitializableStorage_Mock() private pure returns (InitializableStorage storage $) {
        assembly {
            $.slot := INITIALIZABLE_STORAGE
        }
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INITIALIZABLE_STORAGE = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
}
