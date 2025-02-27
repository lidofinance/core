// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";

import {ILido as IStETH} from "../interfaces/ILido.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ISideloader} from "../interfaces/ISideloader.sol";

/**
 * @title Sideloading
 * @author Lido
 * @notice Inspired by ERC-3156: Flash Loans, Sideloading allows a vault to sideload its valuation
 *         by minting stETH that must be retroactively backed within the same transaction.
 */
contract Sideloading is VaultHub {
    /**
     * @notice The storage structure:
     * - sideloaderRegistry: the registry of sideloaders;
     *   Returns true if the address can be used as a sideloader.
     * - isSideloaderRegistryIgnored: whether the registry is ignored;
     *   if set to true, any address can be used as a sideloader.
     */
    struct SideloadingStorage {
        mapping(address sideloader => bool isRegistered) sideloaderRegistry;
        bool isSideloaderRegistryIgnored;
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
     * @notice Constructor.
     * @param _stETH The address of the STETH contract.
     */
    constructor(IStETH _stETH) VaultHub(_stETH) {}

    /**
     * @notice Initializes the contract.
     * @param _admin The address of the admin.
     */
    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __VaultHub_init(_admin);
    }

    /**
     * @notice Returns true if the sideloader registry is ignored and any address can be used as a sideloader.
     * @return True if the sideloader registry is ignored, false otherwise.
     */
    function isSideloaderRegistryIgnored() external view returns (bool) {
        return _getSideloadingStorage().isSideloaderRegistryIgnored;
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
     * @param _sideloader The address of the sideloader to register.
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
     * @notice Sideloads the vault valuation by minting shares to a sideloader and invoking the callback.
     *
     * @dev Sideloading is a mechanism that allows vaults to temporarily mint unbacked stETH
     * shares for immediate use, with the requirement that sufficient backing must be added to the vault
     * during the same transaction. This creates a flash-loan-like mechanism specific to stVaults.
     *
     * Sideloading process:
     *  1. Verifies sufficient valuation on the vault to cover the post-sideloaded minimal reserve
     *  2. Mints unbacked stETH shares directly to a registered sideloader contract
     *  3. Invokes the callback function on the sideloader, which must use these shares to obtain
     *     sufficient ETH to retroactively back the newly minted shares
     *  4. Verifies that the vault's final valuation meets the required backing
     *
     *
     * NB: While it might appear redundant to verify both initial and final valuations (since only the final state
     * matters for solvency), the initial reserve check serves as a critical security measure for preventing
     * "free value extraction" scenarios by ensuring the vault already has substantial skin in the game.
     * Sideloading is specifically designed for boosting vault valuation, not for value extraction opportunities,
     * and this check ensures that value cannot be bootstrapped out of nothing.
     *
     * The full flow is as follows:
     *
     *   +---------------+              +-------------+    2. check minimal reserve
     *   |               |  1. sideload |             |    6. check required valuation
     *   | StVault Owner |+------------>| Sideloading |-------------|
     *   |               |              |             |             |
     *   +---------------+              +-------------+             |
     *                                   |                          |
     *                                   |  3. mint stETH (shares)  |
     *                                   |     & callback           |
     *                                   |                          |
     *                                   v                          v
     *   +---------------+              +------------+            +---------+
     *   |               |              |            |            |         |
     *   |   e.g. DEX    |<------------ | Sideloader |----------->| stVault |
     *   |               |   4. swap    |            |  5. fund   |         |
     *   +---------------+      to ETH  +------------+            +---------+
     *
     * Practical example:
     *  - Vault has 100 ETH current valuation, and the limit of 1000 stETH mintable
     *  - Reserve ratio (RR) is 10%, meaning vault must have 10% of the total value as a safety margin
     *  - Vault owner wants to mint 900 more stETH
     *  - Total value after minting: 1000 ETH (900 stETH + 100 ETH)
     *  - Minimal reserve needed: 1000 * 10% = 100 ETH
     *  - Initial valuation check: Is current valuation (100 ETH) >= minimal reserve (100 ETH)? Yes
     *  - StETH is minted to the sideloader
     *  - Sideloader swaps/borrows 900 stETH for ETH, and funds the vault
     *  - Vault now has 1000 ETH of valuation, exact amount of required backing for 900 stETH (at 10% RR)
     *  - Sideloading succeeds
     *
     * @param _vault The address of the vault to sideload from.
     * @param _sideloader The address of the registered sideloader contract that will receive the minted shares.
     * @param _amountOfShares The amount of stETH shares to mint for sideloading.
     * @param _data The arbitrary data to pass to the sideloader's callback function.
     * @return True if the sideload operation was successful.
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
        if (!$.isSideloaderRegistryIgnored && !$.sideloaderRegistry[_sideloader]) {
            revert SideloaderNotRegistered(_sideloader);
        }

        // * * * sufficiency checks * * *
        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 totalSharesAfterSideload = socket.sharesMinted + _amountOfShares;

        // cannot result in shares exceeding the share limit
        if (totalSharesAfterSideload > socket.shareLimit) revert ShareLimitExceeded(_vault, socket.shareLimit);

        uint256 totalStETHAfterSideload = STETH.getPooledEthByShares(totalSharesAfterSideload);
        uint256 minimalReserveAfterSideload = (totalStETHAfterSideload * socket.reserveRatioBP) /
            (TOTAL_BASIS_POINTS - socket.reserveRatioBP);

        // ensure the valuation before sideloading is sufficient to cover the minimal reserve after sideloading
        if (IStakingVault(_vault).valuation() < minimalReserveAfterSideload) {
            revert InsufficientValuationBeforeSideload(
                _vault,
                minimalReserveAfterSideload,
                IStakingVault(_vault).valuation()
            );
        }

        uint256 totalEtherLocked = totalStETHAfterSideload + minimalReserveAfterSideload;

        // update the shares minted BEFORE sideloading
        socket.sharesMinted = uint96(totalSharesAfterSideload);

        // update the locked amount BEFORE sideloading
        if (totalEtherLocked > IStakingVault(_vault).locked()) {
            IStakingVault(_vault).lock(totalEtherLocked);
        }

        // mint the shares to the sideloader
        STETH.mintExternalShares(_sideloader, _amountOfShares);

        // call the sideloader with the provided data
        if (
            ISideloader(_sideloader).onSideload(_vault, _sideloader, _amountOfShares, _data) !=
            SIDELOADER_CALLBACK_SUCCESS
        ) {
            revert SideloaderCallbackFailed(_sideloader, _data);
        }

        // ensure the valuation after sideloading is sufficient to cover the locked amount
        if (IStakingVault(_vault).locked() > IStakingVault(_vault).valuation()) {
            revert InsufficientValuationAfterSideload(
                _vault,
                IStakingVault(_vault).locked(),
                IStakingVault(_vault).valuation()
            );
        }

        return true;
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
