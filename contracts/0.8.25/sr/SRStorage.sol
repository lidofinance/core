// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";
import {IStakingModule} from "contracts/common/interfaces/IStakingModule.sol";
import {IStakingModuleV2} from "contracts/common/interfaces/IStakingModuleV2.sol";
import {ModuleState, RouterState} from "./SRTypes.sol";

library SRStorage {
    using EnumerableSet for EnumerableSet.UintSet;
    using SRStorage for ModuleState;
    using SRStorage for uint256; // for module IDs

    /// @dev RouterState storage position
    bytes32 internal constant ROUTER_STORAGE_POSITION = keccak256(
        abi.encode(uint256(keccak256(abi.encodePacked("lido.StakingRouter.routerStorage"))) - 1)
    ) & ~bytes32(uint256(0xff));

    function getIStakingModule(uint256 _moduleId) internal view returns (IStakingModule) {
        return _moduleId.getModuleState().getIStakingModule();
    }

    function getIStakingModuleV2(uint256 _moduleId) internal view returns (IStakingModuleV2) {
        return _moduleId.getModuleState().getIStakingModuleV2();
    }

    function getIStakingModule(ModuleState storage $) internal view returns (IStakingModule) {
        return IStakingModule($.config.moduleAddress);
    }

    function getIStakingModuleV2(ModuleState storage $) internal view returns (IStakingModuleV2) {
        return IStakingModuleV2($.config.moduleAddress);
    }

    function getModuleState(uint256 _moduleId) internal view returns (ModuleState storage) {
        return getRouterState().moduleStates[_moduleId];
    }

    /// @dev get RouterState storage reference
    function getRouterState() internal pure returns (RouterState storage $) {
        bytes32 _position = ROUTER_STORAGE_POSITION;
        assembly ("memory-safe") {
            $.slot := _position
        }
    }

    function getModulesCount() internal view returns (uint256) {
        return getRouterState().moduleIds.length();
    }

    function getModuleIds() internal view returns (uint256[] memory) {
        return getRouterState().moduleIds.values();
    }

    function isModuleId(uint256 _moduleId) internal view returns (bool) {
        return getRouterState().moduleIds.contains(_moduleId);
    }

    function getModuleInternalPositionById(uint256 _moduleId) internal view returns (uint256) {
        // get the internal position (1-based index) of the module ID in the enumerable set
        return getRouterState().moduleIds._inner._positions[bytes32(_moduleId)];
    }

    function addModuleId(uint256 _moduleId) internal {
        getRouterState().moduleIds.add(_moduleId);
    }

    function removeModuleId(uint256 _moduleId) internal {
        getRouterState().moduleIds.remove(_moduleId);
    }
}
