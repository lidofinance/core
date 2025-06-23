// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

import {IDepositContract} from "contracts/common/interfaces/IDepositContract.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__HarnessForTestUpgrade is IStakingVault, OwnableUpgradeable {
    /// @custom:storage-location erc7201:StakingVault.Vault
    struct ERC7201Storage {
        address nodeOperator;
        address depositor;
        bool beaconChainDepositsPaused;
    }

    /**
     * @notice Version of the contract on the implementation
     *         The implementation is petrified to this version
     */
    uint64 private constant _VERSION = 2;

    IDepositContract public immutable DEPOSIT_CONTRACT;

    bytes32 private constant ERC7201_STORAGE_LOCATION =
        0x2ec50241a851d8d3fea472e7057288d4603f7a7f78e6d18a9c12cad84552b100;

    constructor(address _beaconChainDepositContract) {
        if (_beaconChainDepositContract == address(0)) revert ZeroArgument("_beaconChainDepositContract");

        DEPOSIT_CONTRACT = IDepositContract(_beaconChainDepositContract);

        // Prevents reinitialization of the implementation
        _disableInitializers();
    }

    function initialize(address _owner, address _nodeOperator, address _depositor) external reinitializer(_VERSION) {
        if (owner() != address(0)) revert VaultAlreadyInitialized();

        __StakingVault_init_v2();
        __Ownable_init(_owner);

        ERC7201Storage storage $ = _getVaultStorage();
        $.nodeOperator = _nodeOperator;
        $.depositor = _depositor;
    }

    function owner() public view override(IStakingVault, OwnableUpgradeable) returns (address) {
        return OwnableUpgradeable.owner();
    }

    function depositor() external view returns (address) {
        return _getVaultStorage().depositor;
    }

    function finalizeUpgrade_v2() public reinitializer(_VERSION) {
        __StakingVault_init_v2();
    }

    event InitializedV2();

    function __StakingVault_init_v2() internal onlyInitializing {
        emit InitializedV2();
    }

    function getInitializedVersion() public view returns (uint64) {
        return _getInitializedVersion();
    }

    function version() external pure virtual returns (uint64) {
        return _VERSION;
    }

    function _getVaultStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    function depositToBeaconChain(IStakingVault.Deposit[] calldata _deposits) external {}

    function fund() external payable {}

    function nodeOperator() external view returns (address) {
        return _getVaultStorage().nodeOperator;
    }

    function rebalance(uint256 _ether) external {}

    function withdraw(address _recipient, uint256 _ether) external {}

    function withdrawalCredentials() external view returns (bytes32) {
        return bytes32((0x02 << 248) + uint160(address(this)));
    }

    function beaconChainDepositsPaused() external pure returns (bool) {
        return false;
    }

    function pauseBeaconChainDeposits() external {}

    function resumeBeaconChainDeposits() external {}

    function calculateValidatorWithdrawalFee(uint256) external pure returns (uint256) {
        return 1;
    }

    function requestValidatorExit(bytes calldata _pubkeys) external {}

    function ossified() external pure returns (bool) {
        return false;
    }

    function ossifyStakingVault() external {}

    function setDepositor(address _depositor) external {}

    error ZeroArgument(string name);
    error VaultAlreadyInitialized();

    function isOssified() external view override returns (bool) {}

    function triggerValidatorWithdrawals(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable override {}

    function ejectValidators(bytes calldata _pubkeys, address _refundRecipient) external payable override {}

    function ossify() external override {}

    function pendingOwner() external view override returns (address) {}

    function acceptOwnership() external override {}

    function transferOwnership(address _newOwner) public override(IStakingVault, OwnableUpgradeable) {}
}
