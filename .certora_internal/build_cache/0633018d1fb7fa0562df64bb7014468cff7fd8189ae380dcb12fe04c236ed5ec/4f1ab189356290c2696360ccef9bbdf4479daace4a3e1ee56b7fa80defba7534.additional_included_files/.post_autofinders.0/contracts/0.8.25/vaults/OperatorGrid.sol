// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";

import {Math256} from "contracts/common/lib/Math256.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {Confirmable2Addresses} from "../utils/Confirmable2Addresses.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {VaultHub} from "./VaultHub.sol";


struct TierParams {
    uint256 shareLimit;
    uint256 reserveRatioBP;
    uint256 forcedRebalanceThresholdBP;
    uint256 infraFeeBP;
    uint256 liquidityFeeBP;
    uint256 reservationFeeBP;
}

/**
 * @title OperatorGrid
 * @author loga4
 * @notice
 * OperatorGrid is a contract that manages mint parameters for vaults when they are connected to the VaultHub.
 * These parameters include:
 * - shareLimit: maximum amount of shares that can be minted
 * - reserveRatioBP: reserve ratio in basis points
 * - forcedRebalanceThresholdBP: forced rebalance threshold in basis points
 * - infraFeeBP: infra fee in basis points
 * - liquidityFeeBP: liquidity fee in basis points
 * - reservationFeeBP: reservation fee in basis points
 *
 * These parameters are determined by the Tier in which the Vault is registered.
 *
 */
