// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";

/**
 * @title Share Target Allocation Strategy (STAS) shared types
 * @author KRogLA
 */

struct Metric {
    uint16 defaultWeight; // default weight for the metric in strategies
}

struct Strategy {
    // todo extend to Q32.32 precision?
    uint256 packedWeights; // packed weights for all metrics, 16x uint16
    uint256 sumWeights;
    // todo reduce to packed 8x uint32 into 2 uint256?
    uint256[16] sumX;
}

struct Entity {
    uint256 packedMetricValues; // packed params 16x uint16 in one uint256
}

struct STASStorage {
    uint16 enabledMetricsBitMask;
    uint16 enabledStrategiesBitMask;
    mapping(uint256 => Metric) metrics; // mapping of metrics to their states
    mapping(uint256 => Strategy) strategies; // mapping of strategies to their states
    mapping(uint256 => Entity) entities; // id => Entity
    EnumerableSet.UintSet entityIds; // set of entity IDs
}

/// @dev Helper struct for sorting entities during "Water filling" allocation
struct SortIndexedTarget {
    uint256 idx;
    uint256 target;
}
