// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

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

    /// @notice Default group ID
    address public constant DEFAULT_GROUP_OPERATOR_ADDRESS = address(1);

    // -----------------------------
    //            STRUCTS
    // -----------------------------
    struct Group {
        uint96 shareLimit;
        uint96 mintedShares;
        address operator;
        uint256[] tiersId;
        address[] vaults;
    }

    struct Tier {
        uint96 shareLimit;
        uint96 mintedShares;
        uint16 reserveRatioBP;
        uint16 rebalanceThresholdBP;
        uint16 treasuryFeeBP;
    }

    // -----------------------------
    //        STORAGE
    // -----------------------------
    struct ERC7201Storage {
        Tier[] tiers;
        mapping(address nodeOperator => Group) groups;
        mapping(address vault => uint256 tierIndex) tierIndex;
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

        $.tiers.push(Tier(0, 0, 0, 0, 0));
    }

    /// @notice Registers a new group
    /// @param nodeOperator identifier of the group
    /// @param shareLimit Maximum share limit for the group
    function registerGroup(address nodeOperator, uint256 shareLimit) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();

        if ($.groups[nodeOperator].operator != address(0)) revert GroupExists();

        $.groups[nodeOperator] = Group({
            shareLimit: uint96(shareLimit),
            mintedShares: 0,
            operator: nodeOperator,
            tiersId: new uint256[](0),
            vaults: new address[](0)
        });

        emit GroupAdded(nodeOperator, uint96(shareLimit));
    }

    /// @notice Updates the share limit of a group
    /// @param nodeOperator Group ID to update
    /// @param newShareLimit New share limit value
    function updateGroupShareLimit(address nodeOperator, uint256 newShareLimit) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();

        Group storage group_ = $.groups[nodeOperator];
        if (group_.operator == address(0)) revert GroupNotExists();

        group_.shareLimit = uint96(newShareLimit);

        emit GroupShareLimitUpdated(nodeOperator, uint96(newShareLimit));
    }

    function group(address _nodeOperator) external view returns (Group memory) {
        ERC7201Storage storage $ = _getStorage();
        return $.groups[_nodeOperator];
    }

    /// @notice Registers a new tier
    /// @param nodeOperator address of the operator
    /// @param tiers array of tiers to register
    function registerTiers(
        address nodeOperator,
        TierParams[] calldata tiers
    ) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();

        Group storage group_ = $.groups[nodeOperator];
        if (group_.operator == address(0)) revert GroupNotExists();

        uint256 tierIndex = $.tiers.length;
        uint256 length = tiers.length;
        for (uint256 i = 0; i < length; i++) {

            Tier memory tier = Tier({
                shareLimit: uint96(tiers[i].shareLimit),
                reserveRatioBP: uint16(tiers[i].reserveRatioBP),
                rebalanceThresholdBP: uint16(tiers[i].rebalanceThresholdBP),
                treasuryFeeBP: uint16(tiers[i].treasuryFeeBP),
                mintedShares: 0
            });
            $.tiers.push(tier);
            group_.tiersId.push(tierIndex);

            emit TierAdded(
                nodeOperator,
                tierIndex,
                uint96(tiers[i].shareLimit),
                uint16(tiers[i].reserveRatioBP),
                uint16(tiers[i].rebalanceThresholdBP),
                uint16(tiers[i].treasuryFeeBP)
            );

            tierIndex++;
        }
    }

    /// @notice Registers a new vault
    /// @param vault address of the vault
    function registerVault(address vault) external {
        if (vault == address(0)) revert ZeroArgument("_vault");

        ERC7201Storage storage $ = _getStorage();

        if ($.tierIndex[vault] > 0) revert VaultExists();

        address nodeOperatorAddr = IStakingVault(vault).nodeOperator();
        Group storage group_ = $.groups[nodeOperatorAddr];
        if (group_.operator == address(0)) {
            group_ = $.groups[DEFAULT_GROUP_OPERATOR_ADDRESS];
        }
        if (group_.operator == address(0)) revert GroupNotExists();

        uint256 nextTierIndex;
        if (group_.operator == DEFAULT_GROUP_OPERATOR_ADDRESS) {
            nextTierIndex = 0;
        } else {
            nextTierIndex = group_.vaults.length;
        }

        if (nextTierIndex >= group_.tiersId.length) revert TiersNotAvailable();

        uint256 tierId = group_.tiersId[nextTierIndex];

        $.tierIndex[vault] = tierId;
        group_.vaults.push(vault);

        emit VaultAdded(nodeOperatorAddr, tierId, vault);
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

        uint256 tierIndex = $.tierIndex[vaultAddr];
        if (tierIndex == 0) revert VaultNotExists();

        address nodeOperator = IStakingVault(vaultAddr).nodeOperator();
        Group storage group_ = $.groups[nodeOperator];

        if (group_.operator == address(0)) {
            group_ = $.groups[DEFAULT_GROUP_OPERATOR_ADDRESS];
        }

        uint96 amount_ = uint96(amount);

        Tier storage tier = $.tiers[tierIndex];
        if (tier.mintedShares + amount_ > tier.shareLimit) revert TierLimitExceeded();
        if (group_.mintedShares + amount_ > group_.shareLimit) revert GroupLimitExceeded();

        tier.mintedShares += amount_;
        group_.mintedShares += amount_;

        emit SharesLimitChanged(vaultAddr, group_.operator, tierIndex, tier.mintedShares, group_.mintedShares);
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

        uint256 tierIndex = $.tierIndex[vaultAddr];
        if (tierIndex == 0) revert VaultNotExists();

        address nodeOperator = IStakingVault(vaultAddr).nodeOperator();
        Group storage group_ = $.groups[nodeOperator];

        if (group_.operator == address(0)) {
            group_ = $.groups[DEFAULT_GROUP_OPERATOR_ADDRESS];
        }

        uint96 amount_ = uint96(amount);

        Tier storage tier = $.tiers[tierIndex];

        if (group_.mintedShares < amount_) revert GroupMintedSharesUnderflow();
        if (tier.mintedShares < amount_) revert TierMintedSharesUnderflow();

        tier.mintedShares -= amount_;
        group_.mintedShares -= amount_;

        emit SharesLimitChanged(vaultAddr, nodeOperator, tierIndex, tier.mintedShares, group_.mintedShares);
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

        uint256 tierIndex = $.tierIndex[vaultAddr];
        if (tierIndex == 0) revert VaultNotExists();

        Tier memory t = $.tiers[tierIndex];

        address nodeOperatorAddr = IStakingVault(vaultAddr).nodeOperator();
        nodeOperator = $.groups[nodeOperatorAddr].operator;
        if (nodeOperator == address(0)) {
            nodeOperator = $.groups[DEFAULT_GROUP_OPERATOR_ADDRESS].operator;
        }
        tierId = tierIndex;


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
    event VaultAdded(address indexed nodeOperator, uint256 tierId, address indexed vault);
    event SharesLimitChanged(address indexed vault, address indexed nodeOperator, uint256 indexed tierId, uint256 tierSharesMinted, uint256 groupSharesMinted);

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
}