contract OperatorGrid is AccessControlEnumerableUpgradeable, Confirmable2Addresses {
    /*
      Key concepts:
      1. Default Registration:
         - All Vaults initially have default tier (DEFAULT_TIER_ID = 0)
         - The default tier has no group

         DEFAULT_TIER_ID = 0
        ┌──────────────────────┐
        │        Tier 1        │
        │  tierShareLimit = z  │
        │  Vault_1 ... Vault_m │
        └──────────────────────┘

       2. Tier Change Process:
         - To predefine vaults tier or modify the existing vault's connection parameters to VaultHub, a tier change must be requested
         - Both vault owner and node operator must confirm the change (doesn't matter who confirms first)
         - The confirmation has an expiry time (default 1 hour)

       3. Tier Reset:
         - When a vault is disconnected from VaultHub, its tier is automatically reset to the default tier (DEFAULT_TIER_ID)

       4. Tier Capacity:
         - Tiers are not limited by the number of vaults
         - Tiers are limited by the sum of vaults' liability shares
         - Administrative operations (like bad debt socialization) can bypass tier/group limits

        ┌──────────────────────────────────────────────────────┐
        │                 Group 1 = operator 1                 │
        │  ┌────────────────────────────────────────────────┐  │
        │  │  groupShareLimit = 1kk                         │  │
        │  └────────────────────────────────────────────────┘  │
        │  ┌──────────────────────┐  ┌──────────────────────┐  │
        │  │       Tier 1         │  │       Tier 2         │  │
        │  │  tierShareLimit = x  │  │  tierShareLimit = y  │  │
        │  │  Vault_2 ... Vault_k │  │                      │  │
        │  └──────────────────────┘  └──────────────────────┘  │
        └──────────────────────────────────────────────────────┘

        5. Jail Mechanism:
         - A vault can be "jailed" as a penalty mechanism for misbehavior or violations
         - When a vault is in jail, it cannot mint new stETH shares (normal minting operations are blocked)
         - Vaults can be jailed/unjailed by addresses with appropriate governance roles
         - Administrative operations (like bad debt socialization) can bypass jail restrictions
     */

    /// @dev 0xa495a3428837724c7f7648cda02eb83c9c4c778c8688d6f254c7f3f80c154d55
    bytes32 public constant REGISTRY_ROLE = keccak256("vaults.OperatorsGrid.Registry");

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;

    uint256 public constant DEFAULT_TIER_ID = 0;

    // Special address to denote that default tier is not linked to any real operator
    address public constant DEFAULT_TIER_OPERATOR = address(uint160(type(uint160).max));

    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    /// @dev max value for fees in basis points - it's about 650%
    uint256 internal constant MAX_FEE_BP = type(uint16).max;
    /// @dev max value for reserve ratio in basis points - 9999
    uint256 internal constant MAX_RESERVE_RATIO_BP = 99_99;

    // -----------------------------
    //            STRUCTS
    // -----------------------------
    struct Group {
        address operator;
        uint96 shareLimit;
        uint96 liabilityShares;
        uint256[] tierIds;
    }

    struct Tier {
        address operator;
        uint96 shareLimit;
        uint96 liabilityShares;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 infraFeeBP;
        uint16 liquidityFeeBP;
        uint16 reservationFeeBP;
    }

    /**
     * @notice ERC-7201 storage namespace for the OperatorGrid
     * @dev ERC-7201 namespace is used to prevent upgrade collisions
     * @custom:storage-location erc7201:Lido.Vaults.OperatorGrid
     * @custom:tiers Tiers
     * @custom:vaultTier Vault tier
     * @custom:groups Groups
     * @custom:nodeOperators Node operators
     * @custom:isVaultInJail if true, vault is in jail and can't mint stETH
     */
    struct ERC7201Storage {
        Tier[] tiers;
        mapping(address vault => uint256 tierId) vaultTier;
        mapping(address nodeOperator => Group) groups;
        address[] nodeOperators;
        mapping(address vault => bool isInJail) isVaultInJail;
    }

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         keccak256(abi.encode(uint256(keccak256("Lido.Vaults.OperatorGrid")) - 1)) & ~bytes32(uint256(0xff))
     */
    bytes32 private constant OPERATOR_GRID_STORAGE_LOCATION =
        0x6b64617c951381e2c1eff2be939fe368ab6d76b7d335df2e47ba2309eba1c700;


    /// @notice Initializes the contract with a LidoLocator
    /// @param _locator LidoLocator contract
    constructor(ILidoLocator _locator) {
        LIDO_LOCATOR = _locator;

        _disableInitializers();
    }

    /// @notice Initializes the contract with an admin
    /// @param _admin Address of the admin
    /// @param _defaultTierParams Default tier params for the default tier
    function initialize(address _admin, TierParams calldata _defaultTierParams) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __AccessControlEnumerable_init();
        __Confirmations_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        _validateParams(
            DEFAULT_TIER_ID,
            _defaultTierParams.reserveRatioBP,
            _defaultTierParams.forcedRebalanceThresholdBP,
            _defaultTierParams.infraFeeBP,
            _defaultTierParams.liquidityFeeBP,
            _defaultTierParams.reservationFeeBP
        );

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001005a,0)}

        //create default tier with default share limit
        $.tiers.push(
            Tier({
                operator: DEFAULT_TIER_OPERATOR,
                shareLimit: SafeCast.toUint96(_defaultTierParams.shareLimit),
                reserveRatioBP: uint16(_defaultTierParams.reserveRatioBP),
                forcedRebalanceThresholdBP: uint16(_defaultTierParams.forcedRebalanceThresholdBP),
                infraFeeBP: uint16(_defaultTierParams.infraFeeBP),
                liquidityFeeBP: uint16(_defaultTierParams.liquidityFeeBP),
                reservationFeeBP: uint16(_defaultTierParams.reservationFeeBP),
                liabilityShares: 0
            })
        );
    }

    /// @notice Sets the confirmation expiry period
    /// @param _newConfirmExpiry The new confirmation expiry period in seconds
    function setConfirmExpiry(uint256 _newConfirmExpiry) external onlyRole(REGISTRY_ROLE) {
        _setConfirmExpiry(_newConfirmExpiry);
    }

    /// @notice Registers a new group
    /// @param _nodeOperator address of the node operator
    /// @param _shareLimit Maximum share limit for the group
    function registerGroup(address _nodeOperator, uint256 _shareLimit) external onlyRole(REGISTRY_ROLE) {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001005b,0)}
        if ($.groups[_nodeOperator].operator != address(0)) revert GroupExists();

        $.groups[_nodeOperator] = Group({
            operator: _nodeOperator,
            shareLimit: SafeCast.toUint96(_shareLimit),
            liabilityShares: 0,
            tierIds: new uint256[](0)
        });assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0002008d,0)}
        $.nodeOperators.push(_nodeOperator);

        emit GroupAdded(_nodeOperator, _shareLimit);
    }

    /// @notice Updates the share limit of a group
    /// @param _nodeOperator address of the node operator
    /// @param _shareLimit New share limit value
    function updateGroupShareLimit(address _nodeOperator, uint256 _shareLimit) external onlyRole(REGISTRY_ROLE) {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001005c,0)}
        Group storage group_ = $.groups[_nodeOperator];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001005d,0)}
        if (group_.operator == address(0)) revert GroupNotExists();

        group_.shareLimit = SafeCast.toUint96(_shareLimit);uint96 certora_local142 = group_.shareLimit;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000008e,certora_local142)}

        emit GroupShareLimitUpdated(_nodeOperator, _shareLimit);
    }

    /// @notice Returns a group by node operator address
    /// @param _nodeOperator address of the node operator
    /// @return Group
    function group(address _nodeOperator) external view returns (Group memory) {
        return _getStorage().groups[_nodeOperator];
    }

    /// @notice Returns a node operator address by index
    /// @param _index index of the node operator
    /// @return Node operator address
    function nodeOperatorAddress(uint256 _index) external view returns (address) {
        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001005e,0)}
        if (_index >= $.nodeOperators.length) revert NodeOperatorNotExists();
        return $.nodeOperators[_index];
    }

    /// @notice Returns a node operator count
    /// @return Node operator count
    function nodeOperatorCount() external view returns (uint256) {
        return _getStorage().nodeOperators.length;
    }

    /// @notice Registers a new tier
    /// @param _nodeOperator address of the node operator
    /// @param _tiers array of tiers to register
    function registerTiers(
        address _nodeOperator,
        TierParams[] calldata _tiers
    ) external onlyRole(REGISTRY_ROLE) {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001005f,0)}
        Group storage group_ = $.groups[_nodeOperator];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010060,0)}
        if (group_.operator == address(0)) revert GroupNotExists();

        uint256 tierId = $.tiers.length;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000061,tierId)}
        uint256 length = _tiers.length;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000062,length)}
        for (uint256 i = 0; i < length; i++) {
            _validateParams(
                tierId,
                _tiers[i].reserveRatioBP,
                _tiers[i].forcedRebalanceThresholdBP,
                _tiers[i].infraFeeBP,
                _tiers[i].liquidityFeeBP,
                _tiers[i].reservationFeeBP
            );

            Tier memory tier_ = Tier({
                operator: _nodeOperator,
                shareLimit: SafeCast.toUint96(_tiers[i].shareLimit),
                reserveRatioBP: uint16(_tiers[i].reserveRatioBP),
                forcedRebalanceThresholdBP: uint16(_tiers[i].forcedRebalanceThresholdBP),
                infraFeeBP: uint16(_tiers[i].infraFeeBP),
                liquidityFeeBP: uint16(_tiers[i].liquidityFeeBP),
                reservationFeeBP: uint16(_tiers[i].reservationFeeBP),
                liabilityShares: 0
            });assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000100a2,0)}
            $.tiers.push(tier_);
            group_.tierIds.push(tierId);

            emit TierAdded(
                _nodeOperator,
                tierId,
                tier_.shareLimit,
                tier_.reserveRatioBP,
                tier_.forcedRebalanceThresholdBP,
                tier_.infraFeeBP,
                tier_.liquidityFeeBP,
                tier_.reservationFeeBP
            );

            tierId++;
        }
    }

    /// @notice Returns a tier by ID
    /// @param _tierId id of the tier
    /// @return Tier
    function tier(uint256 _tierId) external view returns (Tier memory) {
        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010063,0)}
        if (_tierId >= $.tiers.length) revert TierNotExists();
        return $.tiers[_tierId];
    }

    /// @notice Returns a tiers count
    /// @return Tiers count
    function tiersCount() external view returns (uint256) {
        return _getStorage().tiers.length;
    }

    /// @notice Alters multiple tiers
    /// @dev We do not enforce to update old vaults with the new tier params, only new ones.
    /// @param _tierIds array of tier ids to alter
    /// @param _tierParams array of new tier params
    function alterTiers(
        uint256[] calldata _tierIds,
        TierParams[] calldata _tierParams
    ) external onlyRole(REGISTRY_ROLE) {
        if (_tierIds.length != _tierParams.length) revert ArrayLengthMismatch();

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010064,0)}
        uint256 length = _tierIds.length;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000065,length)}
        uint256 tiersLength = $.tiers.length;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000066,tiersLength)}

        for (uint256 i = 0; i < length; i++) {
            if (_tierIds[i] >= tiersLength) revert TierNotExists();

            _validateParams(
                _tierIds[i],
                _tierParams[i].reserveRatioBP,
                _tierParams[i].forcedRebalanceThresholdBP,
                _tierParams[i].infraFeeBP,
                _tierParams[i].liquidityFeeBP,
                _tierParams[i].reservationFeeBP
            );

            Tier storage tier_ = $.tiers[_tierIds[i]];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000100a3,0)}

            tier_.shareLimit = SafeCast.toUint96(_tierParams[i].shareLimit);uint96 certora_local164 = tier_.shareLimit;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000000a4,certora_local164)}
            tier_.reserveRatioBP = uint16(_tierParams[i].reserveRatioBP);uint16 certora_local165 = tier_.reserveRatioBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000000a5,certora_local165)}
            tier_.forcedRebalanceThresholdBP = uint16(_tierParams[i].forcedRebalanceThresholdBP);uint16 certora_local166 = tier_.forcedRebalanceThresholdBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000000a6,certora_local166)}
            tier_.infraFeeBP = uint16(_tierParams[i].infraFeeBP);uint16 certora_local167 = tier_.infraFeeBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000000a7,certora_local167)}
            tier_.liquidityFeeBP = uint16(_tierParams[i].liquidityFeeBP);uint16 certora_local168 = tier_.liquidityFeeBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000000a8,certora_local168)}
            tier_.reservationFeeBP = uint16(_tierParams[i].reservationFeeBP);uint16 certora_local169 = tier_.reservationFeeBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000000a9,certora_local169)}

            emit TierUpdated(
                _tierIds[i],
                tier_.shareLimit,
                tier_.reserveRatioBP,
                tier_.forcedRebalanceThresholdBP,
                tier_.infraFeeBP,
                tier_.liquidityFeeBP,
                tier_.reservationFeeBP
            );
        }
    }

    /*

    Legend:
    V = Vault1.liabilityShares
    LS = liabilityShares

    Scheme1 - transfer Vault from default tier to Tier2

                                         ┌──────────────────────────────┐
                                         │           Group 1            │
                                         │                              │
    ┌────────────────────┐               │  ┌─────────┐  ┌───────────┐  │
    │  Tier 1 (default)  │   confirm     │  │ Tier 2  │  │ Tier 3    │  │
    │  LS: -V            │    ─────>     │  │ LS:+V   │  │           │  │
    └────────────────────┘               │  └─────────┘  └───────────┘  │
                                         │                              │
                                         │   Group1.liabilityShares: +V │
                                         └──────────────────────────────┘

    After confirmation:
    - Tier 1.liabilityShares   = -V
    - Tier 2.liabilityShares   = +V
    - Group1.liabilityShares   = +V

    --------------------------------------------------------------------------
    Scheme2 - transfer Vault from Tier2 to Tier3, no need to change group minted shares

    ┌────────────────────────────────┐     ┌────────────────────────────────┐
    │           Group 1              │     │           Group 2              │
    │                                │     │                                │
    │  ┌───────────┐  ┌───────────┐  │     │  ┌───────────┐                 │
    │  │ Tier 2    │  │ Tier 3    │  │     │  │ Tier 4    │                 │
    │  │ LS:-V     │  │ LS:+V     │  │     │  │           │                 │
    │  └───────────┘  └───────────┘  │     │  └───────────┘                 │
    │  operator1                     │     │  operator2                     │
    └────────────────────────────────┘     └────────────────────────────────┘

    After confirmation:
    - Tier 2.liabilityShares   = -V
    - Tier 3.liabilityShares   = +V

    NB: Cannot change from Tier2 to Tier1, because Tier1 has no group
    NB: Cannot change from Tier2 to Tier4, because Tier4 has different operator.

    */
    /// @notice Vault tier change with multi-role confirmation
    /// @param _vault address of the vault
    /// @param _requestedTierId id of the tier
    /// @param _requestedShareLimit share limit to set
    /// @return bool Whether the tier change was executed.
    /// @dev Node operator confirmation can be collected even if the vault is disconnected
    /// @dev Requires vault to be connected to VaultHub to finalize tier change from the vault owner side.
    /// @dev Both vault owner (via Dashboard) and node operator confirmations are required.
    function changeTier(
        address _vault,
        uint256 _requestedTierId,
        uint256 _requestedShareLimit
    ) external returns (bool) {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010067,0)}
        if (_requestedTierId >= $.tiers.length) revert TierNotExists();
        if (_requestedTierId == DEFAULT_TIER_ID) revert CannotChangeToDefaultTier();

        VaultHub vaultHub = _vaultHub();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010068,0)}

        uint256 vaultTierId = $.vaultTier[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000069,vaultTierId)}
        if (vaultTierId == _requestedTierId) revert TierAlreadySet();

        address nodeOperator = IStakingVault(_vault).nodeOperator();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000006a,nodeOperator)}
        // we allow node operator to pre-approve not connected vaults
        if (msg.sender != nodeOperator && !vaultHub.isVaultConnected(_vault)) revert VaultNotConnected();

        Tier storage requestedTier = $.tiers[_requestedTierId];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001006b,0)}
        if (nodeOperator != requestedTier.operator) revert TierNotInOperatorGroup();
        if (_requestedShareLimit > requestedTier.shareLimit) {
            revert RequestedShareLimitTooHigh(_requestedShareLimit, requestedTier.shareLimit);
        }

        uint256 vaultLiabilityShares = vaultHub.liabilityShares(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000006c,vaultLiabilityShares)}

        if (_requestedShareLimit < vaultLiabilityShares) {
            revert RequestedShareLimitTooLow(_requestedShareLimit, vaultLiabilityShares);
        }

        address vaultOwner = vaultHub.vaultConnection(_vault).owner;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000006d,vaultOwner)}
        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, vaultOwner, nodeOperator)) return false;

        // check if tier limit is exceeded
        if (requestedTier.liabilityShares + vaultLiabilityShares > requestedTier.shareLimit) revert TierLimitExceeded();

        // if the vault was in the default tier:
        // - that mean that the vault has no group, so we decrease only the minted shares of the default tier
        // - but need to check requested group limit exceeded
        if (vaultTierId == DEFAULT_TIER_ID) {
            Group storage requestedGroup = $.groups[nodeOperator];
            if (requestedGroup.liabilityShares + vaultLiabilityShares > requestedGroup.shareLimit) {
                revert GroupLimitExceeded();
            }
            requestedGroup.liabilityShares += uint96(vaultLiabilityShares);
        }

        Tier storage currentTier = $.tiers[vaultTierId];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001006e,0)}

        currentTier.liabilityShares -= uint96(vaultLiabilityShares);uint96 certora_local143 = currentTier.liabilityShares;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000008f,certora_local143)}
        requestedTier.liabilityShares += uint96(vaultLiabilityShares);uint96 certora_local144 = requestedTier.liabilityShares;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000090,certora_local144)}

        $.vaultTier[_vault] = _requestedTierId;uint256 certora_local145 = $.vaultTier[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000091,certora_local145)}

        vaultHub.updateConnection(
            _vault,
            _requestedShareLimit,
            requestedTier.reserveRatioBP,
            requestedTier.forcedRebalanceThresholdBP,
            requestedTier.infraFeeBP,
            requestedTier.liquidityFeeBP,
            requestedTier.reservationFeeBP
        );

        emit TierChanged(_vault, _requestedTierId, _requestedShareLimit);

        return true;
    }

    /// @notice Syncs vault tier with current tier params
    /// @param _vault address of the vault
    /// @return bool Whether the sync was executed.
    /// @dev Requires vault to be connected to VaultHub.
    /// @dev Both vault owner (via Dashboard) and node operator confirmations are required.
    function syncTier(address _vault) external returns (bool) {
        (VaultHub vaultHub, VaultHub.VaultConnection memory vaultConnection,
        address vaultOwner, address nodeOperator, uint256 vaultTierId) = _getVaultContextForConnectedVault(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001006f,0)}

        Tier storage tier_ = _getStorage().tiers[vaultTierId];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010070,0)}

        if (
            vaultConnection.reserveRatioBP == tier_.reserveRatioBP &&
            vaultConnection.forcedRebalanceThresholdBP == tier_.forcedRebalanceThresholdBP &&
            vaultConnection.infraFeeBP == tier_.infraFeeBP &&
            vaultConnection.liquidityFeeBP == tier_.liquidityFeeBP &&
            vaultConnection.reservationFeeBP == tier_.reservationFeeBP
        ) {
            revert VaultAlreadySyncedWithTier();
        }

        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, vaultOwner, nodeOperator)) return false;

        vaultHub.updateConnection(
            _vault,
            vaultConnection.shareLimit,
            tier_.reserveRatioBP,
            tier_.forcedRebalanceThresholdBP,
            tier_.infraFeeBP,
            tier_.liquidityFeeBP,
            tier_.reservationFeeBP
        );

        return true;
    }

    /// @notice Update vault share limit
    /// @param _vault address of the vault
    /// @param _requestedShareLimit share limit to set
    /// @return bool Whether the update was executed.
    /// @dev Requires vault to be connected to VaultHub.
    /// @dev Both vault owner (via Dashboard) and node operator confirmations are required.
    function updateVaultShareLimit(address _vault, uint256 _requestedShareLimit) external returns (bool) {
        (VaultHub vaultHub, VaultHub.VaultConnection memory vaultConnection,
        address vaultOwner, address nodeOperator, uint256 vaultTierId) = _getVaultContextForConnectedVault(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010071,0)}

        uint256 tierShareLimit = _getStorage().tiers[vaultTierId].shareLimit;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000072,tierShareLimit)}

        if (_requestedShareLimit > tierShareLimit) revert RequestedShareLimitTooHigh(_requestedShareLimit, tierShareLimit);
        if (_requestedShareLimit == vaultConnection.shareLimit) revert ShareLimitAlreadySet();

        uint256 vaultLiabilityShares = vaultHub.liabilityShares(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000073,vaultLiabilityShares)}

        if (_requestedShareLimit < vaultLiabilityShares) {
            revert RequestedShareLimitTooLow(_requestedShareLimit, vaultLiabilityShares);
        }

        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, vaultOwner, nodeOperator)) return false;

        vaultHub.updateConnection(
            _vault,
            _requestedShareLimit,
            vaultConnection.reserveRatioBP,
            vaultConnection.forcedRebalanceThresholdBP,
            vaultConnection.infraFeeBP,
            vaultConnection.liquidityFeeBP,
            vaultConnection.reservationFeeBP
        );

        return true;
    }

    /// @notice Reset vault's tier to default
    /// @param _vault address of the vault
    /// @dev Requires vault's liabilityShares to be zero before resetting the tier
    function resetVaultTier(address _vault) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("resetVaultTier", msg.sender);

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010074,0)}

        if ($.vaultTier[_vault] != DEFAULT_TIER_ID) {
            $.vaultTier[_vault] = DEFAULT_TIER_ID;

            emit TierChanged(_vault, DEFAULT_TIER_ID, $.tiers[DEFAULT_TIER_ID].shareLimit);
        }
    }

    /// @notice updates fees for the vault
    /// @param _vault vault address
    /// @param _infraFeeBP new infra fee in basis points
    /// @param _liquidityFeeBP new liquidity fee in basis points
    /// @param _reservationFeeBP new reservation fee in basis points
    function updateVaultFees(
        address _vault,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) external onlyRole(REGISTRY_ROLE) {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        _requireLessOrEqToBP(_infraFeeBP, MAX_FEE_BP);
        _requireLessOrEqToBP(_liquidityFeeBP, MAX_FEE_BP);
        _requireLessOrEqToBP(_reservationFeeBP, MAX_FEE_BP);

        VaultHub vaultHub = _vaultHub();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010075,0)}
        if (!vaultHub.isVaultConnected(_vault)) revert VaultNotConnected();

        VaultHub.VaultConnection memory vaultConnection = vaultHub.vaultConnection(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010076,0)}
        vaultHub.updateConnection(
            _vault,
            vaultConnection.shareLimit,
            vaultConnection.reserveRatioBP,
            vaultConnection.forcedRebalanceThresholdBP,
            _infraFeeBP,
            _liquidityFeeBP,
            _reservationFeeBP
        );
    }

   // -----------------------------
   //     MINT / BURN
   // -----------------------------

    /// @notice Mint shares limit check
    /// @param _vault address of the vault
    /// @param _amount amount of shares will be minted
    /// @param _overrideLimits true if group and tier limits should not be checked
    function onMintedShares(
        address _vault,
        uint256 _amount,
        bool _overrideLimits
    ) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("onMintedShares", msg.sender);

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010077,0)}

        if (!_overrideLimits && $.isVaultInJail[_vault]) revert VaultInJail();

        uint256 tierId = $.vaultTier[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000078,tierId)}
        Tier storage tier_ = $.tiers[tierId];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010079,0)}

        uint96 tierLiabilityShares = tier_.liabilityShares;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000007a,tierLiabilityShares)}
        if (!_overrideLimits && tierLiabilityShares + _amount > tier_.shareLimit) {
            revert TierLimitExceeded();
        }

        tier_.liabilityShares = tierLiabilityShares + uint96(_amount);uint96 certora_local146 = tier_.liabilityShares;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000092,certora_local146)}

        if (tierId != DEFAULT_TIER_ID) {
            Group storage group_ = $.groups[tier_.operator];
            uint96 groupMintedShares = group_.liabilityShares;
            if (!_overrideLimits && groupMintedShares + _amount > group_.shareLimit) {
                revert GroupLimitExceeded();
            }

            group_.liabilityShares = groupMintedShares + uint96(_amount);
        }
    }

    /// @notice Burn shares limit check
    /// @param _vault address of the vault
    /// @param _amount amount of shares to burn
    function onBurnedShares(
        address _vault,
        uint256 _amount
    ) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("burnShares", msg.sender);

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001007b,0)}

        uint256 tierId = $.vaultTier[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000007c,tierId)}

        Tier storage tier_ = $.tiers[tierId];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001007d,0)}

        // we skip the check for minted shared underflow, because it's done in the VaultHub.burnShares()

        tier_.liabilityShares -= uint96(_amount);uint96 certora_local147 = tier_.liabilityShares;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000093,certora_local147)}

        if (tierId != DEFAULT_TIER_ID) {
            Group storage group_ = $.groups[tier_.operator];
            group_.liabilityShares -= uint96(_amount);
        }
    }

    /// @notice Updates if the vault is in jail
    /// @param _vault vault address
    /// @param _isInJail true if the vault is in jail, false otherwise
    function setVaultJailStatus(address _vault, bool _isInJail) external onlyRole(REGISTRY_ROLE) {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001007e,0)}
        if ($.isVaultInJail[_vault] == _isInJail) revert VaultInJailAlreadySet();
        $.isVaultInJail[_vault] = _isInJail;bool certora_local148 = $.isVaultInJail[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000094,certora_local148)}

        emit VaultJailStatusUpdated(_vault, _isInJail);
    }

    /// @notice Get vault's tier limits
    /// @param _vault address of the vault
    /// @return nodeOperator node operator of the vault
    /// @return tierId tier id of the vault
    /// @return shareLimit share limit of the vault
    /// @return reserveRatioBP reserve ratio of the vault
    /// @return forcedRebalanceThresholdBP forced rebalance threshold of the vault
    /// @return infraFeeBP infra fee of the vault
    /// @return liquidityFeeBP liquidity fee of the vault
    /// @return reservationFeeBP reservation fee of the vault
    function vaultTierInfo(address _vault)
        external
        view
        returns (
            address nodeOperator,
            uint256 tierId,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 infraFeeBP,
            uint256 liquidityFeeBP,
            uint256 reservationFeeBP
        )
    {
        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001007f,0)}

        tierId = $.vaultTier[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000095,tierId)}

        Tier memory t = $.tiers[tierId];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010080,0)}
        nodeOperator = t.operator;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000096,nodeOperator)}

        shareLimit = t.shareLimit;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000097,shareLimit)}
        reserveRatioBP = t.reserveRatioBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000098,reserveRatioBP)}
        forcedRebalanceThresholdBP = t.forcedRebalanceThresholdBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000099,forcedRebalanceThresholdBP)}
        infraFeeBP = t.infraFeeBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000009a,infraFeeBP)}
        liquidityFeeBP = t.liquidityFeeBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000009b,liquidityFeeBP)}
        reservationFeeBP = t.reservationFeeBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000009c,reservationFeeBP)}
    }

    /// @notice Returns the effective share limit of a vault according to the OperatorGrid and vault share limits
    /// @param _vault address of the vault
    /// @return shareLimit effective share limit of the vault
    function effectiveShareLimit(address _vault) public view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002a0000, 1037618708522) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002a0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002a1000, _vault) }
        VaultHub vaultHub = _vaultHub();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010081,0)}
        uint256 shareLimit = vaultHub.vaultConnection(_vault).shareLimit;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000082,shareLimit)}
        uint256 liabilityShares = vaultHub.liabilityShares(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000083,liabilityShares)}

        uint256 gridShareLimit = _gridRemainingShareLimit(_vault) + liabilityShares;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000084,gridShareLimit)}
        return Math256.min(gridShareLimit, shareLimit);
    }

    /// @notice Returns true if the vault is in jail
    /// @param _vault address of the vault
    /// @return true if the vault is in jail
    function isVaultInJail(address _vault) external view returns (bool) {
        return _getStorage().isVaultInJail[_vault];
    }

    /// @notice Returns the remaining share limit in a given tier and group
    /// @param _vault address of the vault
    /// @return remaining share limit
    /// @dev remaining share limit inherits the limits of the vault tier and group,
    ///      and accounts liabilities of other vaults belonging to the same tier and group
    function _gridRemainingShareLimit(address _vault) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00240000, 1037618708516) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00240001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00241000, _vault) }
        ERC7201Storage storage $ = _getStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010085,0)}
        uint256 tierId = $.vaultTier[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000086,tierId)}
        Tier storage t = $.tiers[tierId];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010087,0)}

        uint256 tierLimit = t.shareLimit;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000088,tierLimit)}
        uint256 tierRemaining = tierLimit > t.liabilityShares ? tierLimit - t.liabilityShares : 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000089,tierRemaining)}

        if (tierId == DEFAULT_TIER_ID) return tierRemaining;

        Group storage g = $.groups[t.operator];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001008a,0)}
        uint256 groupLimit = g.shareLimit;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000008b,groupLimit)}
        uint256 groupRemaining = groupLimit > g.liabilityShares ? groupLimit - g.liabilityShares : 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000008c,groupRemaining)}
        return Math256.min(tierRemaining, groupRemaining);
    }

    /// @notice Validates tier parameters
    /// @param _reserveRatioBP Reserve ratio
    /// @param _forcedRebalanceThresholdBP Forced rebalance threshold
    /// @param _infraFeeBP Infra fee
    /// @param _liquidityFeeBP Liquidity fee
    /// @param _reservationFeeBP Reservation fee
    function _validateParams(
      uint256 _tierId,
      uint256 _reserveRatioBP,
      uint256 _forcedRebalanceThresholdBP,
      uint256 _infraFeeBP,
      uint256 _liquidityFeeBP,
      uint256 _reservationFeeBP
    ) internal pure {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00250000, 1037618708517) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00250001, 6) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00251000, _tierId) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00251001, _reserveRatioBP) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00251002, _forcedRebalanceThresholdBP) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00251003, _infraFeeBP) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00251004, _liquidityFeeBP) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00251005, _reservationFeeBP) }
        if (_reserveRatioBP == 0) revert ZeroArgument("_reserveRatioBP");
        if (_reserveRatioBP > MAX_RESERVE_RATIO_BP)
            revert ReserveRatioTooHigh(_tierId, _reserveRatioBP, MAX_RESERVE_RATIO_BP);

        if (_forcedRebalanceThresholdBP == 0) revert ZeroArgument("_forcedRebalanceThresholdBP");
        if (_forcedRebalanceThresholdBP + 10 >= _reserveRatioBP) {
            revert ForcedRebalanceThresholdTooHigh(_tierId, _forcedRebalanceThresholdBP, _reserveRatioBP);
        }

        if (_infraFeeBP > MAX_FEE_BP)
            revert InfraFeeTooHigh(_tierId, _infraFeeBP, MAX_FEE_BP);

        if (_liquidityFeeBP > MAX_FEE_BP)
            revert LiquidityFeeTooHigh(_tierId, _liquidityFeeBP, MAX_FEE_BP);

        if (_reservationFeeBP > MAX_FEE_BP)
            revert ReservationFeeTooHigh(_tierId, _reservationFeeBP, MAX_FEE_BP);
    }

    function _vaultHub() internal view returns (VaultHub) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00270000, 1037618708519) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00270001, 0) }
        return VaultHub(payable(LIDO_LOCATOR.vaultHub()));
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00280000, 1037618708520) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00280001, 0) }
        assembly {
            $.slot := OPERATOR_GRID_STORAGE_LOCATION
        }
    }

    function _getVaultContextForConnectedVault(address _vault) internal view returns (
        VaultHub vaultHub,
        VaultHub.VaultConnection memory vaultConnection,
        address vaultOwner,
        address nodeOperator,
        uint256 vaultTierId
    ) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00260000, 1037618708518) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00260001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00261000, _vault) }
        if (_vault == address(0)) revert ZeroArgument("_vault");

        vaultHub = _vaultHub();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0002009d,0)}
        if (!vaultHub.isVaultConnected(_vault)) revert VaultNotConnected();

        vaultConnection = vaultHub.vaultConnection(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0002009e,0)}
        vaultOwner = vaultConnection.owner;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000009f,vaultOwner)}
        nodeOperator = IStakingVault(_vault).nodeOperator();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000000a0,nodeOperator)}

        vaultTierId = _getStorage().vaultTier[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff000000a1,vaultTierId)}
    }

    function _requireLessOrEqToBP(uint256 _valueBP, uint256 _maxValueBP) internal pure {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00290000, 1037618708521) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00290001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00291000, _valueBP) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00291001, _maxValueBP) }
        if (_valueBP > _maxValueBP) revert InvalidBasisPoints(_valueBP, _maxValueBP);
    }

    // -----------------------------
    //            EVENTS
    // -----------------------------
    event GroupAdded(address indexed nodeOperator, uint256 shareLimit);
    event GroupShareLimitUpdated(address indexed nodeOperator, uint256 shareLimit);
    event TierAdded(
        address indexed nodeOperator,
        uint256 indexed tierId,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );
    event TierChanged(address indexed vault, uint256 indexed tierId, uint256 shareLimit);
    event TierUpdated(
      uint256 indexed tierId,
      uint256 shareLimit,
      uint256 reserveRatioBP,
      uint256 forcedRebalanceThresholdBP,
      uint256 infraFeeBP,
      uint256 liquidityFeeBP,
      uint256 reservationFeeBP
    );
    event VaultJailStatusUpdated(address indexed vault, bool isInJail);

    // -----------------------------
    //            ERRORS
    // -----------------------------
    error NotAuthorized(string operation, address sender);
    error ZeroArgument(string argument);
    error GroupExists();
    error GroupNotExists();
    error GroupLimitExceeded();
    error NodeOperatorNotExists();
    error TierLimitExceeded();
    error VaultInJailAlreadySet();
    error VaultInJail();

    error TierNotExists();
    error TierAlreadySet();
    error TierNotInOperatorGroup();
    error CannotChangeToDefaultTier();

    error ReserveRatioTooHigh(uint256 tierId, uint256 reserveRatioBP, uint256 maxReserveRatioBP);
    error ForcedRebalanceThresholdTooHigh(uint256 tierId, uint256 forcedRebalanceThresholdBP, uint256 reserveRatioBP);
    error InfraFeeTooHigh(uint256 tierId, uint256 infraFeeBP, uint256 maxInfraFeeBP);
    error LiquidityFeeTooHigh(uint256 tierId, uint256 liquidityFeeBP, uint256 maxLiquidityFeeBP);
    error ReservationFeeTooHigh(uint256 tierId, uint256 reservationFeeBP, uint256 maxReservationFeeBP);
    error ArrayLengthMismatch();
    error RequestedShareLimitTooHigh(uint256 requestedShareLimit, uint256 tierShareLimit);
    error RequestedShareLimitTooLow(uint256 requestedSHareLimit, uint256 vaultShares);
    error VaultNotConnected();
    error VaultAlreadySyncedWithTier();
    error ShareLimitAlreadySet();
    error InvalidBasisPoints(uint256 valueBP, uint256 maxValueBP);
}
