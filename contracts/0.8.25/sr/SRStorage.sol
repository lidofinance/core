// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";
import {IStakingModule} from "contracts/common/interfaces/IStakingModule.sol";
import {IStakingModuleV2} from "contracts/common/interfaces/IStakingModuleV2.sol";
import {DepositedState} from "contracts/common/interfaces/DepositedState.sol";
import {
    ModuleState,
    ModuleStateConfig,
    ModuleStateDeposits,
    ModuleStateAccounting,
    RouterStorage,
    STASStorage
} from "./SRTypes.sol";

library SRStorage {
    using EnumerableSet for EnumerableSet.UintSet;
    using SRStorage for ModuleState;
    using SRStorage for uint256; // for module IDs

    /// @dev RouterStorage storage position
    bytes32 internal constant ROUTER_STORAGE_POSITION = keccak256(
        abi.encode(uint256(keccak256(abi.encodePacked("lido.StakingRouter.routerStorage"))) - 1)
    ) & ~bytes32(uint256(0xff));

    /// @dev STASStorage storage position
    bytes32 internal constant STAS_STORAGE_POSITION = keccak256(
        abi.encode(uint256(keccak256(abi.encodePacked("lido.StakingRouter.stasStorage"))) - 1)
    ) & ~bytes32(uint256(0xff));

    /// @dev Module trackers will be derived from this position
    bytes32 internal constant DEPOSITS_TRACKER = keccak256("lido.StakingRouter.depositTracker");


    function getIStakingModule(uint256 _moduleId) internal view returns (IStakingModule) {
        return _moduleId.getModuleState().getIStakingModule();
    }

    function getIStakingModuleV2(uint256 _moduleId) internal view returns (IStakingModuleV2) {
        return _moduleId.getModuleState().getIStakingModuleV2();
    }

    function getIStakingModule(ModuleState storage $) internal view returns (IStakingModule) {
        return IStakingModule($.getStateConfig().moduleAddress);
    }

    function getIStakingModuleV2(ModuleState storage $) internal view returns (IStakingModuleV2) {
        return IStakingModuleV2($.getStateConfig().moduleAddress);
    }

    function getStateConfig(ModuleState storage $) internal view returns (ModuleStateConfig storage) {
        return $.config;
    }

    function setStateConfig(ModuleState storage $, ModuleStateConfig memory _config) internal {
        $.config = _config;
    }

    function getStateDeposits(ModuleState storage $) internal view returns (ModuleStateDeposits storage) {
        return $.deposits;
    }

    function setStateDeposits(ModuleState storage $, ModuleStateDeposits memory _deposits) internal {
        $.deposits = _deposits;
    }

    function getStateAccounting(ModuleState storage $) internal view returns (ModuleStateAccounting storage) {
        return $.accounting;
    }

    function setStateAccounting(ModuleState storage $, ModuleStateAccounting memory _accounting) internal {
        $.accounting = _accounting;
    }

    function getModuleState(uint256 _moduleId) internal view returns (ModuleState storage) {
        return getRouterStorage().moduleStates[_moduleId];
    }

    /// @dev get RouterStorage storage reference
    function getRouterStorage() internal pure returns (RouterStorage storage $) {
        bytes32 _position = ROUTER_STORAGE_POSITION;
        assembly ("memory-safe") {
            $.slot := _position
        }
    }

    function getStakingModuleTrackerStorage(uint256 stakingModuleId) internal pure returns (DepositedState storage $) {
      return _getDepositTrackerStorage(keccak256(abi.encode(stakingModuleId, DEPOSITS_TRACKER)));
    }
    
    function getLidoDepositTrackerStorage() internal pure returns (DepositedState storage $) {
      return _getDepositTrackerStorage(DEPOSITS_TRACKER);
    }

    function _getDepositTrackerStorage(bytes32 _position) private pure returns (DepositedState storage $) {
        assembly {
            $.slot := _position
        }
    }

    function getModulesCount() internal view returns (uint256) {
        return getSTASIds().length();
    }

    function getModuleIds() internal view returns (uint256[] memory) {
        return getSTASIds().values();
    }

    function isModuleId(uint256 _moduleId) internal view returns (bool) {
        return getSTASIds().contains(_moduleId);
    }

    function getSTASIds() internal view returns (EnumerableSet.UintSet storage) {
        return getSTASStorage().entityIds;
    }

    /// @dev get STASStorage storage reference
    function getSTASStorage() internal pure returns (STASStorage storage $) {
        bytes32 _position = STAS_STORAGE_POSITION;
        assembly ("memory-safe") {
            $.slot := _position
        }
    }

    /// @dev Save the last deposit state for the staking module
    /// @param _moduleId id of the staking module to be deposited
    function setModuleLastDepositState(uint256 _moduleId) internal {
        ModuleStateDeposits memory stateDeposits = _moduleId.getModuleState().getStateDeposits();
        stateDeposits.lastDepositAt = uint64(block.timestamp);
        stateDeposits.lastDepositBlock = uint64(block.number);
        _moduleId.getModuleState().setStateDeposits(stateDeposits);
    }
}
