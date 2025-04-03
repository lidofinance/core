// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

import {IDepositContract} from "contracts/0.8.25/interfaces/IDepositContract.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__HarnessForTestUpgrade is IStakingVault, OwnableUpgradeable {
    /// @custom:storage-location erc7201:StakingVault.Vault
    struct ERC7201Storage {
        Report report;
        uint128 locked;
        int128 inOutDelta;
        address nodeOperator;
        bool beaconChainDepositsPaused;
    }

    /**
     * @notice Version of the contract on the implementation
     *         The implementation is petrified to this version
     */
    uint64 private constant _VERSION = 2;

    /**
     * @notice Address of `VaultHub`
     *         Set immutably in the constructor to avoid storage costs
     */
    VaultHub private immutable VAULT_HUB;

    /**
     * @notice Address of depositor
     *         Set immutably in the constructor to avoid storage costs
     */
    address private immutable DEPOSITOR;

    /**
     * @notice Address of `BeaconChainDepositContract`
     *         Set immutably in the constructor to avoid storage costs
     */
    IDepositContract public immutable DEPOSIT_CONTRACT;

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         `keccak256(abi.encode(uint256(keccak256("Lido.Vaults.StakingVault")) - 1)) & ~bytes32(uint256(0xff))`
     */
    bytes32 private constant ERC7201_STORAGE_LOCATION =
        0x2ec50241a851d8d3fea472e7057288d4603f7a7f78e6d18a9c12cad84552b100;

    /**
     * @notice Constructs the implementation of `StakingVault`
     * @param _vaultHub Address of `VaultHub`
     * @param _depositor Address of the depositor
     * @param _beaconChainDepositContract Address of `BeaconChainDepositContract`
     * @dev Fixes `VaultHub` and `BeaconChainDepositContract` addresses in the bytecode of the implementation
     */
    constructor(address _vaultHub, address _depositor, address _beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");
        if (_depositor == address(0)) revert ZeroArgument("_depositor");
        if (_beaconChainDepositContract == address(0)) revert ZeroArgument("_beaconChainDepositContract");

        VAULT_HUB = VaultHub(_vaultHub);
        DEPOSITOR = _depositor;
        DEPOSIT_CONTRACT = IDepositContract(_beaconChainDepositContract);

        // Prevents reinitialization of the implementation
        _disableInitializers();
    }

    function initialize(
        address _owner,
        address _nodeOperator,
        bytes calldata /* _params */
    ) external reinitializer(_VERSION) {
        if (owner() != address(0)) {
            revert VaultAlreadyInitialized();
        }

        __StakingVault_init_v2();
        __Ownable_init(_owner);
        _getVaultStorage().nodeOperator = _nodeOperator;
    }

    function owner() public view override(IStakingVault, OwnableUpgradeable) returns (address) {
        return OwnableUpgradeable.owner();
    }

    function depositor() external view returns (address) {
        return DEPOSITOR;
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

    function latestReport() external view returns (IStakingVault.Report memory) {
        ERC7201Storage storage $ = _getVaultStorage();
        return IStakingVault.Report({valuation: $.report.valuation, inOutDelta: $.report.inOutDelta});
    }

    function _getVaultStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    function depositToBeaconChain(Deposit[] calldata _deposits) external {}

    function fund() external payable {}

    function inOutDelta() external pure returns (int256) {
        return -1;
    }

    function nodeOperator() external view returns (address) {
        return _getVaultStorage().nodeOperator;
    }

    function rebalance(uint256 _ether) external {}

    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {}

    function lock(uint256 _locked) external {}

    function locked() external pure returns (uint256) {
        return 0;
    }

    function unlocked() external pure returns (uint256) {
        return 0;
    }

    function valuation() external pure returns (uint256) {
        return 0;
    }

    function vaultHub() external view returns (address) {
        return address(VAULT_HUB);
    }

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

    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _recipient
    ) external payable {}

    error ZeroArgument(string name);
    error VaultAlreadyInitialized();
}
