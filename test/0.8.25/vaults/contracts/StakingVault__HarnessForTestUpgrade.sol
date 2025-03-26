// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__HarnessForTestUpgrade is IStakingVault, OwnableUpgradeable {
    /// @custom:storage-location erc7201:StakingVault.Vault
    struct VaultStorage {
        IStakingVault.Report report;
        uint128 locked;
        int128 inOutDelta;
        address nodeOperator;
    }

    uint64 private constant _version = 2;
    VaultHub private immutable VAULT_HUB;

    address public immutable DEPOSIT_CONTRACT;

    /// keccak256(abi.encode(uint256(keccak256("StakingVault.Vault")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant VAULT_STORAGE_LOCATION =
        0xe1d42fabaca5dacba3545b34709222773cbdae322fef5b060e1d691bf0169000;

    constructor(address _vaultHub, address _beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");
        if (_beaconChainDepositContract == address(0)) revert ZeroArgument("_beaconChainDepositContract");

        DEPOSIT_CONTRACT = _beaconChainDepositContract;
        VAULT_HUB = VaultHub(_vaultHub);

        // Prevents reinitialization of the implementation
        _disableInitializers();
    }

    function initialize(
        address _owner,
        address _nodeOperator,
        bytes calldata /* _params */
    ) external reinitializer(_version) {
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
        return address(0);
    }

    function finalizeUpgrade_v2() public reinitializer(_version) {
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
        return _version;
    }

    function latestReport() external view returns (IStakingVault.Report memory) {
        VaultStorage storage $ = _getVaultStorage();
        return IStakingVault.Report({valuation: $.report.valuation, inOutDelta: $.report.inOutDelta});
    }

    function _getVaultStorage() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE_LOCATION
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
