// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {Packed16} from "contracts/common/lib/Packed16.sol";
import {BitMask16} from "contracts/common/lib/BitMask16.sol";

struct STASStorage {
    // uint16 enabledMetricsBitMask;
    uint16 enabledStrategiesBitMask;
    uint256 packedEnabledStrategyMetricsBitMasks; // packed bit masks of enabled metrics per strategy (16x uint16 in one uint256)
    mapping(uint256 => uint256) packedEntityMetricValues; // mapping of entity ID to their packed metric values
    mapping(uint256 => uint256) strategySumWeights; // mapping of strategy ID to their sum of weights
    EnumerableSet.UintSet entityIds; // set of entity IDs
}

/**
 * @title Share Target Allocation Strategy (STAS)
 * @author KRogLA
 * @notice A library for calculating and managing weight distributions among entities based on their metric values
 * @dev Provides functionality for allocating shares to entities according to configurable strategies and metrics
 */
library STASCore {
    using EnumerableSet for EnumerableSet.UintSet;
    using Packed16 for uint256;
    using BitMask16 for uint16;

    uint8 public constant MAX_METRICS = 16;
    uint8 public constant MAX_STRATEGIES = 16;

    // resulted shares precision
    uint8 public constant S_FRAC = 96; // Q96.96
    uint256 public constant S_SCALE = uint256(1) << S_FRAC; // 2^96

    error NotExists();
    error NotEnabled();
    error AlreadyExists();
    error AlreadyEnabled();
    error OutOfBounds();
    error LengthMismatch();
    error NoData();

    function enableStrategy(STASStorage storage $, uint8 sId) internal {
        uint16 mask = $.enabledStrategiesBitMask;
        if (mask.isBitSet(sId)) revert AlreadyEnabled();
        $.enabledStrategiesBitMask = mask.setBit(sId);

        // recalculate sumWeights for all entities
        uint256 n = $.entityIds.length();
        uint16 smMask = $.packedEnabledStrategyMetricsBitMasks.get16(sId);
        uint256 sW = 0;

        // if there are enabled metrics, calculate sumWeights
        if (smMask != 0) {
            unchecked {
                for (uint256 i; i < n; ++i) {
                    uint256 eId = $.entityIds.at(i);
                    uint256 pVals = $.packedEntityMetricValues[eId];
                    sW += pVals.product(smMask); // product of values for enabled metrics in strategy
                }
            }
        }
        // save updated sumWeights
        $.strategySumWeights[sId] = sW;
    }

    function disableStrategy(STASStorage storage $, uint8 sId) internal {
        uint16 mask = $.enabledStrategiesBitMask;
        if (!mask.isBitSet(sId)) revert NotEnabled();
        $.enabledStrategiesBitMask = mask.clearBit(sId);

        // reset sumWeights to 0
        $.strategySumWeights[sId] = 0;
    }

    /// @dev Enables metrics in strategy
    function enableStrategyMetrics(STASStorage storage $, uint8 sId, uint8[] memory mIds)
        internal
        returns (uint256 updCnt)
    {
        uint256 smMasks = $.packedEnabledStrategyMetricsBitMasks;
        uint16 mask = smMasks.get16(sId);

        uint16 newMetricsMask = mask;
        for (uint256 i = 0; i < mIds.length; ++i) {
            uint8 mId = mIds[i];
            if (mask.isBitSet(mId)) continue; // skip already enabled metrics
            newMetricsMask = newMetricsMask.setBit(mId);
        }
        if (newMetricsMask == mask) revert AlreadyEnabled(); // skip already enabled metrics

        updCnt = _updateStrategyMetrics($, sId, newMetricsMask);
    }

    function disableStrategyMetrics(STASStorage storage $, uint8 sId, uint8[] memory mIds)
        internal
        returns (uint256 updCnt)
    {
        uint256 smMasks = $.packedEnabledStrategyMetricsBitMasks;
        uint16 mask = smMasks.get16(sId);

        uint16 newMetricsMask = mask;
        for (uint256 i = 0; i < mIds.length; ++i) {
            uint8 mId = mIds[i];
            if (!mask.isBitSet(mId)) continue; // skip non-enabled metrics
            newMetricsMask = newMetricsMask.clearBit(mId);
        }
        if (newMetricsMask == mask) revert NotEnabled(); // skip non-enabled metrics

        updCnt = _updateStrategyMetrics($, sId, newMetricsMask);
    }

    function addEntity(STASStorage storage $, uint256 eId) internal {
        uint256[] memory eIds = new uint256[](1);
        eIds[0] = eId;
        _addEntities($, eIds);
    }

    function addEntities(STASStorage storage $, uint256[] memory eIds) internal {
        _addEntities($, eIds);
    }

    function addEntities(STASStorage storage $, uint256[] memory eIds, uint8[] memory mIds, uint16[][] memory newVals)
        internal
        returns (uint256 updCnt)
    {
        _addEntities($, eIds);

        if (mIds.length > 0) {
            updCnt = _applyUpdate($, eIds, mIds, newVals);
        }
    }

    function removeEntities(STASStorage storage $, uint256[] memory eIds) internal returns (uint256 updCnt) {
        uint256 n = eIds.length;
        if (n == 0) revert NoData();

        // todo filter entities with zero values?

        uint16[][] memory zeroVals = new uint16[][](n);
        for (uint256 i; i < n; ++i) {
            zeroVals[i] = new uint16[](MAX_METRICS); // zeroed values array for all metrics
        }

        // all possible metric values set to 0
        // forge-lint: disable-next-line(incorrect-shift)
        uint8[] memory mIds = (uint16((1 << MAX_METRICS) - 1)).bitsToValues();
        updCnt = _applyUpdate($, eIds, mIds, zeroVals);

        for (uint256 i; i < n; ++i) {
            if (!$.entityIds.remove(eIds[i])) {
                revert NotExists();
            }
        }
    }

    function batchUpdate(
        STASStorage storage $,
        uint256[] memory eIds,
        uint8[] memory mIds,
        uint16[][] memory newVals // индексы+значения per id/per cat
            // uint16[][] memory mask // 1 если k изменяем, иначе 0
    ) internal returns (uint256 updCnt) {
        updCnt = _applyUpdate($, eIds, mIds, newVals);
    }

    function getMetricValues(STASStorage storage $, uint256 eId) internal view returns (uint16[] memory) {
        _checkEntity($, eId);

        uint256 pVals = $.packedEntityMetricValues[eId];
        return pVals.unpack16();
    }

    function getStrategyMetricValues(STASStorage storage $, uint256 eId, uint8 sId)
        internal
        view
        returns (uint16[] memory)
    {
        _checkEntity($, eId);

        uint16 sMask = $.enabledStrategiesBitMask;
        if (!sMask.isBitSet(sId)) revert NotEnabled(); // non-enabled strategy

        uint256 pVals = $.packedEntityMetricValues[eId];
        uint16 smMask = $.packedEnabledStrategyMetricsBitMasks.get16(sId);
        uint8[] memory mIds = smMask.bitsToValues();
        uint16[] memory pValsFiltered = new uint16[](mIds.length);
        for (uint256 i = 0; i < mIds.length; ++i) {
            uint8 mId = mIds[i];
            pValsFiltered[i] = pVals.get16(mId);
        }

        return pValsFiltered;
    }

    function getEnabledStrategies(STASStorage storage $) internal view returns (uint8[] memory) {
        uint16 mask = $.enabledStrategiesBitMask;
        return mask.bitsToValues();
    }

    function getEnabledStrategyMetrics(STASStorage storage $, uint8 sId) internal view returns (uint8[] memory) {
        uint256 smMasks = $.packedEnabledStrategyMetricsBitMasks;
        uint16 mask = smMasks.get16(sId);
        return mask.bitsToValues();
    }

    function getEntities(STASStorage storage $) internal view returns (uint256[] memory) {
        return $.entityIds.values();
    }

    function shareOf(STASStorage storage $, uint256 eId, uint8 sId) internal view returns (uint256) {
        uint16 mask = $.enabledStrategiesBitMask;
        if (!mask.isBitSet(sId)) return 0;
        _checkEntity($, eId);
        return _calculateShare($, eId, sId);
    }

    function sharesOf(STASStorage storage $, uint256[] memory eIds, uint8 sId)
        internal
        view
        returns (uint256[] memory)
    {
        uint256[] memory shares = new uint256[](eIds.length);
        uint16 mask = $.enabledStrategiesBitMask;
        if (!mask.isBitSet(sId)) return shares;

        for (uint256 i = 0; i < eIds.length; i++) {
            uint256 eId = eIds[i];
            _checkEntity($, eId);
            shares[i] = _calculateShare($, eId, sId);
        }
        return shares;
    }

    function _addEntities(STASStorage storage $, uint256[] memory eIds) private {
        uint256 n = eIds.length;
        if (n == 0) revert NoData();

        for (uint256 i; i < n; ++i) {
            uint256 eId = eIds[i];
            if (!$.entityIds.add(eId)) {
                revert AlreadyExists();
            }
            $.packedEntityMetricValues[eId] = 0;
        }
    }

    function _updateStrategyMetrics(STASStorage storage $, uint8 sId, uint16 newMetricsMask)
        private
        returns (uint256 updCnt)
    {
        uint256 n = $.entityIds.length();
        uint256 smMasks = $.packedEnabledStrategyMetricsBitMasks;
        uint16 oldMetricsMask = smMasks.get16(sId);

        if (newMetricsMask == oldMetricsMask) {
            return 0; // nothing to update
        }

        int256 dSum;
        uint16 addedMetricsMask = newMetricsMask & ~oldMetricsMask;
        // forge-lint: disable-start(unsafe-typecast)
        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 eId = $.entityIds.at(i);
                uint256 pVals = $.packedEntityMetricValues[eId];

                // set default value 1 for newly added metrics if not set
                if (addedMetricsMask != 0) {
                    uint256 pValsWithDefaults = pVals;
                    for (uint8 m; m < MAX_METRICS; ++m) {
                        if (!addedMetricsMask.isBitSet(m)) continue;
                        if (pValsWithDefaults.get16(m) == 0) {
                            pValsWithDefaults = pValsWithDefaults.set16(m, 1);
                        }
                    }
                    if (pValsWithDefaults != pVals) {
                        $.packedEntityMetricValues[eId] = pValsWithDefaults;
                        pVals = pValsWithDefaults;
                    }
                }

                uint256 xOld = pVals.product(oldMetricsMask); // product of values for old enabled metrics in strategy
                uint256 xNew = pVals.product(newMetricsMask); // product of values for new enabled metrics in strategy
                if (xNew == xOld) continue;
                int256 dx = int256(xNew) - int256(xOld);
                dSum += dx;

                ++updCnt;
            }

            // apply delta to sumWeights
            uint256 sW = $.strategySumWeights[sId];
            if (dSum != 0) {
                if (dSum > 0) sW += uint256(dSum);
                else sW -= uint256(-dSum);
            }

            $.strategySumWeights[sId] = sW;
        }
        // forge-lint: disable-end(unsafe-typecast)
        $.packedEnabledStrategyMetricsBitMasks = smMasks.set16(sId, newMetricsMask);
    }

    function _applyUpdate(STASStorage storage $, uint256[] memory eIds, uint8[] memory mIds, uint16[][] memory newVals)
        private
        returns (uint256 updCnt)
    {
        uint256 n = eIds.length;
        _checkLength(newVals.length, n);

        uint256 mCnt = mIds.length;
        _checkBounds(mCnt, MAX_METRICS);

        int256[] memory dSum = new int256[](MAX_STRATEGIES);

        uint16 sMask = $.enabledStrategiesBitMask;
        uint256 smMasks = $.packedEnabledStrategyMetricsBitMasks;
        // forge-lint: disable-start(unsafe-typecast)
        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 eId = eIds[i];
                _checkEntity($, eId);
                _checkLength(newVals[i].length, mCnt);

                uint256 pVals = $.packedEntityMetricValues[eId];
                uint256 pValsNew = pVals;

                // set new metric values for entity
                for (uint256 k; k < mCnt; ++k) {
                    uint8 mId = mIds[k];
                    pValsNew = pValsNew.set16(mId, newVals[i][k]);
                }

                if (pValsNew != pVals) {
                    $.packedEntityMetricValues[eId] = pValsNew;
                    ++updCnt;

                    for (uint256 s; s < MAX_STRATEGIES; ++s) {
                        if (!sMask.isBitSet(uint8(s))) continue; // skip non-enabled strategies
                        uint16 smMask = smMasks.get16(uint8(s));
                        uint256 xOld = pVals.product(smMask); // product of old values for enabled metrics in strategy
                        uint256 xNew = pValsNew.product(smMask); // product of new values for enabled metrics in strategy
                        if (xNew == xOld) continue;
                        int256 dx = int256(xNew) - int256(xOld);
                        dSum[s] += dx;
                    }
                }
            }

            // apply dSum[k] to sumWeights per strategy
            for (uint256 i; i < MAX_STRATEGIES; ++i) {
                if (!sMask.isBitSet(uint8(i))) continue; // skip non-enabled strategies

                // update sumWeights
                uint256 sW = $.strategySumWeights[i];
                int256 dx = dSum[i];
                if (dx != 0) {
                    if (dx > 0) sW += uint256(dx);
                    else sW -= uint256(-dx); // no overflow, due to dx = Σ(new-old)
                }
                $.strategySumWeights[i] = sW;
            }
        }
        // forge-lint: disable-end(unsafe-typecast)
    }

    function _calculateShare(STASStorage storage $, uint256 eId, uint8 sId) private view returns (uint256) {
        uint256 sW = $.strategySumWeights[sId];
        if (sW == 0) return 0;

        uint16 smMask = $.packedEnabledStrategyMetricsBitMasks.get16(sId);
        uint256 pVals = $.packedEntityMetricValues[eId];
         return Math.mulDiv(pVals.product(smMask), S_SCALE, sW, Math.Rounding.Ceil);
        // return (pVals.product(smMask) << S_FRAC) / sW;
    }

    function _checkEntity(STASStorage storage $, uint256 eId) private view {
        if (!$.entityIds.contains(eId)) {
            revert NotExists();
        }
    }

    function _checkIdBounds(uint256 value, uint256 max) private pure {
        if (value >= max) {
            revert OutOfBounds();
        }
    }

    function _checkBounds(uint256 value, uint256 max) private pure {
        if (value > max) {
            revert OutOfBounds();
        }
    }

    function _checkLength(uint256 l1, uint256 l2) private pure {
        if (l1 != l2) {
            revert LengthMismatch();
        }
    }

    /// @dev Returns the storage slot for the given position.
    function getSTAStorage(bytes32 _position) internal pure returns (STASStorage storage $) {
        assembly ("memory-safe") {
            $.slot := _position
        }
    }
}
