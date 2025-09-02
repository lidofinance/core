// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {StakingRouter} from "contracts/0.8.25/StakingRouter.sol";
// import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";

contract StakingRouter__Harness is StakingRouter {
    // using UnstructuredStorage for bytes32;

    constructor(
        address _depositContract,
        uint256 _secondsPerSlot,
        uint256 _genesisTime
    ) StakingRouter(_depositContract, _secondsPerSlot, _genesisTime) {}

    function getStakingModuleIndexById(uint256 _stakingModuleId) external view returns (uint256) {
        return _getStakingModuleIndexById(_stakingModuleId);
    }

    function getStakingModuleByIndex(uint256 _stakingModuleIndex) external view returns (StakingModule memory) {
        return _getStakingModuleByIndex(_stakingModuleIndex);
    }

    // function testing_setBaseVersion(uint256 version) external {
    //     CONTRACT_VERSION_POSITION.setStorageUint256(version);
    // }

    function testing_setVersion(uint256 version) external {
        _getInitializableStorage_Mock()._initialized = uint64(version);
    }

    function testing_setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status) external {
        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
        _setStakingModuleStatus(stakingModule, _status);
    }

    function _getInitializableStorage_Mock() private pure returns (InitializableStorage storage $) {
        assembly {
            $.slot := INITIALIZABLE_STORAGE
        }
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INITIALIZABLE_STORAGE = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
}
