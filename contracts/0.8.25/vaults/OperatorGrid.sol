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
        uint256[] vaultsIndex;
    }

    struct Tier {
        uint96 shareLimit;
        uint96 mintedShares;
        uint16 reserveRatioBP;
        uint16 rebalanceThresholdBP;
        uint16 treasuryFeeBP;
    }

    struct Vault {
        uint256 groupIndex;
        uint256 tierId;
    }

    // -----------------------------
    //        STORAGE
    // -----------------------------
    struct ERC7201Storage {
        Group[] groups;
        mapping(address => uint256 groupIndex) groupIndex;

        mapping(uint256 => Tier) tiers;
        uint64 tiersCounter;

        Vault[] vaults;
        mapping(address => uint256) vaultIndex;
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

        $.groups.push(Group(0, 0, address(0), new uint256[](0), new uint256[](0)));
        $.vaults.push(Vault(0, 0));
    }

    /// @notice Registers a new group
    /// @param nodeOperator identifier of the group
    /// @param shareLimit Maximum share limit for the group
    function registerGroup(address nodeOperator, uint256 shareLimit) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();

         if ($.groupIndex[nodeOperator] > 0) revert GroupExists();

        //1-ind
        $.groupIndex[nodeOperator] = $.groups.length;
        $.groups.push(
            Group({
                shareLimit: uint96(shareLimit),
                mintedShares: 0,
                operator: nodeOperator,
                tiersId: new uint256[](0),
                vaultsIndex: new uint256[](0)
            })
        );

        emit GroupAdded(nodeOperator, uint96(shareLimit));
    }

    /// @notice Updates the share limit of a group
    /// @param nodeOperator Group ID to update
    /// @param newShareLimit New share limit value
    function updateGroupShareLimit(address nodeOperator, uint256 newShareLimit) external onlyRole(REGISTRY_ROLE) {
        ERC7201Storage storage $ = _getStorage();

        uint256 gIdx = $.groupIndex[nodeOperator];
        if (gIdx == 0) revert GroupNotExists();

        $.groups[gIdx].shareLimit = uint96(newShareLimit);

        emit GroupShareLimitUpdated(nodeOperator, uint96(newShareLimit));
    }

    function groupCount() external view returns (uint256) {
        return _getStorage().groups.length - 1;
    }

    function groupByIndex(uint256 _index) public view returns (Group memory) {
        return _getStorage().groups[_index + 1];
    }

    function group(address _nodeOperator) external view returns (Group memory) {
        ERC7201Storage storage $ = _getStorage();
        return $.groups[$.groupIndex[_nodeOperator]];
    }

    /// @notice Registers a new tier
    /// @param nodeOperator address of the operator
    /// @param shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param reserveRatioBP minimum reserve ratio in basis points
    /// @param rebalanceThresholdBP threshold to force rebalance on the vault in basis points
    /// @param treasuryFeeBP treasury fee in basis points
    function registerTier(
        address nodeOperator,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 rebalanceThresholdBP,
        uint256 treasuryFeeBP
    ) external onlyRole(REGISTRY_ROLE) returns (uint256 tierId) {
        ERC7201Storage storage $ = _getStorage();

        uint256 gIdx = $.groupIndex[nodeOperator];
        if (gIdx == 0) revert GroupNotExists();

        tierId = $.tiersCounter;
        Tier storage tier = $.tiers[tierId];
        tier.shareLimit = uint96(shareLimit);
        tier.reserveRatioBP = uint16(reserveRatioBP);
        tier.rebalanceThresholdBP = uint16(rebalanceThresholdBP);
        tier.treasuryFeeBP = uint16(treasuryFeeBP);
        tier.mintedShares = 0;

        $.tiersCounter++;

        Group storage g = $.groups[gIdx];
        g.tiersId.push(tierId);

        emit TierAdded(
            gIdx,
            tierId,
            uint96(shareLimit),
            uint16(reserveRatioBP),
            uint16(rebalanceThresholdBP),
            uint16(treasuryFeeBP)
        );
    }

    /// @notice Registers a new tier
    /// @param nodeOperator address of the operator
    /// @param tiers array of tiers to register
    function registerTiers(
        address nodeOperator,
        TierParams[] calldata tiers
    ) external onlyRole(REGISTRY_ROLE) returns (uint256 tierId) {
        ERC7201Storage storage $ = _getStorage();

        uint256 gIdx = $.groupIndex[nodeOperator];
        if (gIdx == 0) revert GroupNotExists();

        Group storage g = $.groups[gIdx];

        tierId = $.tiersCounter;
        uint256 length = tiers.length;
        for (uint256 i = 0; i < length; i++) {
            Tier storage tier = $.tiers[tierId];
            tier.shareLimit = uint96(tiers[i].shareLimit);
            tier.reserveRatioBP = uint16(tiers[i].reserveRatioBP);
            tier.rebalanceThresholdBP = uint16(tiers[i].rebalanceThresholdBP);
            tier.treasuryFeeBP = uint16(tiers[i].treasuryFeeBP);
            tier.mintedShares = 0;

            g.tiersId.push(tierId);

            emit TierAdded(
                gIdx,
                tierId,
                uint96(tiers[i].shareLimit),
                uint16(tiers[i].reserveRatioBP),
                uint16(tiers[i].rebalanceThresholdBP),
                uint16(tiers[i].treasuryFeeBP)
            );

            tierId++;
        }

        $.tiersCounter += uint64(length);
    }

    /// @notice Registers a new vault
    /// @param vault address of the vault
    function registerVault(address vault) external {
        ERC7201Storage storage $ = _getStorage();

        if (vault == address(0)) revert ZeroArgument("_vault");
        if ($.vaultIndex[vault] > 0) revert VaultExists();

        address nodeOperatorAddr = IStakingVault(vault).nodeOperator();
        uint256 groupIndex = $.groupIndex[nodeOperatorAddr];
        if (groupIndex == 0) {
            groupIndex = $.groupIndex[DEFAULT_GROUP_OPERATOR_ADDRESS];
        }
        if (groupIndex == 0) revert GroupNotExists();

        Group storage group_ = $.groups[groupIndex];
        uint256 nextTierIndex;
        if (group_.operator == DEFAULT_GROUP_OPERATOR_ADDRESS) {
            nextTierIndex = 0;
        } else {
            nextTierIndex = group_.vaultsIndex.length;
        }

        if (nextTierIndex >= group_.tiersId.length) revert TiersNotAvailable();

        uint256 tierId = group_.tiersId[nextTierIndex];
        Vault memory _vault = Vault({
            groupIndex: groupIndex,
            tierId: tierId
        });

        uint256 vaultIndex = $.vaults.length;
        $.vaultIndex[vault] = vaultIndex;
        $.vaults.push(_vault);

        group_.vaultsIndex.push(vaultIndex);

        emit VaultAdded(groupIndex, tierId, vault);
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
        uint256 index = $.vaultIndex[vaultAddr];
        if (index == 0) revert VaultNotExists();

        uint96 amount_ = uint96(amount);

        Vault memory vault = $.vaults[index];

        Tier storage tier = $.tiers[vault.tierId];
        if (tier.mintedShares + amount_ > tier.shareLimit) revert TierLimitExceeded();

        Group storage group_ = $.groups[vault.groupIndex];
        if (group_.mintedShares + amount_ > group_.shareLimit) revert GroupLimitExceeded();

        tier.mintedShares += amount_;
        group_.mintedShares += amount_;

        emit SharesLimitChanged(vaultAddr, vault.groupIndex, vault.tierId, group_.mintedShares, tier.mintedShares);
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

        uint256 index = $.vaultIndex[vaultAddr];
        if (index == 0) revert VaultNotExists();

        uint96 amount_ = uint96(amount);

        Vault memory vault = $.vaults[index];
        Tier storage tier = $.tiers[vault.tierId];
        Group storage group_ = $.groups[vault.groupIndex];

        if (group_.mintedShares < amount_) revert GroupMintedSharesUnderflow();
        if (tier.mintedShares < amount_) revert TierMintedSharesUnderflow();

        tier.mintedShares -= amount_;
        group_.mintedShares -= amount_;

        emit SharesLimitChanged(vaultAddr, vault.groupIndex, vault.tierId, tier.mintedShares, group_.mintedShares);
    }

    /// @notice Get vault limits
    /// @param vaultAddr address of the vault
    /// @return groupIndex group index of the vault
    /// @return tierId tier id of the vault
    /// @return shareLimit share limit of the vault
    /// @return reserveRatioBP reserve ratio of the vault
    /// @return rebalanceThresholdBP rebalance threshold of the vault
    /// @return treasuryFeeBP treasury fee of the vault
    function getVaultInfo(address vaultAddr)
    external
    view
    returns (
        uint256 groupIndex,
        uint256 tierId,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 rebalanceThresholdBP,
        uint256 treasuryFeeBP
    )
    {
        ERC7201Storage storage $ = _getStorage();

        uint256 index = $.vaultIndex[vaultAddr];
        if (index == 0) revert VaultNotExists();

        Vault memory v = $.vaults[index];
        Tier memory t = $.tiers[v.tierId];

        groupIndex = v.groupIndex;
        tierId = v.tierId;

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
    event TierAdded(uint256 indexed groupIndex, uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatioBP, uint256 rebalanceThresholdBP, uint256 treasuryFee);
    event NodeOperatorAdded(uint256 indexed groupIndex, address indexed nodeOperatorAddr);
    event VaultAdded(uint256 indexed groupIndex, uint256 tierId, address indexed vault);
    event SharesLimitChanged(address indexed vault, uint256 indexed groupIndex, uint256 indexed tierId, uint256 tierSharesMinted, uint256 groupSharesMinted);

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
