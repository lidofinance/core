// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {VaultHub} from "./VaultHub.sol";

struct TierParams {
    uint256 shareLimit;
    uint256 reserveRatioBP;
    uint256 forcedRebalanceThresholdBP;
    uint256 treasuryFeeBP;
}

/**
 * @title OperatorGrid
 * @author Lido
 * @notice
 * OperatorGrid is a contract that manages mint parameters for vaults when they are connected to the VaultHub.
 * These parameters include:
 * - shareLimit: maximum amount of shares that can be minted
 * - reserveRatioBP: reserve ratio in basis points
 * - forcedRebalanceThresholdBP: forced rebalance threshold in basis points
 * - treasuryFeeBP: treasury fee in basis points
 *
 * These parameters are determined by the Tier in which the Vault is registered.
 *
 */
contract OperatorGrid is AccessControlEnumerableUpgradeable {
    /*
      Key concepts:
      1. Default Registration:
         - All Vaults are initially has default tier (DEFAULT_TIER_ID = 0)
         - The default tier has no group

         DEFAULT_TIER_ID = 0
        ┌──────────────────────┐
        │        Tier 1        │
        │  tierShareLimit = z  │
        │  Vault_1 ... Vault_m │
        └──────────────────────┘

       2. Tier Change Process:
         - To modify a vault's connection parameters to VaultHub, a tier change must be requested
         - Change requests must be approved by the target tier's Node Operator
         - All pending requests are tracked in the pendingRequests mapping

         Operator1.pendingRequests = [Vault_1, Vault_2, ...]

       3. Confirmation Process:
         - Node Operator can confirm the tier change if:
           a) The target tier has sufficient capacity (shareLimit)
           b) Vault's node operator corresponds to the target tier group
         For detailed tier change scenarios and share accounting, see the ASCII diagrams in the `confirmTierChange` function.

       4. Tier Capacity:
         - Tiers are not limited by the number of vaults
         - Tiers are limited by the sum of vaults' minted shares

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

    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant REGISTRY_ROLE = keccak256("vaults.OperatorsGrid.Registry");

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @notice Default group address
    uint256 public constant DEFAULT_TIER_ID = 0;
    address public constant DEFAULT_TIER_OPERATOR = address(uint160(type(uint160).max));

    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;

    // -----------------------------
    //            STRUCTS
    // -----------------------------
    struct Group {
        address operator;
        uint96 shareLimit;
        uint96 liabilityShares;
        uint128[] tierIds;
    }

    struct Tier {
        address operator;
        uint96 shareLimit;
        uint96 liabilityShares;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 treasuryFeeBP;
    }

    struct VaultTier {
        uint128 currentTierId;
        uint128 requestedTierId;
    }

    /**
     * @notice ERC-7201 storage namespace for the OperatorGrid
     * @dev ERC-7201 namespace is used to prevent upgrade collisions
     * @custom:storage-location erc7201:Lido.Vaults.OperatorGrid
     * @custom:tiers Tiers
     * @custom:vaultTier Vault tiers
     * @custom:groups Groups
     * @custom:pendingRequests Pending requests
     * @custom:nodeOperators Node operators
     */
    struct ERC7201Storage {
        Tier[] tiers;
        mapping(address vault => VaultTier) vaultTier;
        mapping(address nodeOperator => Group) groups;
        mapping(address nodeOperator => EnumerableSet.AddressSet) pendingRequests;
        address[] nodeOperators;
    }

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         keccak256(abi.encode(uint256(keccak256("Lido.Vaults.OperatorGrid")) - 1)) & ~bytes32(uint256(0xff))
     */
    bytes32 private constant ERC7201_STORAGE_LOCATION =
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
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        ERC7201Storage storage $ = _getStorage();

        //create default tier with default share limit
        $.tiers.push(
            Tier({
                operator: DEFAULT_TIER_OPERATOR,
                shareLimit: uint96(_defaultTierParams.shareLimit),
                reserveRatioBP: uint16(_defaultTierParams.reserveRatioBP),
                forcedRebalanceThresholdBP: uint16(_defaultTierParams.forcedRebalanceThresholdBP),
                treasuryFeeBP: uint16(_defaultTierParams.treasuryFeeBP),
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
            tierIds: new uint128[](0)
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

        uint128 tierId = uint128($.tiers.length);
        uint256 length = _tiers.length;
        for (uint256 i = 0; i < length; i++) {
            _validateParams(tierId, _tiers[i].reserveRatioBP, _tiers[i].forcedRebalanceThresholdBP, _tiers[i].treasuryFeeBP);

            Tier memory tier_ = Tier({
                operator: _nodeOperator,
                shareLimit: uint96(_tiers[i].shareLimit),
                reserveRatioBP: uint16(_tiers[i].reserveRatioBP),
                forcedRebalanceThresholdBP: uint16(_tiers[i].forcedRebalanceThresholdBP),
                treasuryFeeBP: uint16(_tiers[i].treasuryFeeBP),
                liabilityShares: 0
            });
            $.tiers.push(tier_);
            group_.tierIds.push(tierId);

            emit TierAdded(
                _nodeOperator,
                tierId,
                uint96(_tiers[i].shareLimit),
                uint16(_tiers[i].reserveRatioBP),
                uint16(_tiers[i].forcedRebalanceThresholdBP),
                uint16(_tiers[i].treasuryFeeBP)
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

    /// @notice Alters a tier
    /// @dev We do not enforce to update old vaults with the new tier params, only new ones.
    /// @param _tierId id of the tier
    /// @param _tierParams new tier params
    function alterTier(uint256 _tierId, TierParams calldata _tierParams) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();
        if (_tierId >= $.tiers.length) revert TierNotExists();

        _validateParams(_tierId, _tierParams.reserveRatioBP, _tierParams.forcedRebalanceThresholdBP, _tierParams.treasuryFeeBP);

        Tier storage tier_ = $.tiers[_tierId];

        tier_.shareLimit = uint96(_tierParams.shareLimit);
        tier_.reserveRatioBP = uint16(_tierParams.reserveRatioBP);
        tier_.forcedRebalanceThresholdBP = uint16(_tierParams.forcedRebalanceThresholdBP);
        tier_.treasuryFeeBP = uint16(_tierParams.treasuryFeeBP);

        emit TierUpdated(_tierId, tier_.shareLimit, tier_.reserveRatioBP, tier_.forcedRebalanceThresholdBP, tier_.treasuryFeeBP);
    }

    /// @notice Request to change tier
    /// @param _vault address of the vault
    /// @param _tierId id of the tier
    function requestTierChange(address _vault, uint256 _tierId) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (msg.sender != IStakingVault(_vault).owner()) revert NotAuthorized("requestTierChange", msg.sender);

        ERC7201Storage storage $ = _getStorage();
        if (_tierId >= $.tiers.length) revert TierNotExists();
        if (_tierId == DEFAULT_TIER_ID) revert CannotChangeToDefaultTier();

        Tier memory requestedTier = $.tiers[_tierId];
        address requestedTierOperator = requestedTier.operator;
        address nodeOperator = IStakingVault(_vault).nodeOperator();
        if (nodeOperator != requestedTierOperator) revert TierNotInOperatorGroup();

        uint128 tierId = uint128(_tierId);

        VaultTier storage vaultTier = $.vaultTier[_vault];
        if (vaultTier.currentTierId == tierId) revert TierAlreadySet();
        if (vaultTier.requestedTierId == tierId) revert TierAlreadyRequested();

        vaultTier.requestedTierId = tierId;

        $.pendingRequests[nodeOperator].add(_vault); //returns true if the vault was not in the set

        emit TierChangeRequested(_vault, vaultTier.currentTierId, _tierId);
    }

    /// @notice Confirm tier change request
    /// @param _vault address of the vault
    /// @param _tierIdToConfirm id of the tier to confirm
    ///
    /*

    Legend:
    V = Vault1.liabilityShares

    Scheme1 - transfer Vault from default tier to Tier2

                                         ┌────────────────────────────────┐
                                         │           Group 1              │
                                         │                                │
    ┌────────────────────┐               │  ┌───────────┐  ┌───────────┐  │
    │  Tier 1 (default)  │   confirm     │  │ Tier 2    │  │ Tier 3    │  │
    │  minted: -V        │    ─────▶     │  │ minted:+V │  │           │  │
    └────────────────────┘               │  └───────────┘  └───────────┘  │
                                         │                                │
                                         │   Group1.liabilityShares: +V   │
                                         └────────────────────────────────┘

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
    │  │ minted:-V │  │ minted:+V │  │     │  │           │                 │
    │  └───────────┘  └───────────┘  │     │  └───────────┘                 │
    │  operator1                     │     │  operator2                     │
    └────────────────────────────────┘     └────────────────────────────────┘

    After confirmation:
    - Tier 2.liabilityShares   = -V
    - Tier 3.liabilityShares   = +V

    NB: Cannot change from Tier2 to Tier1, because Tier1 has no group. Reverts on `requestTierChange`
    NB: Cannot change from Tier2 to Tier4, because Tier4 has different operator.

    */
    function confirmTierChange(address _vault, uint256 _tierIdToConfirm) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        address nodeOperator = IStakingVault(_vault).nodeOperator();
        if (msg.sender != nodeOperator) revert NotAuthorized("confirmTierChange", msg.sender);
        if (_tierIdToConfirm == DEFAULT_TIER_ID) revert CannotChangeToDefaultTier();

        ERC7201Storage storage $ = _getStorage();
        VaultTier storage vaultTier = $.vaultTier[_vault];
        uint128 requestedTierId = vaultTier.requestedTierId;
        if (requestedTierId != _tierIdToConfirm) revert InvalidTierId(requestedTierId, _tierIdToConfirm);

        Tier storage requestedTier = $.tiers[requestedTierId];

        VaultHub vaultHub = VaultHub(LIDO_LOCATOR.vaultHub());
        VaultHub.VaultSocket memory vaultSocket = vaultHub.vaultSocket(_vault);
        uint256 vaultLiabilityShares = vaultSocket.liabilityShares;

        //check if tier limit is exceeded
        if (requestedTier.liabilityShares + vaultLiabilityShares > requestedTier.shareLimit) revert TierLimitExceeded();

        // if the vault was in the default tier:
        // - that mean that the vault has no group, so we decrease only the minted shares of the default tier
        // - but need to check requested group limit exceeded
        if (vaultTier.currentTierId == DEFAULT_TIER_ID) {
            Group storage requestedGroup = $.groups[nodeOperator];
            if (requestedGroup.liabilityShares + vaultLiabilityShares > requestedGroup.shareLimit) revert GroupLimitExceeded();
            requestedGroup.liabilityShares += uint96(vaultLiabilityShares);
        }

        Tier storage currentTier = $.tiers[vaultTier.currentTierId];

        currentTier.liabilityShares -= uint96(vaultLiabilityShares);
        requestedTier.liabilityShares += uint96(vaultLiabilityShares);

        vaultTier.currentTierId = requestedTierId;
        vaultTier.requestedTierId = 0;

        $.pendingRequests[nodeOperator].remove(_vault);

        VaultHub(LIDO_LOCATOR.vaultHub()).updateConnection(
            _vault,
            requestedTier.shareLimit,
            requestedTier.reserveRatioBP,
            requestedTier.forcedRebalanceThresholdBP,
            requestedTier.treasuryFeeBP
        );

        emit TierChanged(_vault, requestedTierId);
    }

    /// @notice Returns pending requests for a node operator
    /// @param _nodeOperator address of the node operator
    /// @return vault addresses
    function pendingRequests(address _nodeOperator) external view returns (address[] memory) {
        return _getStorage().pendingRequests[_nodeOperator].values();
    }

    /// @notice Returns a pending request for a node operator
    /// @param _nodeOperator address of the node operator
    /// @param _index index of the pending request
    /// @return vault address
    function pendingRequest(address _nodeOperator, uint256 _index) external view returns (address) {
        return _getStorage().pendingRequests[_nodeOperator].at(_index);
    }

    /// @notice Returns a pending requests count for a node operator
    /// @param _nodeOperator address of the node operator
    /// @return pending requests count
    function pendingRequestsCount(address _nodeOperator) external view returns (uint256) {
        return _getStorage().pendingRequests[_nodeOperator].length();
    }

   // -----------------------------
   //     MINT / BURN
   // -----------------------------

    /// @notice Mint shares limit check
    /// @param vaultAddr address of the vault
    /// @param amount amount of shares will be minted
    function onMintedShares(
        address vaultAddr,
        uint256 amount
    ) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("onMintedShares", msg.sender);

        ERC7201Storage storage $ = _getStorage();

        VaultTier memory vaultTier = $.vaultTier[vaultAddr];
        uint128 tierId = vaultTier.currentTierId;

        uint96 amount_ = uint96(amount);

        Tier storage tier_ = $.tiers[tierId];

        uint96 tierLiabilityShares = tier_.liabilityShares; //cache
        if (tierLiabilityShares + amount_ > tier_.shareLimit) revert TierLimitExceeded();

        tier_.liabilityShares = tierLiabilityShares + amount_;

        if (tierId != DEFAULT_TIER_ID) {
            Group storage group_ = $.groups[tier_.operator];
            uint96 groupMintedShares = group_.liabilityShares;
            if (groupMintedShares + amount_ > group_.shareLimit) revert GroupLimitExceeded();

            group_.liabilityShares = groupMintedShares + amount_;
        }
    }

    /// @notice Burn shares limit check
    /// @param vaultAddr address of the vault
    /// @param amount amount of shares to burn
    function onBurnedShares(
        address vaultAddr,
        uint256 amount
    ) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("burnShares", msg.sender);

        ERC7201Storage storage $ = _getStorage();

        VaultTier memory vaultTier = $.vaultTier[vaultAddr];
        uint128 tierId = vaultTier.currentTierId;

        uint96 amount_ = uint96(amount);

        Tier storage tier_ = $.tiers[tierId];

        // we skip the check for minted shared underflow, because it's done in the VaultHub.burnShares()

        tier_.liabilityShares -= amount_;

        if (tierId != DEFAULT_TIER_ID) {
            Group storage group_ = $.groups[tier_.operator];
            group_.liabilityShares -= amount_;
        }
    }

    /// @notice Get vault limits
    /// @param vaultAddr address of the vault
    /// @return nodeOperator node operator of the vault
    /// @return tierId tier id of the vault
    /// @return shareLimit share limit of the vault
    /// @return reserveRatioBP reserve ratio of the vault
    /// @return forcedRebalanceThresholdBP forced rebalance threshold of the vault
    /// @return treasuryFeeBP treasury fee of the vault
    function vaultInfo(address vaultAddr)
        external
        view
        returns (
            address nodeOperator,
            uint256 tierId,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 treasuryFeeBP
        )
    {
        ERC7201Storage storage $ = _getStorage();

        VaultTier memory vaultTier = $.vaultTier[vaultAddr];
        tierId = vaultTier.currentTierId;

        Tier memory t = $.tiers[tierId];
        nodeOperator = t.operator;

        shareLimit = t.shareLimit;
        reserveRatioBP = t.reserveRatioBP;
        forcedRebalanceThresholdBP = t.forcedRebalanceThresholdBP;
        treasuryFeeBP = t.treasuryFeeBP;
    }

    /// @notice Validates tier parameters
    /// @param _reserveRatioBP Reserve ratio
    /// @param _forcedRebalanceThresholdBP Forced rebalance threshold
    /// @param _treasuryFeeBP Treasury fee
    function _validateParams(
      uint256 _tierId,
      uint256 _reserveRatioBP,
      uint256 _forcedRebalanceThresholdBP,
      uint256 _treasuryFeeBP
    ) internal pure {
        if (_reserveRatioBP == 0) revert ZeroArgument("_reserveRatioBP");
        if (_reserveRatioBP > TOTAL_BASIS_POINTS)
            revert ReserveRatioTooHigh(_tierId, _reserveRatioBP, TOTAL_BASIS_POINTS);

        if (_forcedRebalanceThresholdBP == 0) revert ZeroArgument("_forcedRebalanceThresholdBP");
        if (_forcedRebalanceThresholdBP > _reserveRatioBP)
            revert ForcedRebalanceThresholdTooHigh(_tierId, _forcedRebalanceThresholdBP, _reserveRatioBP);

        if (_treasuryFeeBP > TOTAL_BASIS_POINTS)
            revert TreasuryFeeTooHigh(_tierId, _treasuryFeeBP, TOTAL_BASIS_POINTS);
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    // -----------------------------
    //            EVENTS
    // -----------------------------
    event GroupAdded(address indexed nodeOperator, uint256 shareLimit);
    event GroupShareLimitUpdated(address indexed nodeOperator, uint256 shareLimit);
    event TierAdded(address indexed nodeOperator, uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatioBP, uint256 forcedRebalanceThresholdBP, uint256 treasuryFee);
    event VaultAdded(address indexed vault);
    event TierChanged(address indexed vault, uint256 indexed tierId);
    event TierChangeRequested(address indexed vault, uint256 indexed currentTierId, uint256 indexed requestedTierId);
    event TierUpdated(uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatioBP, uint256 forcedRebalanceThresholdBP, uint256 treasuryFee);

    // -----------------------------
    //            ERRORS
    // -----------------------------
    error NotAuthorized(string operation, address sender);
    error ZeroArgument(string argument);
    error GroupExists();
    error GroupNotExists();
    error GroupLimitExceeded();
    error GroupMintedSharesUnderflow();
    error NodeOperatorNotExists();
    error TierExists();
    error TiersNotAvailable();
    error TierLimitExceeded();
    error TierMintedSharesUnderflow();

    error TierNotExists();
    error TierAlreadySet();
    error TierAlreadyRequested();
    error TierNotInOperatorGroup();
    error InvalidTierId(uint256 requestedTierId, uint256 confirmedTierId);
    error CannotChangeToDefaultTier();

    error ReserveRatioTooHigh(uint256 tierId, uint256 reserveRatioBP, uint256 maxReserveRatioBP);
    error ForcedRebalanceThresholdTooHigh(uint256 tierId, uint256 forcedRebalanceThresholdBP, uint256 reserveRatioBP);
    error TreasuryFeeTooHigh(uint256 tierId, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
}
