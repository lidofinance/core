// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/Ownable2StepUpgradeable.sol";

import {IDepositContract} from "contracts/common/interfaces/IDepositContract.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__HarnessForTestUpgrade is IStakingVault, Ownable2StepUpgradeable {
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

    function depositToBeaconChain(IStakingVault.Deposit calldata _deposit) external override {}

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

    function triggerValidatorWithdrawals(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable override {}

    function ejectValidators(bytes calldata _pubkeys, address _refundRecipient) external payable override {}

    function ossify() external override {}

    /**
     * @notice Returns the pending owner of the contract
     * @dev Fixes solidity interface inference
     */
    function pendingOwner() public view override(IStakingVault, Ownable2StepUpgradeable) returns (address) {
        return Ownable2StepUpgradeable.pendingOwner();
    }

    /**
     * @notice Accepts the pending owner
     * @dev Fixes solidity interface inference
     * @dev Can only be called by the pending owner
     */
    function acceptOwnership() public override(IStakingVault, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable.acceptOwnership();
    }

    /**
     * @notice Transfers the ownership of the contract to a new owner
     * @param _newOwner Address of the new owner
     * @dev Fixes solidity interface inference
     * @dev Can only be called by the owner
     */
    function transferOwnership(address _newOwner) public override(IStakingVault, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable.transferOwnership(_newOwner);
    }

    function collectERC20(address _token, address _recipient, uint256 _amount) external {
        // no-op
    }

    function availableBalance() external view override returns (uint256) {
        return address(this).balance;
    }

    function stagedBalance() external view override returns (uint256) {}

    function stage(uint256 _ether) external override {}

    function unstage(uint256 _ether) external override {}

    function depositFromStaged(Deposit calldata _deposit, uint256 _additionalDeposit) external override {}
}
