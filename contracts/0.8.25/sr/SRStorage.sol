// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";
import {IStakingModule} from "contracts/common/interfaces/IStakingModule.sol";
import {IStakingModuleV2} from "contracts/common/interfaces/IStakingModuleV2.sol";
import {ModuleState, RouterState} from "./SRTypes.sol";

library SRStorage {
    using EnumerableSet for EnumerableSet.UintSet;
    using SRStorage for ModuleState;

    /// @dev RouterState storage position
    bytes32 internal constant ROUTER_STORAGE_POSITION = keccak256(
        abi.encode(uint256(keccak256(abi.encodePacked("lido.StakingRouter.routerStorage"))) - 1)
    ) & ~bytes32(uint256(0xff));

    /// @dev get RouterState storage reference
    function getRouterState() internal pure returns (RouterState storage $) {
        bytes32 _position = ROUTER_STORAGE_POSITION;
        assembly ("memory-safe") {
            $.slot := _position
        }
    }

    /**
     * Module state helpers
     */

    function getModuleState(uint256 _moduleId) internal view returns (ModuleState storage) {
        return getRouterState().moduleStates[_moduleId];
    }

    function getIStakingModule(ModuleState storage $) internal view returns (IStakingModule) {
        return IStakingModule($.config.moduleAddress);
    }

    function getIStakingModuleV2(ModuleState storage $) internal view returns (IStakingModuleV2) {
        return IStakingModuleV2($.config.moduleAddress);
    }

    function getIStakingModule(uint256 _moduleId) internal view returns (IStakingModule) {
        return getModuleState(_moduleId).getIStakingModule();
    }

    function getIStakingModuleV2(uint256 _moduleId) internal view returns (IStakingModuleV2) {
        return getModuleState(_moduleId).getIStakingModuleV2();
    }

    /**
     * ModuleIds set helpers
     */

    function getModulesCount() internal view returns (uint256) {
        return getRouterState().moduleIds.length();
    }

    function getModuleIds() internal view returns (uint256[] memory) {
        return getRouterState().moduleIds.values();
    }

    function getModuleIdAt(uint256 _idx) internal view returns (uint256) {
        return getRouterState().moduleIds.at(_idx);
    }

    function isModuleExists(uint256 _moduleId) internal view returns (bool) {
        return getRouterState().moduleIds.contains(_moduleId);
    }

    /// @notice get module inner position in the list of modules (1-based)
    /// @dev direct access to EnumerableSet internal storage
    function getModuleIdInnerPosition(uint256 _moduleId) internal view returns (uint256) {
        return getRouterState().moduleIds._inner._positions[bytes32(_moduleId)];
    }

    function addModuleId(uint256 _moduleId) internal {
        getRouterState().moduleIds.add(_moduleId);
    }
}
