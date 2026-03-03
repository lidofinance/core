// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {StakingRouter} from "contracts/0.8.25/sr/StakingRouter.sol";
import {SRLib} from "contracts/0.8.25/sr/SRLib.sol";
import {SRStorage} from "contracts/0.8.25/sr/SRStorage.sol";
import {StakingModuleStatus, ModuleStateAccounting, RouterStateAccounting} from "contracts/0.8.25/sr/SRTypes.sol";
import {StorageSlot} from "@openzeppelin/contracts-v5.2/utils/StorageSlot.sol";

contract StakingRouter__Harness is StakingRouter {
    using StorageSlot for bytes32;

    // Old storage slots (must match constants in old 0.8.9 StakingRouter and SRLib)
    bytes32 internal constant WITHDRAWAL_CREDENTIALS_POSITION = keccak256("lido.StakingRouter.withdrawalCredentials");
    bytes32 internal constant LIDO_POSITION = keccak256("lido.StakingRouter.lido");
    bytes32 internal constant LAST_STAKING_MODULE_ID_POSITION = keccak256("lido.StakingRouter.lastStakingModuleId");
    bytes32 internal constant STAKING_MODULES_COUNT_POSITION = keccak256("lido.StakingRouter.stakingModulesCount");
    bytes32 internal constant CONTRACT_VERSION_POSITION = keccak256("lido.Versioned.contractVersion");

    // Old AccessControl storage slot from 0.8.9 custom implementation
    bytes32 internal constant OLD_ROLES_POSITION = keccak256("openzeppelin.AccessControl._roles");

    // New storage slots
    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INITIALIZABLE_STORAGE = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    /// Mock values matching old 0.8.9 StakingRouter state
    bytes32 public constant WC_01_MOCK = bytes32(0x0100000000000000000000001111111111111111111111111111111111111111);
    address public constant LIDO_ADDRESS_MOCK = 0x2222222222222222222222222222222222222222;
    uint256 public constant LAST_STAKING_MODULE_ID_MOCK = 1;
    uint256 public constant STAKING_MODULES_COUNT_MOCK = 0;
    uint256 public constant CONTRACT_VERSION_V3 = 3;

    constructor(
        address _depositContract,
        address _lido,
        address _lidoLocator
    ) StakingRouter(_depositContract, _lido, _lidoLocator) {}

    /// @notice Simulates old 0.8.9 StakingRouter state before v4 migration.
    /// Sets all old unstructured storage slots that _migrateStorage() reads and cleans up.
    function testing_initializeV3() external {
        WITHDRAWAL_CREDENTIALS_POSITION.getBytes32Slot().value = WC_01_MOCK;
        LIDO_POSITION.getAddressSlot().value = LIDO_ADDRESS_MOCK;
        LAST_STAKING_MODULE_ID_POSITION.getUint256Slot().value = LAST_STAKING_MODULE_ID_MOCK;
        STAKING_MODULES_COUNT_POSITION.getUint256Slot().value = STAKING_MODULES_COUNT_MOCK;
        CONTRACT_VERSION_POSITION.getUint256Slot().value = CONTRACT_VERSION_V3;
    }

    /// @notice Checks that old storage slots are cleaned up after migration
    function testing_getOldLidoPosition() external view returns (address) {
        return LIDO_POSITION.getAddressSlot().value;
    }

    function testing_getOldWcPosition() external view returns (bytes32) {
        return WITHDRAWAL_CREDENTIALS_POSITION.getBytes32Slot().value;
    }

    function testing_getOldContractVersion() external view returns (uint256) {
        return CONTRACT_VERSION_POSITION.getUint256Slot().value;
    }

    function testing_getOldLastModuleIdPosition() external view returns (uint256) {
        return LAST_STAKING_MODULE_ID_POSITION.getUint256Slot().value;
    }

    function testing_getOldModulesCountPosition() external view returns (uint256) {
        return STAKING_MODULES_COUNT_POSITION.getUint256Slot().value;
    }

    /// @notice Write a role grant into the OLD AccessControl storage (0.8.9 layout).
    /// Old layout: mapping(bytes32 role => RoleData) at OLD_ROLES_POSITION,
    /// where RoleData slot 0 = mapping(address => bool) members.
    function testing_setOldRole(bytes32 role, address account, bool value) external {
        // slot of _roles[role] = keccak256(role . OLD_ROLES_POSITION)
        bytes32 roleSlot = keccak256(abi.encode(role, OLD_ROLES_POSITION));
        // slot of _roles[role].members[account] = keccak256(account . roleSlot)
        bytes32 memberSlot = keccak256(abi.encode(account, roleSlot));
        assembly {
            sstore(memberSlot, value)
        }
    }

    /// @notice Read a role grant from the OLD AccessControl storage (0.8.9 layout).
    function testing_getOldRole(bytes32 role, address account) external view returns (bool value) {
        bytes32 roleSlot = keccak256(abi.encode(role, OLD_ROLES_POSITION));
        bytes32 memberSlot = keccak256(abi.encode(account, roleSlot));
        assembly {
            value := sload(memberSlot)
        }
    }

    function testing_getLastModuleId() public view returns (uint256) {
        return SRStorage.getRouterState().lastModuleId;
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
        uint64 pendingBalanceGwei,
        uint64 exitedValidatorsCount
    ) external {
        ModuleStateAccounting storage moduleAcc = SRStorage.getModuleState(_stakingModuleId).accounting;
        RouterStateAccounting storage routerAcc = SRStorage.getRouterState().accounting;

        uint64 totalValidatorBalanceGwei = routerAcc.validatorsBalanceGwei;
        uint64 totalPendingBalanceGwei = routerAcc.pendingBalanceGwei;

        // update totals incrementally as we iterate through the part of modules in general case
        // 1. subtract old values
        unchecked {
            totalValidatorBalanceGwei -= moduleAcc.validatorsBalanceGwei;
            totalPendingBalanceGwei -= moduleAcc.pendingBalanceGwei;
        }
        // 2. validate and add new values

        unchecked {
            totalValidatorBalanceGwei += validatorsBalanceGwei;
            totalPendingBalanceGwei += pendingBalanceGwei;
        }

        routerAcc.validatorsBalanceGwei = totalValidatorBalanceGwei;
        routerAcc.pendingBalanceGwei = totalPendingBalanceGwei;

        moduleAcc.validatorsBalanceGwei = validatorsBalanceGwei;
        moduleAcc.pendingBalanceGwei = pendingBalanceGwei;
        moduleAcc.exitedValidatorsCount = exitedValidatorsCount;
    }

    function _getInitializableStorage_Mock() private pure returns (InitializableStorage storage $) {
        assembly {
            $.slot := INITIALIZABLE_STORAGE
        }
    }
}
