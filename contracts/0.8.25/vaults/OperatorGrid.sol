// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControl} from "@openzeppelin/contracts-v5.2/access/AccessControl.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

contract OperatorGrid is AccessControl {

    bytes32 public constant REGISTRY_ROLE = keccak256("vaults.OperatorsGrid.Registry");
    bytes32 public constant MINT_BURN_ROLE = keccak256("vaults.OperatorsGrid.MintBurn");

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
        uint16 reserveRatio;
        uint16 reserveRatioThreshold;
        uint16 treasuryFee;
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

    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        //1-ind
        groups.push(Group({shareLimit: 0, mintedShares: 0, tiers: new uint256[](0), tiersCount: 0}));
        operators.push(Operator({groupId: 0, vaults: new uint256[](0), vaultsCount: 0 }));
        tiers.push(Tier({shareLimit: 0, mintedShares: 0, reserveRatio: 0, reserveRatioThreshold: 0, treasuryFee: 0}));
        vaults.push(Vault({tierId: 0, mintedShares: 0}));
    }

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

    function registerOperator(address _operator) external {
        _registerOperator(_operator, 1);
    }

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

    function registerVault(address vault) external {
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

    function registerTier(
        uint256 groupId,
        uint256 tierId,
        uint256 shareLimit,
        uint256 reserveRatio,
        uint256 reserveRatioThreshold,
        uint256 treasuryFee
    ) external onlyRole(REGISTRY_ROLE) {
        uint256 gIdx = groupIndex[groupId];
        if (gIdx == 0) revert GroupNotExists();
        if (tierIndex[tierId] > 0) revert TierExists();

        tierIndex[tierId] = tiers.length;
        tiers.push(
            Tier({
                shareLimit: uint96(shareLimit),
                mintedShares: 0,
                reserveRatio: uint16(reserveRatio),
                reserveRatioThreshold: uint16(reserveRatioThreshold),
                treasuryFee: uint16(treasuryFee)
            })
        );

        Group storage g = groups[gIdx];
        g.tiers.push(tierIndex[tierId]);
        g.tiersCount++;

        emit TierAddedOrUpdated(
            groupId,
            tierId,
            uint96(shareLimit),
            uint16(reserveRatio),
            uint16(reserveRatioThreshold),
            uint16(treasuryFee)
        );
    }

    function updateGroupShareLimit(uint256 groupId, uint256 newShareLimit) external onlyRole(REGISTRY_ROLE) {
        uint256 gIdx = groupIndex[groupId];
        if (gIdx == 0) revert GroupNotExists();

        groups[gIdx].shareLimit = uint96(newShareLimit);

        emit GroupShareLimitUpdated(groupId, uint96(newShareLimit));
    }

//    function unregisterTier(uint256 tierId) external onlyRole(REGISTRY_ROLE) {
//        uint256 tIdx = tierIndex[tierId];
//        if (tIdx == 0 || tIdx >= tiers.length) revert TierNotExists();
//
//        // swap-and-pop
//        uint256 lastIdx = tiers.length - 1;
//        if (tIdx != lastIdx) {
//            Tier memory lastTier = tiers[lastIdx];
//            tiers[tIdx] = lastTier;
//            tierIndex[lastTier.id] = tIdx;
//        }
//        tiers.pop();
//        delete tierIndex[tierId];
//
//        emit TierRemoved(tierId);
//    }

//
//
//    // -----------------------------
//    //     MINT / BURN
//    // -----------------------------
//
//    /**
//     *
//     *   group limit: group.mintedShares + amount <= group.shareLimit
//     *   update shares on group/vault
//     */

    uint96 public test = 1;

    function mintShares(
        address vaultAddr,
        uint256 amount
    ) external onlyRole(MINT_BURN_ROLE) {
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

    function burnShares(
        address vaultAddr,
        uint256 amount
    ) external onlyRole(MINT_BURN_ROLE) {
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

    function getVaultLimits(address vaultAddr)
    external
    view
    returns (
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 reserveRatioThresholdBP,
        uint256 treasuryFeeBP
    )
    {
        uint256 vIdx = vaultIndex[vaultAddr];
        if (vIdx == 0) revert VaultNotExists();
        Vault memory v = vaults[vIdx];

        address opAddr = IStakingVault(vaultAddr).nodeOperator();
        uint256 opIdx = operatorIndex[opAddr];
        Tier memory t = tiers[v.tierId];

        shareLimit = t.shareLimit;
        reserveRatioBP = t.reserveRatio;
        reserveRatioThresholdBP = t.reserveRatioThreshold;
        treasuryFeeBP = t.treasuryFee;
    }

    // -----------------------------
    //            EVENTS
    // -----------------------------

    event GroupAdded(uint256 indexed groupId, uint256 shareLimit);
    event GroupShareLimitUpdated(uint256 indexed groupId, uint256 shareLimit);
    event TierAddedOrUpdated(uint256 indexed groupId, uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatio, uint256 reserveRatioThreshold, uint256 treasuryFee);
    event OperatorAdded(uint256 indexed groupId, address indexed operatorAddr);
    event VaultAdded(uint256 indexed groupId, address indexed operatorAddr, address indexed vault, uint256 tierId);
    event Minted(uint256 indexed groupId, address indexed operatorAddr, address indexed vault, uint256 amount);
    event Burned(uint256 indexed groupId, address indexed operatorAddr, address indexed vault, uint256 amount);

    // -----------------------------
    //            ERRORS
    // -----------------------------
    error ZeroArgument(string argument);
    error GroupExists();
    error GroupNotExists();
    error TierExists();
    error TierNotExists();
    error TierRemoved();
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
