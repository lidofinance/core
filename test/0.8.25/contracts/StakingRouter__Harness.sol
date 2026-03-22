// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {StakingRouter} from "contracts/0.8.25/sr/StakingRouter.sol";
import {SRLib} from "contracts/0.8.25/sr/SRLib.sol";
import {SRStorage} from "contracts/0.8.25/sr/SRStorage.sol";
import {StakingModuleStatus, ModuleStateAccounting, RouterStateAccounting} from "contracts/0.8.25/sr/SRTypes.sol";
import {StorageSlot} from "@openzeppelin/contracts-v5.2/utils/StorageSlot.sol";
import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";

contract StakingRouter__Harness is StakingRouter {
    using StorageSlot for bytes32;
    using EnumerableSet for EnumerableSet.AddressSet;

    // Old storage slots (must match constants in old 0.8.9 StakingRouter and SRLib)
    bytes32 internal constant WITHDRAWAL_CREDENTIALS_POSITION = keccak256("lido.StakingRouter.withdrawalCredentials");
    bytes32 internal constant LIDO_POSITION = keccak256("lido.StakingRouter.lido");
    bytes32 internal constant LAST_STAKING_MODULE_ID_POSITION = keccak256("lido.StakingRouter.lastStakingModuleId");
    bytes32 internal constant STAKING_MODULES_COUNT_POSITION = keccak256("lido.StakingRouter.stakingModulesCount");
    bytes32 internal constant CONTRACT_VERSION_POSITION = keccak256("lido.Versioned.contractVersion");

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
        address _lidoLocator,
        uint256 _maxEBType1,
        uint256 _maxEBType2
    ) StakingRouter(_depositContract, _lido, _lidoLocator, _maxEBType1, _maxEBType2) {}

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

    /// @notice Grant a role inside the OLD AccessControl storage (OZ v4.4)
    function testing_grantRoleOld(bytes32 role, address account) external {
        _storageRoles()[role].members[account] = true;
        _storageRoleMembers()[role].add(account);
    }

    /// @notice Read a role grant from the OLD AccessControl storage (OZ v4.4)
    function testing_hasRoleOld(bytes32 role, address account) external view returns (bool) {
        return _storageRoles()[role].members[account];
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

    // OZ AccessControl v.4.4

    struct RoleDataOld {
        mapping(address => bool) members;
        bytes32 adminRole;
    }

    /// @dev OZ AccessControlEnumerable _roleMembers mapping storage reference
    function _storageRoleMembers() private pure returns (mapping(bytes32 => EnumerableSet.AddressSet) storage $) {
        bytes32 position = keccak256("openzeppelin.AccessControlEnumerable._roleMembers");
        assembly {
            $.slot := position
        }
    }

    /// @dev OZ AccessControl _roles mapping storage reference
    function _storageRoles() private pure returns (mapping(bytes32 => RoleDataOld) storage $) {
        bytes32 position = keccak256("openzeppelin.AccessControl._roles");
        assembly {
            $.slot := position
        }
    }
}
