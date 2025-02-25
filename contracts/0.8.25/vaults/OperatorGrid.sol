// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControl} from "@openzeppelin/contracts-v5.2/access/AccessControl.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

contract OperatorGrid is AccessControl {
    bytes32 public constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");

    struct VaultData {
        bool exists;
        uint256 tierId;
        uint256 mintedShares;
    }

    struct OperatorData {
        bool exists;
        uint256 groupId;
        mapping(address => VaultData) vaults;
        uint256 vaultCount;
    }

    struct TierData {
        bool exists;
        uint256 shareLimit;
        uint256 mintedShares;
        uint256 reserveRatio;
        uint256 reserveRatioThreshold;
        uint256 treasuryFee;
    }

    struct GroupData {
        bool exists;
        uint256 shareLimit;
        uint256 mintedShares;
        mapping(uint256 => TierData) tiers;
        uint256 tiersCount;
    }

    mapping(uint256 => GroupData) public groups;
    mapping(address => OperatorData) public operators;

    // -----------------------------
    //            EVENTS
    // -----------------------------

    event GroupAdded(uint256 indexed groupId, uint256 shareLimit);
    event TierAddedOrUpdated(uint256 indexed groupId, uint256 indexed tierId, uint256 shareLimit, uint256 reserveRatio, uint256 reserveRatioThreshold);
    event OperatorAdded(uint256 indexed groupId, address indexed operatorAddr);
    event VaultAdded(uint256 indexed groupId, address indexed operatorAddr, uint256 tierId);
    event Minted(uint256 indexed groupId, address indexed operatorAddr, address indexed vault, uint256 amount);
    event Burned(uint256 indexed groupId, address indexed operatorAddr, address indexed vault, uint256 amount);

    // -----------------------------
    //        GROUPS
    // -----------------------------

    function addGroup(uint256 groupId, uint256 shareLimit) external {
        GroupData storage g = groups[groupId];
        require(!g.exists, "Group already exists");

        g.exists = true;
        g.shareLimit = shareLimit;
        g.mintedShares = 0;

        emit GroupAdded(groupId, shareLimit);
    }

    function updateGroupShareLimit(uint256 groupId, uint256 newShareLimit) external {
        GroupData storage g = groups[groupId];
        require(g.exists, "Group does not exist");

        g.shareLimit = newShareLimit;
    }

    // -----------------------------
    //        TIERS
    // -----------------------------

    function addTier(
        uint256 groupId,
        uint256 tierId,
        uint256 shareLimit,
        uint256 reserveRatio,
        uint256 reserveRatioThreshold
    ) external {
        GroupData storage g = groups[groupId];
        require(g.exists, "Group does not exist");

        TierData storage t = g.tiers[tierId];
        if (!t.exists) {
            t.exists = true;
            t.mintedShares = 0;
        }

        t.shareLimit = shareLimit;
        t.reserveRatio = reserveRatio;
        t.reserveRatioThreshold = reserveRatioThreshold;
        g.tiersCount++;

        emit TierAddedOrUpdated(groupId, tierId, shareLimit, reserveRatio, reserveRatioThreshold);
    }

    // -----------------------------
    //      NO
    // -----------------------------

    function addOperator(address operatorAddr) external {
        _addOperator(0, operatorAddr);
    }
    function addOperator(address operatorAddr, uint256 groupId) external {
        require(hasRole(REGISTRY_ROLE, msg.sender));
        _addOperator(groupId, operatorAddr);
    }

    function _addOperator(uint256 groupId, address operatorAddr) internal {
        GroupData storage g = groups[groupId];
        require(g.exists, "Group does not exist");

        OperatorData storage op = operators[operatorAddr];
        require(!op.exists, "Operator already exists in this group");

        op.exists = true;
        op.groupId = groupId;

        emit OperatorAdded(groupId, operatorAddr);
    }

    // -----------------------------
    //       VAULS
    // -----------------------------

    function addVault(address vault, uint256 groupId) external {
        GroupData storage g = groups[groupId];
        require(g.exists, "Group does not exist");

        OperatorData storage op = operators[IStakingVault(vault).nodeOperator()];
        require(op.exists, "Operator does not exist");

        VaultData storage v = op.vaults[vault];
        require(!v.exists, "Vault already exists");

        uint256 nextTierIndex = op.vaultCount;
        require(nextTierIndex < g.tiersCount, "No more tiers available");

        v.exists = true;
        v.tierId = nextTierIndex;
        v.mintedShares = 0;

        op.vaultCount += 1;

        emit VaultAdded(groupId, vault, nextTierIndex);
    }

    // -----------------------------
    //     MINT / BURN
    // -----------------------------

    /**
     *
     *   group limit: group.mintedShares + amount <= group.shareLimit
     *   tier limit: tier.mintedShares + amount <= tier.shareLimit
     *   update shares on group/tier/vault
     */
    function mintShares(
        address vault,
        uint256 amount
    ) external {
        address operatorAddr = IStakingVault(vault).nodeOperator();
        OperatorData storage op = operators[operatorAddr];
        require(op.exists, "Operator does not exist in this group");

        GroupData storage g = groups[op.groupId];
        require(g.exists, "Group does not exist");

        VaultData storage v = op.vaults[vault];
        require(v.exists, "Vault does not exist under this operator");

        // group limit
        require(g.mintedShares + amount <= g.shareLimit, "Group limit exceeded");

        TierData storage t = g.tiers[v.tierId];
        require(t.exists, "Tier does not exist");
        require(v.mintedShares + amount <= t.shareLimit, "Vault tier limit exceeded");

        g.mintedShares += amount;
        v.mintedShares += amount;

        emit Minted(op.groupId, operatorAddr, vault, amount);
    }

    function burnShares(
        address vault,
        uint256 amount
    ) external {
        address operatorAddr = IStakingVault(vault).nodeOperator();
        OperatorData storage op = operators[operatorAddr];
        require(op.exists, "Operator does not exist in this group");

        GroupData storage g = groups[op.groupId];
        require(g.exists, "Group does not exist");

        VaultData storage v = op.vaults[vault];
        require(v.exists, "Vault does not exist under this operator");
        require(v.mintedShares >= amount, "Not enough vault shares to burn");

        g.mintedShares -= amount;
        v.mintedShares -= amount;

        emit Burned(op.groupId, operatorAddr, vault, amount);
    }

    function getVaultLimits(address vault)
    external
    view
    returns (
        uint256 shareLimit,
        uint256 reserveRatio,
        uint256 reserveRatioThreshold,
        uint256 treasuryFee
    )
    {
        address operatorAddr = IStakingVault(vault).nodeOperator();
        OperatorData storage op = operators[operatorAddr];
        require(op.exists, "Operator does not exist in this group");

        VaultData storage v = op.vaults[vault];
        require(v.exists, "Vault not found in OperatorGrid");

        GroupData storage g = groups[op.groupId];
        require(g.exists, "Group does not exist?");

        TierData storage t = g.tiers[v.tierId];
        require(t.exists, "Tier not found?");

        shareLimit = t.shareLimit;
        reserveRatio = t.reserveRatio;
        reserveRatioThreshold = t.reserveRatioThreshold;
        treasuryFee = t.treasuryFee;
    }
}
