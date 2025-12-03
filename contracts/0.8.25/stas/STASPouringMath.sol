// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {Math} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {STASCore} from "./STASCore.sol";

/// @dev Helper struct for input allocation state
struct AllocationState {
    uint256[] shares;
    uint256[] amounts;
    uint256[] capacities;
    uint256 totalAmount;
}

/**
 * @title Pouring Math for STAS
 * @author KRogLA
 * @notice Provides allocation logic functions for the Share Target Allocation Strategy (STAS)
 * @dev This library includes functions for calculating allocation based on 2 approaches of water-filling algorithms
 */
library STASPouringMath {
    struct DemandFillsCache {
        int256[] imbalances; // quantized imbalances versus target shares
        uint256[] imbalancesSortMap;
        uint256[] capacities; // quantized capacities
        uint256[] fills;
        uint256[] demands;
        uint256[] demandsMap;
        uint256 demandsCount;
    }

    /// @param state The current allocation state
    /// @param inflow The new inflow to allocate
    /// @param step The quantization step for imbalances
    /// @param ignoreShares If true, ignores shares and allocates outflow proportionally to
    function _allocate(AllocationState memory state, uint256 inflow, uint256 step, bool ignoreShares)
        internal
        pure
        returns (int256[] memory imbalances, uint256[] memory fills, uint256 rest)
    {
        (DemandFillsCache memory cache, uint256 n) = _checkAndPrepareCache(state, inflow, step, true);
        if (n == 0) {
            // no baskets, return full inflow as rest
            return (new int256[](0), new uint256[](0), inflow);
        }
        rest = inflow;
        if (rest > 0) {
            _calculateDemands(cache, ignoreShares);
            rest = _fulfillDemands(cache, rest, step);
        }
        return (cache.imbalances, cache.fills, rest);
    }

    /// @param state The current allocation state
    /// @param outflow The new outflow to deallocate
    /// @param step The quantization step for imbalances
    /// @param ignoreShares If true, ignores shares and allocates outflow proportionally to
    /// @dev assumes all inputs in `state` are valid:
    /// - sum of all `shares` less or equal to `STASCore.S_SCALE`
    /// - sum of all `amounts` less or equal to `totalAmount`
    function _deallocate(AllocationState memory state, uint256 outflow, uint256 step, bool ignoreShares)
        internal
        pure
        returns (int256[] memory imbalances, uint256[] memory fills, uint256 rest)
    {
        (DemandFillsCache memory cache, uint256 n) = _checkAndPrepareCache(state, outflow, step, false);
        if (n == 0) {
            // no baskets, return full outflow as rest
            return (new int256[](0), new uint256[](0), outflow);
        }
        rest = outflow;

        if (rest > 0) {
            _calculateDemands(cache, ignoreShares);
            rest = _fulfillDemands(cache, rest, step);
        }
        return (cache.imbalances, cache.fills, rest);
    }

    /// @notice Check input data and prepare cache for allocation/deallocation
    /// @dev imbalance/capacities values are quantized to `step` multiples
    function _checkAndPrepareCache(AllocationState memory state, uint256 diffAmount, uint256 step, bool allocate)
        internal
        pure
        returns (DemandFillsCache memory cache, uint256 n)
    {
        n = state.shares.length;

        if (state.amounts.length != n || (allocate && state.capacities.length != n)) {
            revert STASCore.LengthMismatch();
        }

        if (n > 0) {
            cache.imbalances = new int256[](n);
            cache.fills = new uint256[](n);

            uint256 totalAmount = state.totalAmount;
            uint256 targetAmount;

            if (allocate) {
                targetAmount = totalAmount + diffAmount;
                // reuse input capacities array for quantization
                cache.capacities = state.capacities;
            } else {
                unchecked {
                    // prevent underflow
                    targetAmount = totalAmount > diffAmount ? totalAmount - diffAmount : 0;
                }
                // reuse input capacities array for quantization
                cache.capacities = state.amounts;
            }

            unchecked {
                for (uint256 i; i < n; ++i) {
                    uint256 target = state.shares[i];
                    if (target != 0) {
                        target = Math.mulDiv(target, targetAmount, STASCore.S_SCALE, Math.Rounding.Ceil);
                    }
                    // get quantized imbalance versus target
                    // forge-lint: disable-next-line(unsafe-typecast)
                    cache.imbalances[i] = _quantize(
                        allocate
                            ? int256(target) - int256(state.amounts[i])
                            : int256(state.amounts[i]) - int256(target),
                        step
                    );
                    // mutate capacities to quantized values
                    cache.capacities[i] = _quantize(cache.capacities[i], step);
                }
            }
            // sorting imbalances descending
            cache.imbalancesSortMap = _getSortMap(cache.imbalances);
            // preallocate demands helper arrays
            cache.demands = new uint256[](n);
            cache.demandsMap = new uint256[](n);
        }
    }

    function _calculateDemands(DemandFillsCache memory cache, bool ignoreImbalance) internal pure {
        uint256 n = cache.imbalancesSortMap.length;
        uint256 demandsCount = 0;

        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 idx = cache.imbalancesSortMap[i];
                uint256 capacity = cache.capacities[idx];
                if (capacity == 0) continue;

                uint256 filled = cache.fills[idx];
                if (filled > 0) {
                    capacity = capacity > filled ? capacity - filled : 0;
                }

                if (capacity > 0) {
                    uint256 demand;
                    if (ignoreImbalance) {
                        demand = capacity;
                    } else {
                        // select under-filled only
                        int256 imbalance = cache.imbalances[idx];
                        if (imbalance > 0) {
                            // forge-lint: disable-next-line(unsafe-typecast)
                            demand = Math.min(uint256(imbalance), capacity);
                        }
                    }

                    // safely ignore zero demands as they won't be included in demandsMap and counted in demandsCount
                    if (demand > 0) {
                        cache.demands[idx] = demand;
                        cache.demandsMap[demandsCount] = idx;
                        ++demandsCount;
                    }
                }
            }
            cache.demandsCount = demandsCount;
        }
    }

    // @nietice Distribute `amount` across demands in `cache`, modifying `cache.fills`
    // @dev Assumes `cache` is prepared:
    // - `cache.imbalances` filled via `_checkAndPrepareCache`
    // - `cache.demands` and `cache.demandsMap` are filled and sorted via `_calculateDemands` (i.e. based on  `cache.imbalancesSortMap`)
    function _fulfillDemands(DemandFillsCache memory cache, uint256 amount, uint256 step)
        internal
        pure
        returns (uint256)
    {
        uint256 demandsCount = cache.demandsCount;
        if (demandsCount == 0) return amount;

        unchecked {
            // initial demand fills count at current level, at least one
            uint256 levelFillsCount = 1;
            // initial("ground") fill level, assume  at least first element present
            int256 currentFillLevel = cache.imbalances[cache.demandsMap[0]];
            uint256 processedCount = 0;
            uint256 delta;
            while (amount > 0 && processedCount < demandsCount) {
                while (levelFillsCount < demandsCount) {
                    int256 nextFillLevel = cache.imbalances[cache.demandsMap[levelFillsCount]];
                    // fillLevel values should be sorted via demandsMap
                    assert(currentFillLevel >= nextFillLevel);

                    // due to *fillLevel (imbalances) values are quantized, the delta is also quantized
                    // forge-lint: disable-next-line(unsafe-typecast)
                    delta = uint256(currentFillLevel - nextFillLevel);
                    if (delta > 0) {
                        break;
                    }
                    ++levelFillsCount;
                }

                uint256 amountQuant = _quantize(amount / levelFillsCount, step);
                if (delta == 0 || delta > amountQuant) {
                    uint256 levelDemandsCount = levelFillsCount;
                    while (amountQuant == 0 && levelDemandsCount > 1) {
                        --levelDemandsCount;
                        amountQuant = _quantize(amount / levelDemandsCount, step);
                    }

                    // break the loop if `amount` is not enough to fill at least one demand item
                    if (amountQuant == 0) {
                        break;
                    }
                    if (delta > 0) {
                        // update current fill level by amountQuant only if delta was non-zero, i.e. we are below next level
                        currentFillLevel -= int256(amountQuant);
                    }
                    delta = amountQuant;
                } else {
                    // update fill level to next level
                    currentFillLevel -= int256(delta);
                }

                processedCount = 0;

                // need to fill all remaining items at same level, try spread evenly starting from first item
                for (uint256 i = 0; i < levelFillsCount && amount > 0; ++i) {
                    // get original item index
                    uint256 idx = cache.demandsMap[i];
                    // get current demand & filled amount
                    uint256 demand = cache.demands[idx];
                    uint256 filled = cache.fills[idx];
                    // if (demand == 0) continue;

                    if (filled < demand) {
                        // demand and delta are quantized, so fill is also quantized
                        uint256 fill = Math.min(demand - filled, delta);
                        if (fill > amount) {
                            break;
                        }
                        amount -= fill;
                        filled += fill;
                        cache.fills[idx] = filled;
                    }
                    // if element reached capacity and already (over) filled, skip it
                    if (filled >= demand) {
                        ++processedCount;
                    }
                }
            }
        }
        return amount;
    }

    /// HELPERS

    /// @notice quantize int value multiple of step
    function _quantize(int256 value, uint256 step) internal pure returns (int256) {
        // early return for step=0/1, or zero value
        if (step < 2 || value == 0) {
            return value;
        }

        unchecked {
            // forge-lint: disable-next-line(unsafe-typecast)
            return value - value % int256(step);
            // return (value / step) * step;
        }
    }

    /// @notice quantize uint value multiple of step
    function _quantize(uint256 value, uint256 step) internal pure returns (uint256) {
        return uint256(_quantize(int256(value), step));
    }

    function _getSortMap(int256[] memory values) internal pure returns (uint256[] memory sortMap) {
        uint256 count = values.length;
        sortMap = new uint256[](count);

        unchecked {
            uint256 lastPos;
            for (uint256 i; i < count; ++i) {
                int256 value = values[i];
                uint256 pos = lastPos;
                while (pos > 0) {
                    uint256 idx = sortMap[pos - 1];
                    if (values[idx] >= value) break;
                    sortMap[pos] = idx;
                    --pos;
                }
                sortMap[pos] = i;
                ++lastPos;
            }
        }
    }
}
