// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";

contract OperatorGrid {
    struct Node {
        uint256 shareLimit;
        uint256 reserveRatio;
    }

    struct Config {
        uint256 maxVaults;
        uint256 maxShareLimit;
        Node[] reserveRatioVaultIndex;
    }

    struct NodeOperator {
        uint256 configId;
        mapping(address => uint256) vaultIndex;
        uint256 vaultsCount;
    }

    mapping(uint256 => Config) public configs;
    mapping(address => NodeOperator) public nodeOperators;
    uint8 public configCount;

    function initialize() external {
        Node[] memory basisNodes = new Node[](1);
        basisNodes[0] = Node({shareLimit: 0, reserveRatio: 2_000});
        addConfig(type(uint16).max, 1_000_000, basisNodes);

        Node[] memory curatedNodes = new Node[](5);
        curatedNodes[0] = Node({shareLimit: 50_000, reserveRatio: 500});
        curatedNodes[1] = Node({shareLimit: 100_000, reserveRatio: 600});
        curatedNodes[2] = Node({shareLimit: 200_000, reserveRatio: 900});
        curatedNodes[3] = Node({shareLimit: 300_000, reserveRatio: 1_400});
        curatedNodes[4] = Node({shareLimit: 400_000, reserveRatio: 2_000});

        addConfig(5, 3_300_000, curatedNodes);
    }

    function addConfig(uint256 maxVaults, uint256 maxShareLimit, Node[] memory nodes) public {
        configs[configCount].maxVaults = maxVaults;
        configs[configCount].maxShareLimit = maxShareLimit;
        for (uint256 i = 0; i < nodes.length; i++) {
            configs[configCount].reserveRatioVaultIndex.push(nodes[i]);
        }
        configCount++;
    }

    function updateConfig(uint256 index, uint256 maxVaults, uint256 maxShareLimit, Node[] memory nodes) external {
        require(index < configCount, "Invalid config index");
        Config storage config = configs[index];
        config.maxVaults = maxVaults;
        config.maxShareLimit = maxShareLimit;
        delete config.reserveRatioVaultIndex;
        for (uint256 i = 0; i < nodes.length; i++) {
            config.reserveRatioVaultIndex.push(nodes[i]);
        }
    }

    function removeConfig(uint256 index) public {
        require(index < configCount, "Invalid config index");
        delete configs[index];
    }

    function addVault(address vault, uint256 vaultIndex) public {
        address operator = IStakingVault(vault).nodeOperator();

        NodeOperator storage nodeOperator = nodeOperators[operator];
        nodeOperator.vaultIndex[vault] = vaultIndex;
        nodeOperator.vaultsCount++;
    }

    function updateNodeOperatorConfig(address operator, uint256 newConfigId) public {
        require(newConfigId < configCount, "Invalid config ID");
        nodeOperators[operator].configId = newConfigId;
    }

    function getNodeOperatorLimits(address vault) external view returns (Node memory) {
        address operator = IStakingVault(vault).nodeOperator();
        NodeOperator storage nodeOperator = nodeOperators[operator];

        uint256 vaultIndex = nodeOperator.vaultIndex[vault];

        require(vaultIndex < configs[nodeOperator.configId].reserveRatioVaultIndex.length, "Invalid vault index");
        return configs[nodeOperator.configId].reserveRatioVaultIndex[vaultIndex];
    }
}
