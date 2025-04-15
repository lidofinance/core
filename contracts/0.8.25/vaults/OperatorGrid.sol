// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

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
        uint256[] tiersId;
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
        uint128 tierIndex;
        uint128 tierIndexRequested;
    }

    // -----------------------------
    //        STORAGE
    // -----------------------------
    struct ERC7201Storage {
        Tier[] tiers;
        mapping(address vault => VaultTier) vaultTier;
        mapping(address nodeOperator => Group) groups;
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

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        ERC7201Storage storage $ = _getStorage();

        $.tiers.push(Tier(address(0), 0, 0, 0, 0, 0));
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
            tiersId: new uint256[](0)
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

    /// @notice Returns a group by ID
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

        uint256 tierIndex = $.tiers.length;
        uint256 length = _tiers.length;
        for (uint256 i = 0; i < length; i++) {

            Tier memory tier = Tier({
                operator: _nodeOperator,
                shareLimit: uint96(_tiers[i].shareLimit),
                reserveRatioBP: uint16(_tiers[i].reserveRatioBP),
                rebalanceThresholdBP: uint16(_tiers[i].rebalanceThresholdBP),
                treasuryFeeBP: uint16(_tiers[i].treasuryFeeBP),
                mintedShares: 0
            });
            $.tiers.push(tier);
            group_.tiersId.push(tierIndex);

            emit TierAdded(
                _nodeOperator,
                tierIndex,
                uint96(_tiers[i].shareLimit),
                uint16(_tiers[i].reserveRatioBP),
                uint16(_tiers[i].rebalanceThresholdBP),
                uint16(_tiers[i].treasuryFeeBP)
            );

            tierIndex++;
        }
    }

    /// @notice Appends a single tier to an existing group
    /// @param _nodeOperator address of the node operator
    /// @param _tier Parameters for the new tier
    function appendTier(
        address _nodeOperator,
        TierParams calldata _tier
    ) external onlyRole(REGISTRY_ROLE) {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        ERC7201Storage storage $ = _getStorage();
        Group storage group_ = $.groups[_nodeOperator];
        if (group_.operator == address(0)) revert GroupNotExists();

        uint256 tierIndex = $.tiers.length;

        Tier memory newTier = Tier({
            operator: _nodeOperator,
            shareLimit: uint96(_tier.shareLimit),
            reserveRatioBP: uint16(_tier.reserveRatioBP),
            rebalanceThresholdBP: uint16(_tier.rebalanceThresholdBP),
            treasuryFeeBP: uint16(_tier.treasuryFeeBP),
            mintedShares: 0
        });

        $.tiers.push(newTier);
        group_.tiersId.push(tierIndex);

        emit TierAdded(
            _nodeOperator,
            tierIndex,
            uint96(_tier.shareLimit),
            uint16(_tier.reserveRatioBP),
            uint16(_tier.rebalanceThresholdBP),
            uint16(_tier.treasuryFeeBP)
        );
    }


    /// @notice Registers a new vault
    /// @param vault address of the vault
    function registerVault(address vault) external {
        if (vault == address(0)) revert ZeroArgument("_vault");

        ERC7201Storage storage $ = _getStorage();
        VaultTier storage vaultTier = $.vaultTier[vault];
        if (vaultTier.tierIndex > 0) revert VaultExists();

        Group storage defaultGroup = $.groups[DEFAULT_GROUP_ADDRESS];
        if (defaultGroup.tiersId.length == 0) revert TiersNotAvailable();

        uint256 tierId = defaultGroup.tiersId[0];
        vaultTier.tierIndex = uint128(tierId);

        emit VaultAdded(DEFAULT_GROUP_ADDRESS, tierId, vault);
    }

    /// @notice Request to change tier
    /// @param _vault address of the vault
    /// @param _tierId id of the tier
    function requestTierChange(address _vault, uint256 _tierId) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (msg.sender != OwnableUpgradeable(_vault).owner()) revert NotAuthorized("requestTierChange", msg.sender);

        ERC7201Storage storage $ = _getStorage();
        if ($.tiers[_tierId].operator == address(0)) revert TiersNotAvailable();

        VaultTier storage vaultTier = $.vaultTier[_vault];
        uint256 requestedTierId = vaultTier.tierIndexRequested;
        if (requestedTierId != 0) revert RequestAlreadyExists(requestedTierId);
        if (vaultTier.tierIndex == _tierId) revert TierAlreadySet();

        vaultTier.tierIndexRequested = uint128(_tierId);

        emit TierChangeRequested(_vault, _tierId);
    }

    /// @notice Approve tier change request
    /// @param _vault address of the vault
    function confirmTierChange(address _vault) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        address nodeOperator = IStakingVault(_vault).nodeOperator();
        if (msg.sender != nodeOperator) revert NotAuthorized("confirmTierChange", msg.sender);

        ERC7201Storage storage $ = _getStorage();
        VaultTier storage vaultTier = $.vaultTier[_vault];
        uint256 requestedTierId = vaultTier.tierIndexRequested;
        if (requestedTierId == 0) revert RequestNotExists();

        Tier memory requestedTier = $.tiers[requestedTierId];
        address requestedTierOperator = requestedTier.operator;

        // check if tier belongs to the same group as the operator
        if (nodeOperator != requestedTierOperator) revert TierNotInOperatorGroup();

        VaultHub vaultHub = VaultHub(LIDO_LOCATOR.vaultHub());
        uint256 vaultShares = vaultHub.vaultSocket(_vault).sharesMinted;

        //check if tier limit is exceeded
        if (requestedTier.mintedShares + vaultShares > requestedTier.shareLimit) revert TierLimitExceeded();

        //check if group limit is exceeded
        Group storage group_ = $.groups[nodeOperator];
        if (group_.mintedShares + vaultShares > group_.shareLimit) revert GroupLimitExceeded();

        Tier storage currentTier = $.tiers[vaultTier.tierIndex];

        currentTier.mintedShares -= uint96(vaultShares);
        requestedTier.mintedShares += uint96(vaultShares);

        vaultTier.tierIndex = uint128(requestedTierId);
        vaultTier.tierIndexRequested = 0;

        emit TierChanged(_vault, requestedTierId);
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
        uint256 tierId = vaultTier.tierIndex;
        if (tierId == 0) revert VaultNotExists();

        Tier storage tier = $.tiers[tierId];
        Group storage group_ = $.groups[tier.operator];

        uint96 amount_ = uint96(amount);

        if (tier.mintedShares + amount_ > tier.shareLimit) revert TierLimitExceeded();
        if (group_.mintedShares + amount_ > group_.shareLimit) revert GroupLimitExceeded();

        tier.mintedShares += amount_;
        group_.mintedShares += amount_;

        emit SharesLimitChanged(tier.operator, tierId, vaultAddr, tier.mintedShares, group_.mintedShares);
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
        uint256 tierId = vaultTier.tierIndex;
        if (tierId == 0) revert VaultNotExists();

        Tier storage tier = $.tiers[tierId];
        Group storage group_ = $.groups[tier.operator];

        uint96 amount_ = uint96(amount);

        if (group_.mintedShares < amount_) revert GroupMintedSharesUnderflow();
        if (tier.mintedShares < amount_) revert TierMintedSharesUnderflow();

        tier.mintedShares -= amount_;
        group_.mintedShares -= amount_;

        emit SharesLimitChanged(tier.operator, tierId, vaultAddr, tier.mintedShares, group_.mintedShares);
    }

    /// @notice Get vault limits
    /// @param vaultAddr address of the vault
    /// @return nodeOperator node operator of the vault
    /// @return tierId tier id of the vault
    /// @return shareLimit share limit of the vault
    /// @return reserveRatioBP reserve ratio of the vault
    /// @return rebalanceThresholdBP rebalance threshold of the vault
    /// @return treasuryFeeBP treasury fee of the vault
    function getVaultInfo(address vaultAddr)
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
        tierId = vaultTier.tierIndex;
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
    event VaultAdded(address indexed nodeOperator, uint256 indexed tierId, address indexed vault);
    event SharesLimitChanged(address indexed nodeOperator, uint256 indexed tierId, address indexed vault, uint256 tierSharesMinted, uint256 groupSharesMinted);
    event TierChanged(address indexed vault, uint256 indexed tierId);
    event TierChangeRequested(address indexed vault, uint256 indexed tierId);
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
    error TierAlreadySet();
    error TierNotInOperatorGroup();
}
