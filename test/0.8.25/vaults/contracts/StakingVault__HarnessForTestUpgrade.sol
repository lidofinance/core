// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.0.2/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts-v5.0.2/token/ERC20/IERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts-v5.0.2/proxy/ERC1967/ERC1967Utils.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IReportReceiver} from "contracts/0.8.25/vaults/interfaces/IReportReceiver.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {IBeaconProxy} from "contracts/0.8.25/vaults/interfaces/IBeaconProxy.sol";
import {VaultBeaconChainDepositor} from "contracts/0.8.25/vaults/VaultBeaconChainDepositor.sol";
import {Versioned} from "contracts/0.8.25/utils/Versioned.sol";

contract StakingVault__HarnessForTestUpgrade is IBeaconProxy, VaultBeaconChainDepositor, OwnableUpgradeable, Versioned {
    /// @custom:storage-location erc7201:StakingVault.Vault
    struct VaultStorage {
        uint128 reportValuation;
        int128 reportInOutDelta;

        uint256 locked;
        int256 inOutDelta;
    }

    uint256 private constant _version = 2;
    VaultHub public immutable vaultHub;
    IERC20 public immutable stETH;

    /// keccak256(abi.encode(uint256(keccak256("StakingVault.Vault")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant VAULT_STORAGE_LOCATION =
    0xe1d42fabaca5dacba3545b34709222773cbdae322fef5b060e1d691bf0169000;

    constructor(
        address _vaultHub,
        address _stETH,
        address _beaconChainDepositContract
    ) VaultBeaconChainDepositor(_beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");
        if (_stETH == address(0)) revert ZeroArgument("_stETH");

        vaultHub = VaultHub(_vaultHub);
        stETH = IERC20(_stETH);
    }

    /// @notice Initialize the contract storage explicitly.
    /// @param _owner owner address that can TBD
    function initialize(address _owner, bytes calldata params) external {
        if (_owner == address(0)) revert ZeroArgument("_owner");
        if (getBeacon() == address(0)) revert NonProxyCall();

        _initializeContractVersionTo(2);

        _transferOwnership(_owner);
    }

    function finalizeUpgrade_v2() external {
        if (getContractVersion() == _version) {
            revert AlreadyInitialized();
        }
    }

    function version() external pure virtual returns(uint256) {
        return _version;
    }

    function getBeacon() public view returns (address) {
        return ERC1967Utils.getBeacon();
    }

    function _getVaultStorage() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE_LOCATION
        }
    }

    error ZeroArgument(string name);
    error NonProxyCall();
    error AlreadyInitialized();
}
