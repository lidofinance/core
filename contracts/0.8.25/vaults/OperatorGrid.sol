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
    uint256 rebalanceThresholdBP;
    uint256 treasuryFeeBP;
}

contract OperatorGrid is AccessControlEnumerableUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant REGISTRY_ROLE = keccak256("vaults.OperatorsGrid.Registry");

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @notice Default group address
    address public constant DEFAULT_GROUP_ADDRESS = address(1);

    // -----------------------------
    //            STRUCTS
    // -----------------------------
    struct Group {
        address operator;
        uint96 shareLimit;
        uint96 mintedShares;
        uint128[] tierIds;
    }

    struct Tier {
        address operator;
        uint96 shareLimit;
        uint96 mintedShares;
        uint16 reserveRatioBP;
        uint16 rebalanceThresholdBP;
        uint16 treasuryFeeBP;
    }

    struct VaultTier {
        uint128 currentTierId;
        uint128 requestedTierId;
    }

    /**
     * @notice ERC-7201 storage namespace for the vault
     * @dev ERC-7201 namespace is used to prevent upgrade collisions
     * @custom:storage-location erc7201:Lido.Vaults.OperatorGrid
     * @custom:tiers Tiers
     * @custom:vaultTier Vault tiers
     * @custom:groups Groups
     * @custom:nodeOperators Node operators
     * @custom:pendingRequests Pending requests
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


    /// @notice Initializes the contract with an LidoLocator
    /// @param _locator Lido Locator contract
    constructor(ILidoLocator _locator) {
        LIDO_LOCATOR = _locator;

        _disableInitializers();
    }

    /// @notice Initializes the contract with an admin
    /// @param _admin Address of the admin
    /// @param _defaultShareLimit Default share limit for the default group
    function initialize(address _admin, uint256 _defaultShareLimit) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        ERC7201Storage storage $ = _getStorage();

        $.tiers.push(Tier(address(0), 0, 0, 0, 0, 0));

        //create default group with default share limit
        $.groups[DEFAULT_GROUP_ADDRESS] = Group({
            operator: DEFAULT_GROUP_ADDRESS,
            shareLimit: uint96(_defaultShareLimit),
            mintedShares: 0,
            tierIds: new uint128[](0)
        });
        $.nodeOperators.push(DEFAULT_GROUP_ADDRESS);
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
            mintedShares: 0,
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

    /// @notice Returns a node operator address
    /// @param _nodeOperator address of the node operator
    /// @return Group
    function group(address _nodeOperator) external view returns (Group memory) {
        return _getStorage().groups[_nodeOperator];
    }

    /// @notice Returns a node operator address by index
    /// @param _index index of the node operator
    /// @return Node operator address
    function nodeOperatorAddress(uint256 _index) external view returns (address) {
        return _getStorage().nodeOperators[_index];
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
            Tier memory tier_ = Tier({
                operator: _nodeOperator,
                shareLimit: uint96(_tiers[i].shareLimit),
                reserveRatioBP: uint16(_tiers[i].reserveRatioBP),
                rebalanceThresholdBP: uint16(_tiers[i].rebalanceThresholdBP),
                treasuryFeeBP: uint16(_tiers[i].treasuryFeeBP),
                mintedShares: 0
            });
            $.tiers.push(tier_);
            group_.tierIds.push(tierId);

            emit TierAdded(
                _nodeOperator,
                tierId,
                uint96(_tiers[i].shareLimit),
                uint16(_tiers[i].reserveRatioBP),
                uint16(_tiers[i].rebalanceThresholdBP),
                uint16(_tiers[i].treasuryFeeBP)
            );

            tierId++;
        }
    }

    /// @notice Returns a tier by ID
    /// @param _tierId id of the tier
    /// @return Tier
    function tier(uint256 _tierId) external view returns (Tier memory) {
        return _getStorage().tiers[_tierId];
    }

    /// @notice Alters a tier
    /// @dev We do not enforce to update old vaults with the new tier params, only new ones.
    /// @param _tierId id of the tier
    /// @param _tierParams new tier params
    function alterTier(uint256 _tierId, TierParams calldata _tierParams) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();
        Tier storage tier_ = $.tiers[_tierId];
        if ($.tiers[_tierId].operator == address(0)) revert TierNotExists();

        tier_.shareLimit = uint96(_tierParams.shareLimit);
        tier_.reserveRatioBP = uint16(_tierParams.reserveRatioBP);
        tier_.rebalanceThresholdBP = uint16(_tierParams.rebalanceThresholdBP);
        tier_.treasuryFeeBP = uint16(_tierParams.treasuryFeeBP);

        emit TierUpdated(_tierId, tier_.shareLimit, tier_.reserveRatioBP, tier_.rebalanceThresholdBP, tier_.treasuryFeeBP);
    }

    /// @notice Registers a new vault
    /// @param vault address of the vault
    function registerVault(address vault) external {
        if (vault == address(0)) revert ZeroArgument("_vault");

        ERC7201Storage storage $ = _getStorage();
        VaultTier storage vaultTier = $.vaultTier[vault];
        if (vaultTier.currentTierId > 0) revert VaultExists();

        Group storage defaultGroup = $.groups[DEFAULT_GROUP_ADDRESS];
        if (defaultGroup.tierIds.length == 0) revert TiersNotAvailable();

        uint256 tierId = defaultGroup.tierIds[0];
        vaultTier.currentTierId = uint128(tierId);

        emit VaultAdded(vault);
    }

    /// @notice Request to change tier
    /// @param _vault address of the vault
    /// @param _tierId id of the tier
    function requestTierChange(address _vault, uint256 _tierId) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (msg.sender != IStakingVault(_vault).owner()) revert NotAuthorized("requestTierChange", msg.sender);

        ERC7201Storage storage $ = _getStorage();
        if ($.tiers[_tierId].operator == address(0)) revert TierNotExists();

        uint128 tierId = uint128(_tierId);

        VaultTier storage vaultTier = $.vaultTier[_vault];
        if (vaultTier.currentTierId == tierId) revert TierAlreadySet();
        if (vaultTier.requestedTierId == tierId) revert TierAlreadyRequested();

        vaultTier.requestedTierId = tierId;

        address nodeOperator = IStakingVault(_vault).nodeOperator();
        $.pendingRequests[nodeOperator].add(_vault); //returns true if the vault was not in the set

        emit TierChangeRequested(_vault, vaultTier.currentTierId, _tierId);
    }

    /// @notice Confirm tier change request
    /// @param _vault address of the vault
    /// @param _tierIdToConfirm id of the tier to confirm
    function confirmTierChange(address _vault, uint256 _tierIdToConfirm) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        address nodeOperator = IStakingVault(_vault).nodeOperator();
        if (msg.sender != nodeOperator) revert NotAuthorized("confirmTierChange", msg.sender);

        ERC7201Storage storage $ = _getStorage();
        VaultTier storage vaultTier = $.vaultTier[_vault];
        uint128 requestedTierId = vaultTier.requestedTierId;
        if (requestedTierId == 0) revert RequestNotExists();
        if (requestedTierId != _tierIdToConfirm) revert InvalidTierId(requestedTierId, _tierIdToConfirm);

        Tier memory requestedTier = $.tiers[requestedTierId];
        address requestedTierOperator = requestedTier.operator;

        // check if tier belongs to the same group as the operator
        if (nodeOperator != requestedTierOperator) revert TierNotInOperatorGroup();

        VaultHub vaultHub = VaultHub(LIDO_LOCATOR.vaultHub());
        VaultHub.VaultSocket memory vaultSocket = vaultHub.vaultSocket(_vault);
        uint256 vaultShares = vaultSocket.sharesMinted;

        //check if tier limit is exceeded
        if (requestedTier.mintedShares + vaultShares > requestedTier.shareLimit) revert TierLimitExceeded();

        //check if group limit is exceeded
        Group storage requestedGroup = $.groups[nodeOperator];
        if (requestedGroup.mintedShares + vaultShares > requestedGroup.shareLimit) revert GroupLimitExceeded();

        Tier storage currentTier = $.tiers[vaultTier.currentTierId];
        Group storage currentGroup = $.groups[currentTier.operator];

        if (currentTier.operator != DEFAULT_GROUP_ADDRESS) {
            currentTier.mintedShares -= uint96(vaultShares);
        }
        currentGroup.mintedShares -= uint96(vaultShares);

        requestedTier.mintedShares += uint96(vaultShares);
        requestedGroup.mintedShares += uint96(vaultShares);

        vaultTier.currentTierId = requestedTierId;
        vaultTier.requestedTierId = 0;

        $.pendingRequests[nodeOperator].remove(_vault);

        VaultHub(LIDO_LOCATOR.vaultHub()).updateConnection(
            _vault,
            requestedTier.shareLimit,
            requestedTier.reserveRatioBP,
            requestedTier.rebalanceThresholdBP,
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
        if (tierId == 0) revert TierNotExists();

        Tier storage tier_ = $.tiers[tierId];
        Group storage group_ = $.groups[tier_.operator];

        uint96 amount_ = uint96(amount);

        if (tier_.mintedShares + amount_ > tier_.shareLimit) revert TierLimitExceeded();
        if (group_.mintedShares + amount_ > group_.shareLimit) revert GroupLimitExceeded();

        if (tier_.operator == DEFAULT_GROUP_ADDRESS) {
            group_.mintedShares += amount_;
        } else {
            tier_.mintedShares += amount_;
            group_.mintedShares += amount_;
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
        if (tierId == 0) revert TierNotExists();

        Tier storage tier_ = $.tiers[tierId];
        Group storage group_ = $.groups[tier_.operator];

        uint96 amount_ = uint96(amount);

        // we skip the check for minted shared underflow, because it's done in the VaultHub.burnShares()

        if (tier_.operator == DEFAULT_GROUP_ADDRESS) {
            group_.mintedShares -= amount_;
        } else {
            tier_.mintedShares -= amount_;
            group_.mintedShares -= amount_;
        }
    }

    /// @notice Get vault limits
    /// @param vaultAddr address of the vault
    /// @return nodeOperator node operator of the vault
    /// @return tierId tier id of the vault
    /// @return shareLimit share limit of the vault
    /// @return reserveRatioBP reserve ratio of the vault
    /// @return rebalanceThresholdBP rebalance threshold of the vault
    /// @return treasuryFeeBP treasury fee of the vault
    function vaultInfo(address vaultAddr)
        external
        view
        returns (
            address nodeOperator,
            uint256 tierId,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 rebalanceThresholdBP,
            uint256 treasuryFeeBP
        )
    {
        ERC7201Storage storage $ = _getStorage();

        VaultTier memory vaultTier = $.vaultTier[vaultAddr];
        tierId = vaultTier.currentTierId;
        if (tierId == 0) revert VaultNotExists();

        Tier memory t = $.tiers[tierId];
        nodeOperator = t.operator;

        shareLimit = t.shareLimit;
        reserveRatioBP = t.reserveRatioBP;
        rebalanceThresholdBP = t.rebalanceThresholdBP;
        treasuryFeeBP = t.treasuryFeeBP;
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
    event TierAdded(address indexed nodeOperator, uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatioBP, uint256 rebalanceThresholdBP, uint256 treasuryFee);
    event VaultAdded(address indexed vault);
    event TierChanged(address indexed vault, uint256 indexed tierId);
    event TierChangeRequested(address indexed vault, uint256 indexed currentTierId, uint256 indexed requestedTierId);
    event TierUpdated(uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatioBP, uint256 rebalanceThresholdBP, uint256 treasuryFee);

    // -----------------------------
    //            ERRORS
    // -----------------------------
    error NotAuthorized(string operation, address sender);
    error ZeroArgument(string argument);
    error GroupExists();
    error GroupNotExists();
    error GroupLimitExceeded();
    error GroupMintedSharesUnderflow();

    error TierExists();
    error TiersNotAvailable();
    error TierLimitExceeded();
    error TierMintedSharesUnderflow();

    error VaultExists();
    error VaultNotExists();
    error RequestNotExists();
    error RequestAlreadyExists(uint256 requestedTierId);
    error TierNotExists();
    error TierAlreadySet();
    error TierAlreadyRequested();
    error TierNotInOperatorGroup();
    error InvalidTierId(uint256 requestedTierId, uint256 confirmedTierId);
}
