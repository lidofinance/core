// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControl} from "@openzeppelin/contracts-v5.2/access/AccessControl.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

contract OperatorGrid is AccessControl {

    bytes32 public constant REGISTRY_ROLE = keccak256("vaults.OperatorsGrid.Registry");

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @notice Default group ID
    uint256 public constant DEFAULT_GROUP_ID = 1;

    // -----------------------------
    //            STRUCTS
    // -----------------------------
    struct Group {
        uint96 shareLimit;
        uint96 mintedShares;
        uint256[] tiers;
        uint256 tiersCount;
    }

    struct Tier {
        uint96 shareLimit;
        uint96 mintedShares;
        uint16 reserveRatioBP;
        uint16 rebalanceThresholdBP;
        uint16 treasuryFeeBP;
    }

    struct Operator {
        uint256 groupId;
        uint256[] vaults;
        uint256 vaultsCount;
    }

    struct Vault {
        uint256 tierId;
        uint96 mintedShares;
    }

    // -----------------------------
    //        STORAGE
    // -----------------------------
    Group[] public groups;
    mapping(uint256 => uint256) public groupIndex;

    Tier[] public tiers;
    mapping(uint256 => uint256) public tierIndex;

    Operator[] public operators;
    mapping(address => uint256) public operatorIndex;

    Vault[] public vaults;
    mapping(address => uint256) public vaultIndex;


    /// @notice Initializes the contract with an LidoLocator and admin address
    /// @param _locator Lido Locator contract
    /// @param _admin Address of the contract admin
    constructor(ILidoLocator _locator, address _admin) {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        LIDO_LOCATOR = _locator;

        //1-ind
        groups.push(Group({shareLimit: 0, mintedShares: 0, tiers: new uint256[](0), tiersCount: 0}));
        operators.push(Operator({groupId: 0, vaults: new uint256[](0), vaultsCount: 0 }));
        tiers.push(Tier({shareLimit: 0, mintedShares: 0, reserveRatioBP: 0, rebalanceThresholdBP: 0, treasuryFeeBP: 0}));
        vaults.push(Vault({tierId: 0, mintedShares: 0}));
    }

    /// @notice Registers a new group
    /// @param groupId identifier of the group
    /// @param shareLimit Maximum share limit for the group
    function registerGroup(uint256 groupId, uint256 shareLimit) external onlyRole(REGISTRY_ROLE) {
        if (groupIndex[groupId] > 0) revert GroupExists();

        //1-ind
        groupIndex[groupId] = groups.length;
        groups.push(
            Group({
                shareLimit: uint96(shareLimit),
                mintedShares: 0,
                tiers: new uint256[](0),
                tiersCount: 0
            })
        );

        emit GroupAdded(groupId, uint96(shareLimit));
    }

    /// @notice Updates the share limit of a group
    /// @param groupId Group ID to update
    /// @param newShareLimit New share limit value
    function updateGroupShareLimit(uint256 groupId, uint256 newShareLimit) external onlyRole(REGISTRY_ROLE) {
        uint256 gIdx = groupIndex[groupId];
        if (gIdx == 0) revert GroupNotExists();

        groups[gIdx].shareLimit = uint96(newShareLimit);

        emit GroupShareLimitUpdated(groupId, uint96(newShareLimit));
    }

    /// @notice Registers a new tier
    /// @param groupId identifier of the group
    /// @param tierId identifier of the tier
    /// @param shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param reserveRatioBP minimum reserve ratio in basis points
    /// @param rebalanceThresholdBP threshold to force rebalance on the vault in basis points
    /// @param treasuryFeeBP treasury fee in basis points
    function registerTier(
        uint256 groupId,
        uint256 tierId,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 rebalanceThresholdBP,
        uint256 treasuryFeeBP
    ) external onlyRole(REGISTRY_ROLE) {
        uint256 gIdx = groupIndex[groupId];
        if (gIdx == 0) revert GroupNotExists();
        if (tierIndex[tierId] > 0) revert TierExists();

        tierIndex[tierId] = tiers.length;
        tiers.push(
            Tier({
                shareLimit: uint96(shareLimit),
                mintedShares: 0,
                reserveRatioBP: uint16(reserveRatioBP),
                rebalanceThresholdBP: uint16(rebalanceThresholdBP),
                treasuryFeeBP: uint16(treasuryFeeBP)
            })
        );

        Group storage g = groups[gIdx];
        g.tiers.push(tierIndex[tierId]);
        g.tiersCount++;

        emit TierAdded(
            groupId,
            tierId,
            uint96(shareLimit),
            uint16(reserveRatioBP),
            uint16(rebalanceThresholdBP),
            uint16(treasuryFeeBP)
        );
    }

    /// @notice Registers a new operator
    /// @param _operator address of the operator
    function registerOperator(address _operator) external {
        _registerOperator(_operator, DEFAULT_GROUP_ID);
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

        if (operatorIndex[_operator] > 0) {
            revert NodeOperatorExists();
        }

        if (groupIndex[_groupId] == 0) {
            revert GroupNotExists();
        }

        operatorIndex[_operator] = operators.length;

        Operator memory operator = Operator({
            groupId: _groupId,
            vaults: new uint256[](0),
            vaultsCount: 0
        });

        operators.push(operator);

        emit OperatorAdded(_groupId, _operator);
    }

    /// @notice Registers a new vault
    /// @param vault address of the vault
    function registerVault(address vault) external {
        if (vault == address(0)) revert ZeroArgument("_vault");
        if (vaultIndex[vault] > 0) revert VaultExists();

        address operatorAddr = IStakingVault(vault).nodeOperator();
        uint256 operatorIndex = operatorIndex[operatorAddr];
        if (operatorIndex == 0) revert NodeOperatorNotExists();

        Operator storage operator = operators[operatorIndex];
        uint256 groupIndex = groupIndex[operator.groupId];
        Group memory group = groups[groupIndex];

        uint256 nextTierIndex = operator.vaultsCount;
        if (nextTierIndex >= group.tiersCount) revert TiersNotAvailable();

        Vault memory _vault = Vault({
            tierId: group.tiers[nextTierIndex],
            mintedShares: 0
        });

        vaultIndex[vault] = vaults.length;
        vaults.push(_vault);

        operator.vaults.push(vaults.length);
        operator.vaultsCount++;

        emit VaultAdded(operator.groupId, operatorAddr, vault, _vault.tierId);
    }

   // -----------------------------
   //     MINT / BURN
   // -----------------------------

    /// @notice Mint shares
    /// @param vaultAddr address of the vault
    /// @param amount amount of shares to mint
    function mintShares(
        address vaultAddr,
        uint256 amount
    ) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("mintShares", msg.sender);

        uint256 index = vaultIndex[vaultAddr];
        if (index == 0) revert VaultNotExists();

        Vault storage vault = vaults[index];

        address operatorAddr = IStakingVault(vaultAddr).nodeOperator();
        uint256 operatorIndex = operatorIndex[operatorAddr];

        Operator storage operator = operators[operatorIndex];
        uint256 groupIndex = groupIndex[operator.groupId];
        Group storage group = groups[groupIndex];

        uint96 amount_ = uint96(amount);
        if (group.mintedShares + amount_ > group.shareLimit) revert GroupLimitExceeded();

        uint256 tierIndex = tierIndex[vault.tierId];
        Tier memory tier = tiers[tierIndex];

        if (vault.mintedShares + amount_ > tier.shareLimit) revert VaultTierLimitExceeded();

        group.mintedShares += amount_;
        vault.mintedShares += amount_;

        emit Minted(operator.groupId, operatorAddr, vaultAddr, amount_);
    }

    /// @notice Burn shares
    /// @param vaultAddr address of the vault
    /// @param amount amount of shares to burn
    function burnShares(
        address vaultAddr,
        uint256 amount
    ) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized("burnShares", msg.sender);

        uint256 index = vaultIndex[vaultAddr];
        if (index == 0) revert VaultNotExists();

        Vault storage vault = vaults[index];

        address operatorAddr = IStakingVault(vaultAddr).nodeOperator();
        uint256 operatorIndex = operatorIndex[operatorAddr];

        Operator memory operator = operators[operatorIndex];
        uint256 groupIndex = groupIndex[operator.groupId];

        Group storage group = groups[groupIndex];
        uint96 amount_ = uint96(amount);

        if (group.mintedShares < amount_) revert GroupMintedSharesUnderflow();
        if (vault.mintedShares < amount_) revert VaultMintedSharesUnderflow();

        group.mintedShares -= amount_;
        vault.mintedShares -= amount_;

        emit Burned(operator.groupId, operatorAddr, vaultAddr, amount_);
    }

    /// @notice Get vault limits
    /// @param vaultAddr address of the vault
    /// @return shareLimit share limit of the vault
    /// @return reserveRatioBP reserve ratio of the vault
    /// @return rebalanceThresholdBP rebalance threshold of the vault
    /// @return treasuryFeeBP treasury fee of the vault
    function getVaultLimits(address vaultAddr)
    external
    view
    returns (
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 rebalanceThresholdBP,
        uint256 treasuryFeeBP
    )
    {
        uint256 vIdx = vaultIndex[vaultAddr];
        if (vIdx == 0) revert VaultNotExists();
        Vault memory v = vaults[vIdx];

        Tier memory t = tiers[v.tierId];

        shareLimit = t.shareLimit;
        reserveRatioBP = t.reserveRatioBP;
        rebalanceThresholdBP = t.rebalanceThresholdBP;
        treasuryFeeBP = t.treasuryFeeBP;
    }

    // -----------------------------
    //            EVENTS
    // -----------------------------

    event GroupAdded(uint256 indexed groupId, uint256 shareLimit);
    event GroupShareLimitUpdated(uint256 indexed groupId, uint256 shareLimit);
    event TierAdded(uint256 indexed groupId, uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatioBP, uint256 rebalanceThresholdBP, uint256 treasuryFee);
    event OperatorAdded(uint256 indexed groupId, address indexed operatorAddr);
    event VaultAdded(uint256 indexed groupId, address indexed operatorAddr, address indexed vault, uint256 tierId);
    event Minted(uint256 indexed groupId, address indexed operatorAddr, address indexed vault, uint256 amount);
    event Burned(uint256 indexed groupId, address indexed operatorAddr, address indexed vault, uint256 amount);

    // -----------------------------
    //            ERRORS
    // -----------------------------
    error NotAuthorized(string operation, address sender);
    error ZeroArgument(string argument);
    error GroupExists();
    error GroupNotExists();
    error TierExists();
    // error TierNotExists();
    error VaultExists();
    error VaultNotExists();
    error NodeOperatorExists();
    error NodeOperatorNotExists();
    error TiersNotAvailable();
    error GroupLimitExceeded();
    error VaultTierLimitExceeded();
    error GroupMintedSharesUnderflow();
    error VaultMintedSharesUnderflow();
}
