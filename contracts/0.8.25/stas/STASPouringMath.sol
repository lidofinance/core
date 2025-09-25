// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {Math} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {STASCore} from "./STASCore.sol";
import {SortIndexedTarget} from "./STASTypes.sol";

/**
 * @title Pouring Math for STAS
 * @author KRogLA
 * @notice Provides allocation logic functions for the Share Target Allocation Strategy (STAS)
 * @dev This library includes functions for calculating allocation based on 2 approaches of water-filling algorithms
 */
library STASPouringMath {
    /// @param shares The shares of each  entity
    /// @param amounts The current amounts allocated to each entity
    /// @param capacities The maximum capacities for each entity
    /// @param totalAmount The total inflow currently allocated across all entities
    /// @param inflow The new inflow to allocate
    function _allocate(
        uint256[] memory shares,
        uint256[] memory amounts,
        uint256[] memory capacities,
        uint256 totalAmount,
        uint256 inflow
    ) internal pure returns (uint256[] memory imbalance, uint256[] memory fills, uint256 rest) {
        uint256 n = shares.length;
        if (amounts.length != n || capacities.length != n) revert STASCore.LengthMismatch();

        imbalance = new uint256[](n);
        fills = new uint256[](n);

        if (n == 0 || inflow == 0) {
            // nothing to do or nothing to distribute
            return (imbalance, fills, inflow);
        }
        // new target total volume after allocation
        totalAmount = totalAmount + inflow;
        // calculate imbalance only for entities that not exceed their target share of the new total volume
        _calcImbalanceInflow({
            imbalance: imbalance,
            shares: shares,
            amounts: amounts,
            capacities: capacities,
            fills: fills,
            totalAmount: totalAmount
        });
        rest = _pourSimple(imbalance, fills, inflow);
        // rest = _pourWaterFill(imbalance, fills, inflow);
    }

    /// @param shares The shares of each  entity
    /// @param amounts The current amounts allocated to each entity
    /// @param totalAmount The total inflow currently allocated across all entities
    /// @param outflow The new inflow to allocate
    function _deallocate(uint256[] memory shares, uint256[] memory amounts, uint256 totalAmount, uint256 outflow)
        internal
        pure
        returns (uint256[] memory imbalance, uint256[] memory fills, uint256 rest)
    {
        uint256 n = shares.length;
        if (amounts.length != n) revert STASCore.LengthMismatch();

        imbalance = new uint256[](n);
        fills = new uint256[](n);

        // new target total volume after deallocation
        unchecked {
            totalAmount = totalAmount < outflow ? 0 : totalAmount - outflow;
        }
        // calculate imbalance only for entities that exceed their target share of the new total volume
        _calcImbalanceOutflow({
            imbalance: imbalance,
            shares: shares,
            amounts: amounts,
            fills: fills,
            totalAmount: totalAmount
        });
        rest = _pourSimple(imbalance, fills, outflow);
        // rest = _pourWaterFill(imbalance, fills, outflow);
    }

    // `capacity` - extra inflow for current entity that can be fitted into
    // i.e. max total inflow of current entity is `inflow + capacity`
    // capacity = 0, means no more can be added
    // `target` - max desired total inflow that should be allocated to current entity

    /// @param imbalance The current imbalance for each entity (mutated array)
    /// @param shares The shares of each  entity
    /// @param amounts The current amounts allocated to each entity
    /// @param capacities The maximum capacities for each entity
    /// @param fills The current fills for each entity (mutated array)
    /// @param totalAmount The total inflow currently allocated across all entities
    /// @dev imbalance is mutated arrays should be initialized before the call
    function _calcImbalanceInflow(
        uint256[] memory imbalance,
        uint256[] memory shares,
        uint256[] memory amounts,
        uint256[] memory capacities,
        uint256[] memory fills,
        uint256 totalAmount
    ) internal pure {
        uint256 n = shares.length;
        if (amounts.length != n || capacities.length != n || fills.length != n || imbalance.length != n) {
            revert STASCore.LengthMismatch();
        }

        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 target = shares[i];
                if (target != 0) {
                    // target = Math.mulShr(target, totalAmount, STASCore.S_FRAC, Math.Rounding.Ceil);
                    target = Math.mulDiv(target, totalAmount, STASCore.S_SCALE, Math.Rounding.Ceil);
                }

                uint256 amt = amounts[i] + fills[i];
                target = target <= amt ? 0 : target - amt;
                if (target > 0) {
                    uint256 cap = capacities[i];
                    target = cap < target ? cap : target; // enforce capacity if limited
                }
                imbalance[i] = target;
            }
        }
    }

    /// @param imbalance The current imbalance for each entity (mutated array)
    /// @param shares The shares of each  entity
    /// @param amounts The current amounts allocated to each entity
    /// @param fills The current fills for each entity (mutated array)
    /// @param totalAmount The total inflow currently allocated across all entities
    /// @dev imbalance is mutated arrays should be initialized before the call
    function _calcImbalanceOutflow(
        uint256[] memory imbalance,
        uint256[] memory shares,
        uint256[] memory amounts,
        uint256[] memory fills,
        uint256 totalAmount
    ) internal pure {
        uint256 n = shares.length;
        if (amounts.length != n || fills.length != n || imbalance.length != n) {
            revert STASCore.LengthMismatch();
        }

        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 target = shares[i];
                if (target != 0) {
                    // target = Math.mulShr(target, totalAmount, STASCore.S_FRAC, Math.Rounding.Ceil);
                    target = Math.mulDiv(target, totalAmount, STASCore.S_SCALE, Math.Rounding.Ceil);
                }
                uint256 amt = amounts[i] - fills[i];
                target = amt <= target ? 0 : amt - target;
                imbalance[i] = target;
            }
        }
    }

    /// @notice Simplified water-fill style allocator that distributes an `inflow` across baskets
    ///         toward absolute target amounts, respecting per-basket capacities.
    function _pourSimple(uint256[] memory targets, uint256[] memory fills, uint256 inflow)
        internal
        pure
        returns (uint256 rest)
    {
        uint256 n = targets.length;
        if (fills.length != n) revert STASCore.LengthMismatch();
        rest = inflow;

        // nothing to do or nothing to distribute
        if (n == 0 || rest == 0) {
            return rest;
        }

        uint256 total;
        uint256 count;
        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 t = targets[i];
                if (t != 0) {
                    total += t;
                    ++count;
                }
            }
        }

        // all targets are zero
        if (total == 0) {
            return rest;
        }

        // can satisfy all deficits outright
        if (rest >= total) {
            unchecked {
                for (uint256 i; i < n; ++i) {
                    fills[i] = targets[i];
                    targets[i] = 0;
                }
                rest -= total;
            }
            return rest;
        }

        // simple Water-fill loop: distribute `rest` across remaining deficits roughly evenly.
        // Complexity: O(k * n) where k is number of rounds; in worst case k <= max(deficit) when per==1.
        while (rest > 0 && count > 0) {
            uint256 per = rest / count;
            if (per == 0) per = 1;

            unchecked {
                for (uint256 i; i < n && rest > 0; ++i) {
                    uint256 need = targets[i];
                    if (need == 0) continue; // already filled

                    uint256 use = need < per ? need : per;
                    if (use > rest) use = rest;
                    fills[i] += use;
                    targets[i] = need - use; // reduce deficit directly in targets
                    rest -= use;

                    if (targets[i] == 0) --count;
                }
            }
        }
    }

    function _pourWaterFill(uint256[] memory targets, uint256[] memory fills, uint256 inflow)
        internal
        pure
        returns (uint256 rest)
    {
        uint256 n = targets.length;
        if (fills.length != n) revert STASCore.LengthMismatch();
        rest = inflow;

        // nothing to do or nothing to distribute
        if (n == 0 || rest == 0) {
            return rest;
        }

        // 1) One element
        if (n == 1) {
            uint256 t = targets[0];
            uint256 fill = rest >= t ? t : rest;
            fills[0] = fill;
            unchecked {
                rest -= fill;
            }
            return rest;
        }

        // 1) create array ofSortIndexedTarget
        SortIndexedTarget[] memory items = new SortIndexedTarget[](n);
        for (uint256 i; i < n; ++i) {
            uint256 t = targets[i];
            items[i] = SortIndexedTarget({idx: i, target: t});
        }

        // 2) Quick sort by target DESC (pivot = middle element)
        // forge-lint: disable-next-line(unsafe-typecast)
        _quickSort(items, int256(0), int256(n - 1));

        // 3) Compute prefix sums and quick path if inflow >= total
        uint256 total;
        uint256[] memory prefix = new uint256[](n);
        unchecked {
            for (uint256 i; i < n; ++i) {
                total += items[i].target;
                prefix[i] = total;
            }
        }
        if (total == 0) {
            return rest;
        }

        // can satisfy all deficits outright
        if (rest >= total) {
            unchecked {
                for (uint256 i; i < n; ++i) {
                    uint256 t = items[i].target;
                    if (t != 0) {
                        fills[items[i].idx] = t;
                        // targets[i] = 0;
                    }
                }
                rest -= total;
            }
            return rest;
        }

        // 4) find level L: 1st k where
        //    items[k].target ≥ Lk ≥ nextTarget; Lk = (prefix[k]-inflow)/(k+1)
        uint256 level;
        unchecked {
            for (uint256 k; k < n; ++k) {
                if (prefix[k] < inflow) {
                    continue;
                }
                level = (prefix[k] - inflow) / (k + 1);
                uint256 nextTarget = k + 1 < n ? items[k + 1].target : 0;
                if (items[k].target >= level && level >= nextTarget) {
                    break;
                }
            }
        }

        // 5) final pass: fill = max(0, cap - L)
        uint256 filled;
        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 t = items[i].target;
                uint256 fill = t > level ? t - level : 0;
                if (fill > 0) {
                    uint256 idx = items[i].idx;
                    fills[idx] = fill;
                    targets[idx] = t - fill;
                    filled += fill;
                }
            }
            assert(filled <= inflow);
            rest -= filled;
        }
    }

    // forge-lint: disable-start(unsafe-typecast)
    /// @dev In-place quicksort on SortIndexedTarget[] by target DESC, tiebreaker idx ASC.
    function _quickSort(SortIndexedTarget[] memory arr, int256 left, int256 right) internal pure {
        if (left >= right) return;
        int256 i = left;
        int256 j = right;
        // Pivot = middle element's target
        uint256 pivot = arr[uint256((left + right) / 2)].target;
        while (i <= j) {
            // move i forward while arr[i].target > pivot
            while (arr[uint256(i)].target > pivot) {
                unchecked {
                    ++i;
                }
            }
            // move j backward while arr[j].target < pivot
            while (arr[uint256(j)].target < pivot) {
                unchecked {
                    --j;
                }
            }
            if (i <= j) {
                // swap arr[i] <-> arr[j]
                // SortIndexedTarget memory tmp = arr[uint256(i)];
                // arr[uint256(i)] = arr[uint256(j)];
                // arr[uint256(j)] = tmp;
                (arr[uint256(i)], arr[uint256(j)]) = (arr[uint256(j)], arr[uint256(i)]);
                unchecked {
                    ++i;
                    --j;
                }
            }
        }
        if (left < j) _quickSort(arr, left, j);
        if (i < right) _quickSort(arr, i, right);
    }
    // forge-lint: disable-end(unsafe-typecast)
}
