// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {StakingRouter} from "contracts/0.8.25/sr/StakingRouter.sol";
import {SRLib} from "contracts/0.8.25/sr/SRLib.sol";
import {SRStorage} from "contracts/0.8.25/sr/SRStorage.sol";
import {StakingModuleStatus, ModuleStateAccounting, RouterStateAccounting} from "contracts/0.8.25/sr/SRTypes.sol";

contract StakingRouter__Harness is StakingRouter {
    // New storage slots
    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INITIALIZABLE_STORAGE = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    constructor(
        address _depositContract,
        address _lido,
        address _lidoLocator,
        uint256 _maxEBType1,
        uint256 _maxEBType2
    ) StakingRouter(_depositContract, _lido, _lidoLocator, _maxEBType1, _maxEBType2) {}

    function testing_getLastModuleId() public view returns (uint256) {
        return SRStorage.getRouterState().lastModuleId;
    }

    function testing_addModuleId(uint256 moduleId) public {
        SRStorage.addModuleId(moduleId);
    }

    function testing_setVersion(uint256 version) public {
        _getInitializableStorage_Mock()._initialized = uint64(version);
    }

    function testing_setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status) external {
        SRLib._setModuleStatus(_stakingModuleId, _status);
    }

    function testing_setStakingModuleAccounting(
        uint256 _stakingModuleId,
        uint64 validatorsBalanceGwei,
        uint64 exitedValidatorsCount
    ) external {
        ModuleStateAccounting storage moduleAcc = SRStorage.getModuleState(_stakingModuleId).accounting;
        RouterStateAccounting storage routerAcc = SRStorage.getRouterState().accounting;

        uint64 totalValidatorsBalanceGwei = routerAcc.validatorsBalanceGwei;

        // update totals incrementally as we iterate through the part of modules in general case
        // 1. subtract old values
        unchecked {
            totalValidatorsBalanceGwei -= moduleAcc.validatorsBalanceGwei;
        }
        // 2. validate and add new values

        unchecked {
            totalValidatorsBalanceGwei += validatorsBalanceGwei;
        }

        routerAcc.validatorsBalanceGwei = totalValidatorsBalanceGwei;

        moduleAcc.validatorsBalanceGwei = validatorsBalanceGwei;
        moduleAcc.exitedValidatorsCount = exitedValidatorsCount;
    }

    function _getInitializableStorage_Mock() private pure returns (InitializableStorage storage $) {
        assembly {
            $.slot := INITIALIZABLE_STORAGE
        }
    }
}
