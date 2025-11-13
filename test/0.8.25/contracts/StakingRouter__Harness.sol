// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {StakingRouter} from "contracts/0.8.25/sr/StakingRouter.sol";
import {SRLib} from "contracts/0.8.25/sr/SRLib.sol";
import {SRStorage} from "contracts/0.8.25/sr/SRStorage.sol";
import {StakingModuleStatus, ModuleStateAccounting} from "contracts/0.8.25/sr/SRTypes.sol";
import {StorageSlot} from "@openzeppelin/contracts-v5.2/utils/StorageSlot.sol";

contract StakingRouter__Harness is StakingRouter {
    using StorageSlot for bytes32;

    // Old storage slots
    bytes32 internal constant WITHDRAWAL_CREDENTIALS_POSITION = keccak256("lido.StakingRouter.withdrawalCredentials");
    bytes32 internal constant LIDO_POSITION = keccak256("lido.StakingRouter.lido");
    bytes32 internal constant LAST_STAKING_MODULE_ID_POSITION = keccak256("lido.StakingRouter.lastModuleId");

    // New storage slots
    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INITIALIZABLE_STORAGE = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    /// Mock values
    bytes32 public constant WC_01_MOCK = bytes32(0x0100000000000000000000001111111111111111111111111111111111111111);
    address public constant LIDO_ADDRESS_MOCK = 0x2222222222222222222222222222222222222222;
    uint256 public constant LAST_STAKING_MODULE_ID_MOCK = 1;

    constructor(
        address _depositContract,
        uint64 _secondsPerSlot,
        uint64 _genesisTime
    ) StakingRouter(_depositContract, _secondsPerSlot, _genesisTime) {}

    /// @notice method for testing migrateUpgrade_v4
    /// as version in new version will be stored in another slot, no need to set here old version
    /// will check migration of lido contract address and WC_01
    function testing_initializeV3() external {
        // set in old storage test wc 0x01
        WITHDRAWAL_CREDENTIALS_POSITION.getBytes32Slot().value = WC_01_MOCK;
        LIDO_POSITION.getAddressSlot().value = LIDO_ADDRESS_MOCK;
        LAST_STAKING_MODULE_ID_POSITION.getUint256Slot().value = LAST_STAKING_MODULE_ID_MOCK;

        // TODO: check that we use last
    }

    function testing_getLastModuleId() public view returns (uint256) {
        return SRStorage.getRouterStorage().lastModuleId;
    }

    function testing_setVersion(uint256 version) public {
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
}
