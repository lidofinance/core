// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

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
     */

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
     */
    struct ERC7201Storage {
        Tier[] tiers;
        mapping(address vault => uint256 tierId) vaultTier;
        mapping(address nodeOperator => Group) groups;
        address[] nodeOperators;
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

        ERC7201Storage storage $ = _getStorage();

        //create default tier with default share limit
        $.tiers.push(
            Tier({
                operator: DEFAULT_TIER_OPERATOR,
                shareLimit: uint96(_defaultTierParams.shareLimit),
                reserveRatioBP: uint16(_defaultTierParams.reserveRatioBP),
                forcedRebalanceThresholdBP: uint16(_defaultTierParams.forcedRebalanceThresholdBP),
                infraFeeBP: uint16(_defaultTierParams.infraFeeBP),
                liquidityFeeBP: uint16(_defaultTierParams.liquidityFeeBP),
                reservationFeeBP: uint16(_defaultTierParams.reservationFeeBP),
                liabilityShares: 0
            })
        );
    }

    /// @notice Registers a new group
    /// @param _nodeOperator address of the node operator
    /// @param _shareLimit Maximum share limit for the group
    function registerGroup(address _nodeOperator, uint256 _shareLimit) external onlyRole(REGISTRY_ROLE) {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        ERC7201Storage storage $ = _getStorage();
        if ($.groups[_nodeOperator].operator != address(0)) revert GroupExists();

        $.groups[_nodeOperator] = Group({
            operator: _nodeOperator,
            shareLimit: uint96(_shareLimit),
            liabilityShares: 0,
            tierIds: new uint256[](0)
        });
        $.nodeOperators.push(_nodeOperator);

        emit GroupAdded(_nodeOperator, uint96(_shareLimit));
    }

    /// @notice Updates the share limit of a group
    /// @param _nodeOperator address of the node operator
    /// @param _shareLimit New share limit value
    function updateGroupShareLimit(address _nodeOperator, uint256 _shareLimit) external onlyRole(REGISTRY_ROLE) {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        ERC7201Storage storage $ = _getStorage();
        Group storage group_ = $.groups[_nodeOperator];
        if (group_.operator == address(0)) revert GroupNotExists();

        group_.shareLimit = uint96(_shareLimit);

        emit GroupShareLimitUpdated(_nodeOperator, uint96(_shareLimit));
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
        ERC7201Storage storage $ = _getStorage();
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

        ERC7201Storage storage $ = _getStorage();
        Group storage group_ = $.groups[_nodeOperator];
        if (group_.operator == address(0)) revert GroupNotExists();

        uint256 tierId = $.tiers.length;
        uint256 length = _tiers.length;
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
                shareLimit: uint96(_tiers[i].shareLimit),
                reserveRatioBP: uint16(_tiers[i].reserveRatioBP),
                forcedRebalanceThresholdBP: uint16(_tiers[i].forcedRebalanceThresholdBP),
                infraFeeBP: uint16(_tiers[i].infraFeeBP),
                liquidityFeeBP: uint16(_tiers[i].liquidityFeeBP),
                reservationFeeBP: uint16(_tiers[i].reservationFeeBP),
                liabilityShares: 0
            });
            $.tiers.push(tier_);
            group_.tierIds.push(tierId);

            emit TierAdded(
                _nodeOperator,
                tierId,
                uint96(tier_.shareLimit),
                uint16(tier_.reserveRatioBP),
                uint16(tier_.forcedRebalanceThresholdBP),
                uint16(tier_.infraFeeBP),
                uint16(tier_.liquidityFeeBP),
                uint16(tier_.reservationFeeBP)
            );

            tierId++;
        }
    }

    /// @notice Returns a tier by ID
    /// @param _tierId id of the tier
    /// @return Tier
    function tier(uint256 _tierId) external view returns (Tier memory) {
        ERC7201Storage storage $ = _getStorage();
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

        ERC7201Storage storage $ = _getStorage();
        uint256 length = _tierIds.length;
        uint256 tiersLength = $.tiers.length;

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

            Tier storage tier_ = $.tiers[_tierIds[i]];

            tier_.shareLimit = uint96(_tierParams[i].shareLimit);
            tier_.reserveRatioBP = uint16(_tierParams[i].reserveRatioBP);
            tier_.forcedRebalanceThresholdBP = uint16(_tierParams[i].forcedRebalanceThresholdBP);
            tier_.infraFeeBP = uint16(_tierParams[i].infraFeeBP);
            tier_.liquidityFeeBP = uint16(_tierParams[i].liquidityFeeBP);
            tier_.reservationFeeBP = uint16(_tierParams[i].reservationFeeBP);

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

    /// @notice Vault tier change with multi-role confirmation
    /// @param _vault address of the vault
    /// @param _requestedTierId id of the tier
    /// @param _requestedShareLimit share limit to set
    /// @return bool Whether the tier change was confirmed.
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
    function changeTier(address _vault, uint256 _requestedTierId, uint256 _requestedShareLimit) external returns (bool) {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        ERC7201Storage storage $ = _getStorage();
        if (_requestedTierId >= $.tiers.length) revert TierNotExists();
        if (_requestedTierId == DEFAULT_TIER_ID) revert CannotChangeToDefaultTier();

        VaultHub vaultHub = _vaultHub();
        bool isVaultConnected = vaultHub.isVaultConnected(_vault);

        address vaultOwner = isVaultConnected
            ? vaultHub.vaultConnection(_vault).owner
            : IStakingVault(_vault).owner();

        address nodeOperator = IStakingVault(_vault).nodeOperator();

        uint256 vaultTierId = $.vaultTier[_vault];
        if (vaultTierId == _requestedTierId) revert TierAlreadySet();

        Tier storage requestedTier = $.tiers[_requestedTierId];
        if (nodeOperator != requestedTier.operator) revert TierNotInOperatorGroup();
        if (_requestedShareLimit > requestedTier.shareLimit) revert RequestedShareLimitTooHigh(_requestedShareLimit, requestedTier.shareLimit);

        // store the caller's confirmation; only proceed if the required number of confirmations is met.
        if (!_collectAndCheckConfirmations(msg.data, vaultOwner, nodeOperator)) return false;
        uint256 vaultLiabilityShares = vaultHub.liabilityShares(_vault);

        //check if tier limit is exceeded
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

        Tier storage currentTier = $.tiers[vaultTierId];

        currentTier.liabilityShares -= uint96(vaultLiabilityShares);
        requestedTier.liabilityShares += uint96(vaultLiabilityShares);

        $.vaultTier[_vault] = _requestedTierId;

        // Vault may not be connected to VaultHub yet.
        // There are two possible flows:
        // 1. Vault is created and connected to VaultHub immediately with the default tier.
        //    In this case, `VaultConnection` is non-zero and updateConnection must be called.
        // 2. Vault is created, its tier is changed before connecting to VaultHub.
        //    In this case, `VaultConnection` is still zero, and updateConnection must be skipped.
        // Hence, we update the VaultHub connection only if the vault is already connected.
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

    /// @notice Reset vault's tier to default
    /// @param _vault address of the vault
    /// @dev Requires vault's liabilityShares to be zero before resetting the tier
    function resetVaultTier(address _vault) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("resetVaultTier", msg.sender);

        ERC7201Storage storage $ = _getStorage();

        if ($.vaultTier[_vault] != DEFAULT_TIER_ID) {
            $.vaultTier[_vault] = DEFAULT_TIER_ID;

            emit TierChanged(_vault, DEFAULT_TIER_ID, $.tiers[DEFAULT_TIER_ID].shareLimit);
        }
    }

   // -----------------------------
   //     MINT / BURN
   // -----------------------------

    /// @notice Mint shares limit check
    /// @param _vault address of the vault
    /// @param _amount amount of shares will be minted
    function onMintedShares(
        address _vault,
        uint256 _amount
    ) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("onMintedShares", msg.sender);

        ERC7201Storage storage $ = _getStorage();

        uint256 tierId = $.vaultTier[_vault];
        Tier storage tier_ = $.tiers[tierId];

        uint96 tierLiabilityShares = tier_.liabilityShares;
        if (tierLiabilityShares + _amount > tier_.shareLimit) revert TierLimitExceeded();

        tier_.liabilityShares = tierLiabilityShares + uint96(_amount);

        if (tierId != DEFAULT_TIER_ID) {
            Group storage group_ = $.groups[tier_.operator];
            uint96 groupMintedShares = group_.liabilityShares;
            if (groupMintedShares + _amount > group_.shareLimit) revert GroupLimitExceeded();

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

        ERC7201Storage storage $ = _getStorage();

        uint256 tierId = $.vaultTier[_vault];

        Tier storage tier_ = $.tiers[tierId];

        // we skip the check for minted shared underflow, because it's done in the VaultHub.burnShares()

        tier_.liabilityShares -= uint96(_amount);

        if (tierId != DEFAULT_TIER_ID) {
            Group storage group_ = $.groups[tier_.operator];
            group_.liabilityShares -= uint96(_amount);
        }
    }

    /// @notice Get vault limits
    /// @param _vault address of the vault
    /// @return nodeOperator node operator of the vault
    /// @return tierId tier id of the vault
    /// @return shareLimit share limit of the vault
    /// @return reserveRatioBP reserve ratio of the vault
    /// @return forcedRebalanceThresholdBP forced rebalance threshold of the vault
    /// @return infraFeeBP infra fee of the vault
    /// @return liquidityFeeBP liquidity fee of the vault
    /// @return reservationFeeBP reservation fee of the vault
    function vaultInfo(address _vault)
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
        ERC7201Storage storage $ = _getStorage();

        tierId = $.vaultTier[_vault];

        Tier memory t = $.tiers[tierId];
        nodeOperator = t.operator;

        shareLimit = t.shareLimit;
        reserveRatioBP = t.reserveRatioBP;
        forcedRebalanceThresholdBP = t.forcedRebalanceThresholdBP;
        infraFeeBP = t.infraFeeBP;
        liquidityFeeBP = t.liquidityFeeBP;
        reservationFeeBP = t.reservationFeeBP;
    }

    /// @notice Returns the effective share limit of a vault according to the OperatorGrid and vault share limits
    /// @param _vault address of the vault
    /// @return shareLimit effective share limit of the vault
    function effectiveShareLimit(address _vault) public view returns (uint256) {
        VaultHub vaultHub = _vaultHub();
        uint256 shareLimit = vaultHub.vaultConnection(_vault).shareLimit;
        uint256 liabilityShares = vaultHub.liabilityShares(_vault);

        uint256 gridShareLimit = _gridRemainingShareLimit(_vault) + liabilityShares;
        return Math256.min(gridShareLimit, shareLimit);
    }

    /// @notice Returns the remaining share limit in a given tier and group
    /// @param _vault address of the vault
    /// @return remaining share limit
    /// @dev remaining share limit inherits the limits of the vault tier and group,
    ///      and accounts liabilities of other vaults belonging to the same tier and group
    function _gridRemainingShareLimit(address _vault) internal view returns (uint256) {
        ERC7201Storage storage $ = _getStorage();
        uint256 tierId = $.vaultTier[_vault];
        Tier storage t = $.tiers[tierId];

        uint256 tierLimit = t.shareLimit;
        uint256 tierRemaining = tierLimit > t.liabilityShares ? tierLimit - t.liabilityShares : 0;

        if (tierId == DEFAULT_TIER_ID) return tierRemaining;

        Group storage g = $.groups[t.operator];
        uint256 groupLimit = g.shareLimit;
        uint256 groupRemaining = groupLimit > g.liabilityShares ? groupLimit - g.liabilityShares : 0;
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
    ) internal pure {
        if (_reserveRatioBP == 0) revert ZeroArgument("_reserveRatioBP");
        if (_reserveRatioBP > TOTAL_BASIS_POINTS)
            revert ReserveRatioTooHigh(_tierId, _reserveRatioBP, TOTAL_BASIS_POINTS);

        if (_forcedRebalanceThresholdBP == 0) revert ZeroArgument("_forcedRebalanceThresholdBP");
        if (_forcedRebalanceThresholdBP > _reserveRatioBP)
            revert ForcedRebalanceThresholdTooHigh(_tierId, _forcedRebalanceThresholdBP, _reserveRatioBP);

        if (_infraFeeBP > MAX_FEE_BP)
            revert InfraFeeTooHigh(_tierId, _infraFeeBP, MAX_FEE_BP);

        if (_liquidityFeeBP > MAX_FEE_BP)
            revert LiquidityFeeTooHigh(_tierId, _liquidityFeeBP, MAX_FEE_BP);

        if (_reservationFeeBP > MAX_FEE_BP)
            revert ReservationFeeTooHigh(_tierId, _reservationFeeBP, MAX_FEE_BP);
    }

    function _vaultHub() internal view returns (VaultHub) {
        return VaultHub(payable(LIDO_LOCATOR.vaultHub()));
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := OPERATOR_GRID_STORAGE_LOCATION
        }
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
}
