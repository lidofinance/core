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
        uint256[] tiersId;
    }

    struct Tier {
        uint256 groupId;
        uint96 shareLimit;
        uint96 mintedShares;
        uint16 reserveRatioBP;
        uint16 rebalanceThresholdBP;
        uint16 treasuryFeeBP;
    }

    struct NodeOperator {
        uint256 groupId;
        address[] vaults;
    }

    // -----------------------------
    //        STORAGE
    // -----------------------------
    struct ERC7201Storage {
        mapping(uint256 groupId => Group) groups;
        uint256 groupsCount;

        Tier[] tiers;
        mapping(address vault => uint256 tierIndex) tierIndex;

        NodeOperator[] nodeOperators;
        mapping(address nodeOperator => uint256 nodeOperatorIndex) nodeOperatorIndex;
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


        $.tiers.push(Tier(0, 0, 0, 0, 0, 0));
        $.nodeOperators.push(NodeOperator(0, new address[](0)));

        //0 index uses as default group
        $.groupsCount++;
    }

    /// @notice Registers a new group
    /// @param shareLimit Maximum share limit for the group
    function registerGroup(uint256 shareLimit) external onlyRole(REGISTRY_ROLE) returns (uint256 groupId) {
        ERC7201Storage storage $ = _getStorage();

        groupId = $.groupsCount;

        Group storage group_ = $.groups[groupId];
        group_.shareLimit = uint96(shareLimit);

        $.groupsCount++;

        emit GroupAdded(groupId, uint96(shareLimit));
    }

    /// @notice Updates the share limit of a group
    /// @param groupId Group ID to update
    /// @param newShareLimit New share limit value
    function updateGroupShareLimit(uint256 groupId, uint256 newShareLimit) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();
        if (groupId >= $.groupsCount) revert GroupNotExists();

        Group storage group_ = $.groups[groupId];
        group_.shareLimit = uint96(newShareLimit);

        emit GroupShareLimitUpdated(groupId, uint96(newShareLimit));
    }

    /// @notice Returns a group by ID
    /// @param groupId Group ID
    /// @return Group
    function group(uint256 groupId) external view returns (Group memory) {
        ERC7201Storage storage $ = _getStorage();
        return $.groups[groupId];
    }

    /// @notice Returns the count of groups
    function groupCount() external view returns (uint256) {
        return _getStorage().groupsCount;
    }

    /// @notice Registers a new tier
    /// @param groupId Group ID
    /// @param tiers array of tiers to register
    function registerTiers(
        uint256 groupId,
        TierParams[] calldata tiers
    ) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();
        if (groupId >= $.groupsCount) revert GroupNotExists();

        Group storage group_ = $.groups[groupId];

        uint256 tierIndex = $.tiers.length;
        uint256 length = tiers.length;
        for (uint256 i = 0; i < length; i++) {

            Tier memory tier = Tier({
                groupId: groupId,
                shareLimit: uint96(tiers[i].shareLimit),
                reserveRatioBP: uint16(tiers[i].reserveRatioBP),
                rebalanceThresholdBP: uint16(tiers[i].rebalanceThresholdBP),
                treasuryFeeBP: uint16(tiers[i].treasuryFeeBP),
                mintedShares: 0
            });
            $.tiers.push(tier);
            group_.tiersId.push(tierIndex);

            emit TierAdded(
                groupId,
                tierIndex,
                uint96(tiers[i].shareLimit),
                uint16(tiers[i].reserveRatioBP),
                uint16(tiers[i].rebalanceThresholdBP),
                uint16(tiers[i].treasuryFeeBP)
            );

            tierIndex++;
        }
    }

    /// @notice Registers a new operator
    /// @param _operator address of the operator
    function registerOperator(address _operator) external {
        _registerOperator(_operator, 0);
    }

    /// @notice Registers a new operator
    /// @param _operator address of the operator
    /// @param _groupId identifier of the group
    function registerOperator(address _operator, uint256 _groupId) external onlyRole(REGISTRY_ROLE) {
        _registerOperator(_operator, _groupId);
    }

    function _registerOperator(address _operator, uint256 _groupId) internal {
        if (_operator == address(0)) {
            revert ZeroArgument("_operator");
        }

        ERC7201Storage storage $ = _getStorage();

        if ($.nodeOperatorIndex[_operator] > 0) {
            revert NodeOperatorExists();
        }

        if (_groupId >= $.groupsCount) revert GroupNotExists();

        $.nodeOperatorIndex[_operator] = $.nodeOperators.length;
        $.nodeOperators.push(
            NodeOperator({
                groupId: _groupId,
                vaults: new address[](0)
            })
        );

        emit NodeOperatorAdded(_groupId, _operator);
    }

    /// @notice Registers a new vault
    /// @param vault address of the vault
    function registerVault(address vault) external {
        if (vault == address(0)) revert ZeroArgument("_vault");

        ERC7201Storage storage $ = _getStorage();
        if ($.tierIndex[vault] > 0) revert VaultExists();

        address nodeOperatorAddr = IStakingVault(vault).nodeOperator();
        uint256 nodeOperatorIndex = $.nodeOperatorIndex[nodeOperatorAddr];
        if (nodeOperatorIndex == 0) revert NodeOperatorNotExists();

        NodeOperator storage nodeOperator = $.nodeOperators[nodeOperatorIndex];
        uint256 groupId = nodeOperator.groupId;
        Group storage group_ = $.groups[groupId];

        //get next tier for NO in current group
        uint256 nextTierIndex = nodeOperator.vaults.length;
        if (nextTierIndex >= group_.tiersId.length) revert TiersNotAvailable();

        nodeOperator.vaults.push(vault);

        uint256 tierId = group_.tiersId[nextTierIndex];
        $.tierIndex[vault] = tierId;

        emit VaultAdded(groupId, tierId, vault);
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

        uint256 tierId = $.tierIndex[vaultAddr];
        if (tierId == 0) revert VaultNotExists();

        uint96 amount_ = uint96(amount);

        Tier storage tier = $.tiers[tierId];
        Group storage group_ = $.groups[tier.groupId];

        if (tier.mintedShares + amount_ > tier.shareLimit) revert TierLimitExceeded();
        if (group_.mintedShares + amount_ > group_.shareLimit) revert GroupLimitExceeded();

        tier.mintedShares += amount_;
        group_.mintedShares += amount_;

        emit SharesLimitChanged(tier.groupId, tierId, vaultAddr, tier.mintedShares, group_.mintedShares);
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

        uint256 tierId = $.tierIndex[vaultAddr];
        if (tierId == 0) revert VaultNotExists();

        uint96 amount_ = uint96(amount);

        Tier storage tier = $.tiers[tierId];
        Group storage group_ = $.groups[tier.groupId];

        if (group_.mintedShares < amount_) revert GroupMintedSharesUnderflow();
        if (tier.mintedShares < amount_) revert TierMintedSharesUnderflow();

        tier.mintedShares -= amount_;
        group_.mintedShares -= amount_;

        emit SharesLimitChanged(tier.groupId, tierId, vaultAddr, tier.mintedShares, group_.mintedShares);
    }

    /// @notice Get vault limits
    /// @param vaultAddr address of the vault
    /// @return groupId group id of the vault
    /// @return tierId tier id of the vault
    /// @return shareLimit share limit of the vault
    /// @return reserveRatioBP reserve ratio of the vault
    /// @return rebalanceThresholdBP rebalance threshold of the vault
    /// @return treasuryFeeBP treasury fee of the vault
    function getVaultInfo(address vaultAddr)
    external
    view
    returns (
        uint256 groupId,
        uint256 tierId,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 rebalanceThresholdBP,
        uint256 treasuryFeeBP
    )
    {
        ERC7201Storage storage $ = _getStorage();

        tierId = $.tierIndex[vaultAddr];
        if (tierId == 0) revert VaultNotExists();

        Tier memory t = $.tiers[tierId];
        groupId = t.groupId;

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

    event GroupAdded(uint256 indexed groupId, uint256 shareLimit);
    event GroupShareLimitUpdated(uint256 indexed groupId, uint256 shareLimit);
    event TierAdded(uint256 indexed groupId, uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatioBP, uint256 rebalanceThresholdBP, uint256 treasuryFee);
    event VaultAdded(uint256 indexed groupId, uint256 indexed tierId, address indexed vault);
    event SharesLimitChanged(uint256 indexed groupId, uint256 indexed tierId, address indexed vault, uint256 tierSharesMinted, uint256 groupSharesMinted);
    event NodeOperatorAdded(uint256 indexed groupId, address indexed nodeOperator);
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

    error NodeOperatorNotExists();
    error NodeOperatorExists();
    error VaultExists();
    error VaultNotExists();
}
