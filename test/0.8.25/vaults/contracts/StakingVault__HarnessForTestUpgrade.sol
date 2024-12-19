// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.0.2/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts-v5.0.2/token/ERC20/IERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts-v5.0.2/proxy/ERC1967/ERC1967Utils.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IReportReceiver} from "contracts/0.8.25/vaults/interfaces/IReportReceiver.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {IBeaconProxy} from "contracts/0.8.25/vaults/interfaces/IBeaconProxy.sol";
import {BeaconChainDepositLogistics} from "contracts/0.8.25/vaults/BeaconChainDepositLogistics.sol";

contract StakingVault__HarnessForTestUpgrade is IBeaconProxy, BeaconChainDepositLogistics, OwnableUpgradeable {
    /// @custom:storage-location erc7201:StakingVault.Vault
    struct VaultStorage {
        uint128 reportValuation;
        int128 reportInOutDelta;

        uint256 locked;
        int256 inOutDelta;

        address operator;
    }

    uint64 private constant _version = 2;
    VaultHub public immutable vaultHub;

    /// keccak256(abi.encode(uint256(keccak256("StakingVault.Vault")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant VAULT_STORAGE_LOCATION =
    0xe1d42fabaca5dacba3545b34709222773cbdae322fef5b060e1d691bf0169000;

    constructor(
        address _vaultHub,
        address _beaconChainDepositContract
    ) BeaconChainDepositLogistics(_beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");

        vaultHub = VaultHub(_vaultHub);
    }

    modifier onlyBeacon() {
        if (msg.sender != getBeacon()) revert UnauthorizedSender(msg.sender);
        _;
    }

    /// @notice Initialize the contract storage explicitly.
    /// @param _owner owner address that can TBD
    /// @param - the calldata for initialize contract after upgrades
    function initialize(address _owner, address _operator, bytes calldata /* _params */) external onlyBeacon reinitializer(_version) {
        __StakingVault_init_v2();
        __Ownable_init(_owner);
        _getVaultStorage().operator = _operator;
    }

    function operator() external view returns (address) {
        return _getVaultStorage().operator;
    }

    function finalizeUpgrade_v2() public reinitializer(_version) {
        __StakingVault_init_v2();
    }

    event InitializedV2();
    function __StakingVault_init_v2() internal  {
        emit InitializedV2();
    }

    function getInitializedVersion() public view returns (uint64) {
        return _getInitializedVersion();
    }

    function version() external pure virtual returns(uint64) {
        return _version;
    }

    function getBeacon() public view returns (address) {
        return ERC1967Utils.getBeacon();
    }

    function latestReport() external view returns (IStakingVault.Report memory) {
        VaultStorage storage $ = _getVaultStorage();
        return IStakingVault.Report({
            valuation: $.reportValuation,
            inOutDelta: $.reportInOutDelta
        });
    }

    function _getVaultStorage() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE_LOCATION
        }
    }

    error ZeroArgument(string name);
    error UnauthorizedSender(address sender);
}
