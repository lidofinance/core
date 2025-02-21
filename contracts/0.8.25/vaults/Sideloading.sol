// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";

import {ILido as IStETH} from "../interfaces/ILido.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ISideloader} from "../interfaces/ISideloader.sol";

abstract contract Sideloading is VaultHub {
    /**
     * @notice The storage structure:
     * - isSideloaderRegistryIgnored: whether the registry is ignored;
     *   if set to true, any address can be used as a sideloader;
     * - sideloaderRegistry: the registry of sideloaders;
     *   Returns true if the address can be used as a sideloader.
     */
    struct SideloadingStorage {
        bool isSideloaderRegistryIgnored;
        mapping(address sideloader => bool isRegistered) sideloaderRegistry;
    }

    /**
     * @notice The slot location of the contract storage for upgradability purposes.
     * @dev keccak256(abi.encode(uint256(keccak256("Sideloading")) - 1)) & ~bytes32(uint256(0xff))
     */
    bytes32 private constant SIDELOADING_STORAGE_LOCATION =
        0x2e546bfa3cf3c16f782948fc38bb4611e8b5e5bff64411c95e78608081ff5400;

    /**
     * @notice The value that must be returned by the `onSideload` function of the sideloader on success.
     */
    bytes32 private constant SIDELOADER_CALLBACK_SUCCESS = keccak256("Sideloader.onSideload");

    /**
     * @notice The role that ignores/respects the sideloader registry.
     */
    bytes32 public constant SIDELOADER_REGISTRY_SWITCH_ROLE = keccak256("Sideloading.RegistrySwitchRole");

    /**
     * @notice The role that registers and unregisters sideloaders.
     */
    bytes32 public constant SIDELOADER_REGISTRY_RECORD_ROLE = keccak256("Sideloading.RegistryRecordRole");

    /**
     * @notice The registry of sideloaders.
     *         Returns true if the address can be used as a sideloader.
     */
    mapping(address sideloader => bool isRegistered) public sideloaderRegistry;

    /**
     * @notice Constructor.
     * @param _stETH The address of the STETH contract.
     */
    constructor(IStETH _stETH) VaultHub(_stETH) {}

    /**
     * @notice Returns true if the sideloader registry is ignored and any address can be used as a sideloader.
     * @return True if the sideloader registry is ignored, false otherwise.
     */
    function isSideloaderRegistryIgnored() external view returns (bool) {
        return _getSideloadingStorage().isSideloaderRegistryIgnored;
    }

    /**
     * @notice Ignores the sideloader registry, allowing any address to be used as a sideloader.
     * @dev Only callable by the SIDELOADER_REGISTRY_SWITCH_ROLE.
     */
    function ignoreSideloaderRegistry() external onlyRole(SIDELOADER_REGISTRY_SWITCH_ROLE) {
        SideloadingStorage storage $ = _getSideloadingStorage();
        if ($.isSideloaderRegistryIgnored) revert SideloaderRegistryAlreadyIgnored();

        $.isSideloaderRegistryIgnored = true;

        emit SideloaderRegistryIgnored(msg.sender);
    }

    /**
     * @notice Returns true if the sideloader is registered.
     * @param _sideloader The address of the sideloader.
     * @return True if the sideloader is registered, false otherwise.
     */
    function isRegisteredSideloader(address _sideloader) external view returns (bool) {
        return _getSideloadingStorage().sideloaderRegistry[_sideloader];
    }

    /**
     * @notice Respects the sideloader registry, requiring addresses to be registered as sideloaders.
     * @dev Only callable by the SIDELOADER_REGISTRY_SWITCH_ROLE.
     */
    function respectSideloaderRegistry() external onlyRole(SIDELOADER_REGISTRY_SWITCH_ROLE) {
        SideloadingStorage storage $ = _getSideloadingStorage();
        if (!$.isSideloaderRegistryIgnored) revert SideloaderRegistryAlreadyRespected();

        $.isSideloaderRegistryIgnored = false;

        emit SideloaderRegistryRespected(msg.sender);
    }

    /**
     * @notice Register an address as a sideloader.
     * @param _sideloader The address of the recipient to register.
     */
    function registerSideloader(address _sideloader) external onlyRole(SIDELOADER_REGISTRY_RECORD_ROLE) {
        if (_sideloader == address(0)) revert ZeroArgument("_sideloader");

        SideloadingStorage storage $ = _getSideloadingStorage();
        if ($.sideloaderRegistry[_sideloader]) revert SideloaderAlreadyRegistered(_sideloader);

        $.sideloaderRegistry[_sideloader] = true;

        emit SideloaderRegistered(msg.sender, _sideloader);
    }

    /**
     * @notice Unregister an address as a sideloader.
     * @param _sideloader The address of the sideloader to unregister.
     */
    function unregisterSideloader(address _sideloader) external onlyRole(SIDELOADER_REGISTRY_RECORD_ROLE) {
        if (_sideloader == address(0)) revert ZeroArgument("_sideloader");

        SideloadingStorage storage $ = _getSideloadingStorage();
        if (!$.sideloaderRegistry[_sideloader]) revert SideloaderNotRegistered(_sideloader);

        delete $.sideloaderRegistry[_sideloader];

        emit SideloaderUnregistered(msg.sender, _sideloader);
    }

    /**
     * @notice Sideloads the vault valuation by minting shares to a sideloader.
     * @param _vault The address of the vault.
     * @param _sideloader The address of the sideloader.
     * @param _amountOfShares The amount of shares to mint for sideloading.
     * @param _data The data to pass to the sideloader.
     * @return True if the sideload was successful.
     */
    function sideload(
        address _vault,
        address _sideloader,
        uint256 _amountOfShares,
        bytes calldata _data
    ) external whenResumed returns (bool) {
        // * * * input validation * * *
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");
        _vaultAuth(_vault, "sideload");

        SideloadingStorage storage $ = _getSideloadingStorage();
        if ($.isSideloaderRegistryIgnored || !$.sideloaderRegistry[_sideloader]) {
            revert SideloaderNotRegistered(_sideloader);
        }

        // * * * sufficiency checks * * *
        VaultSocket storage socket = _connectedSocket(_vault);

        // cannot result in shares exceeding the share limit
        uint256 totalSharesAfterSideload = socket.sharesMinted + _amountOfShares;
        if (totalSharesAfterSideload > socket.shareLimit) revert ShareLimitExceeded(_vault, socket.shareLimit);

        uint256 totalEtherLocked = (STETH.getPooledEthByShares(totalSharesAfterSideload) * TOTAL_BASIS_POINTS) /
            (TOTAL_BASIS_POINTS - socket.reserveRatioBP);

        // extracting check to avoid stack too deep
        _ensureSufficientValuationBeforeSideload(_vault, totalSharesAfterSideload, totalEtherLocked);

        // update the shares minted BEFORE sideloading
        socket.sharesMinted = uint96(totalSharesAfterSideload);

        // update the locked amount BEFORE sideloading
        if (totalEtherLocked > IStakingVault(_vault).locked()) {
            IStakingVault(_vault).lock(totalEtherLocked);
        }

        // mint the shares to the recipient
        STETH.mintExternalShares(_sideloader, _amountOfShares);

        // call the recipient with the provided data
        if (
            ISideloader(_sideloader).onSideload(_vault, _sideloader, _amountOfShares, _data) !=
            SIDELOADER_CALLBACK_SUCCESS
        ) {
            revert SideloaderCallbackFailed(_sideloader, _data);
        }

        // extracting check to avoid stack too deep
        _ensureSufficientValuationAfterSideload(_vault);

        return true;
    }

    /**
     * @dev Ensures the valuation before sideloading is sufficient to cover the minimum reserve after sideloading.
     * @param _vault The address of the vault.
     * @param _totalSharesAfterSideload The total number of shares after sideloading.
     * @param _totalEtherLocked The total amount of ether to be locked in the vault.
     */
    function _ensureSufficientValuationBeforeSideload(
        address _vault,
        uint256 _totalSharesAfterSideload,
        uint256 _totalEtherLocked
    ) private view {
        uint256 minimumReserveAfterSideload = _totalEtherLocked - STETH.getPooledEthByShares(_totalSharesAfterSideload);

        // ensures the valuation BEFORE sideloading is sufficient to cover the minimum reserve AFTER sideloading
        if (IStakingVault(_vault).valuation() < minimumReserveAfterSideload) {
            revert InsufficientValuationBeforeSideload(
                _vault,
                minimumReserveAfterSideload,
                IStakingVault(_vault).valuation()
            );
        }
    }

    /**
     * @dev Ensures the valuation after sideloading is sufficient to cover the locked amount.
     * @param _vault The address of the vault.
     */
    function _ensureSufficientValuationAfterSideload(address _vault) private view {
        uint256 currentValuation = IStakingVault(_vault).valuation();
        uint256 lockedAmount = IStakingVault(_vault).locked();

        if (lockedAmount > currentValuation) {
            revert InsufficientValuationAfterSideload(_vault, lockedAmount, currentValuation);
        }
    }

    /**
     * @dev Returns the storage structure.
     * @return $ The storage structure.
     */
    function _getSideloadingStorage() private pure returns (SideloadingStorage storage $) {
        assembly {
            $.slot := SIDELOADING_STORAGE_LOCATION
        }
    }

    /**
     * @dev Emitted when the sideloader registry is ignored.
     * @param sender The address that ignored the registry.
     */
    event SideloaderRegistryIgnored(address indexed sender);

    /**
     * @dev Emitted when the sideloader registry is respected.
     * @param sender The address that respected the registry.
     */
    event SideloaderRegistryRespected(address indexed sender);

    /**
     * @dev Emitted when a sideloader is registered.
     * @param sender The address that registered the sideloader.
     * @param sideloader The address of the sideloader.
     */
    event SideloaderRegistered(address indexed sender, address indexed sideloader);

    /**
     * @dev Emitted when a sideloader is unregistered.
     * @param sender The address that unregistered the sideloader.
     * @param sideloader The address of the sideloader.
     */
    event SideloaderUnregistered(address indexed sender, address indexed sideloader);

    /**
     * @dev Error emitted when attempting to ignore the sideloader registry when it is already ignored.
     */
    error SideloaderRegistryAlreadyIgnored();

    /**
     * @dev Error emitted when attempting to respect the sideloader registry when it is already respected.
     */
    error SideloaderRegistryAlreadyRespected();

    /**
     * @dev Error emitted when attempting to register a sideloader that is already registered.
     */
    error SideloaderAlreadyRegistered(address _sideloader);

    /**
     * @dev Error emitted when attempting to use a sideloader that is not registered.
     */
    error SideloaderNotRegistered(address _sideloader);

    /**
     * @dev Error emitted when a sideloader callback fails.
     */
    error SideloaderCallbackFailed(address _sideloader, bytes _data);

    /**
     * @dev Error emitted when the valuation before sideloading is insufficient.
     * @param _vault The address of the vault.
     * @param _minimalValuationAfterSideload The minimal valuation of the vault after sideloading.
     * @param _actualValuationBeforeSideload The actual valuation of the vault before sideloading.
     */
    error InsufficientValuationBeforeSideload(
        address _vault,
        uint256 _minimalValuationAfterSideload,
        uint256 _actualValuationBeforeSideload
    );

    /**
     * @dev Error emitted when the valuation after sideloading is insufficient.
     * @param _vault The address of the vault.
     * @param _minimalValuationAfterSideload The minimal valuation of the vault after sideloading.
     * @param _actualValuationAfterSideload The actual valuation of the vault after sideloading.
     */
    error InsufficientValuationAfterSideload(
        address _vault,
        uint256 _minimalValuationAfterSideload,
        uint256 _actualValuationAfterSideload
    );
}
