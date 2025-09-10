// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.25;

import {EnumerableSet} from "@openzeppelin/contracts-v5.2/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {Packed16} from "../Packed16.sol";
import {BitMask16} from "../BitMask16.sol";
import "./STASTypes.sol" as T;
import "./STASErrors.sol" as E;

/**
 * @title Share Target Allocation T.Strategy (STAS)
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
    uint8 public constant S_FRAC = 32; // Q32.32
    uint256 public constant S_SCALE = uint256(1) << S_FRAC; // 2^32

    event UpdatedEntities(uint256 updateCount);
    event UpdatedStrategyWeights(uint256 strategyId, uint256 updatesCount);

    function getSTAStorage(bytes32 _position) public pure returns (T.STASStorage storage) {
        return _getStorage(_position);
    }

    function enableStrategy(T.STASStorage storage $, uint8 sId) public {
        uint16 mask = $.enabledStrategiesBitMask;
        if (mask.isBitSet(sId)) revert E.AlreadyExists();

        $.enabledStrategiesBitMask = mask.setBit(sId);

        // initializing with zeros, weights should be set later
        uint256[16] memory sumX;
        $.strategies[sId] = T.Strategy({packedWeights: 0, sumWeights: 0, sumX: sumX});
    }

    function disableStrategy(T.STASStorage storage $, uint8 sId) public {
        uint16 mask = $.enabledStrategiesBitMask;
        if (!mask.isBitSet(sId)) revert E.NotEnabled();

        // reset strategy storage
        delete $.strategies[sId];
        $.enabledStrategiesBitMask = mask.clearBit(sId);
    }

    function enableMetric(T.STASStorage storage $, uint8 mId, uint16 defaultWeight) public returns (uint256 updCnt) {
        uint16 mask = $.enabledMetricsBitMask;
        if (mask.isBitSet(mId)) revert E.AlreadyExists(); // skip non-enabled metrics

        $.enabledMetricsBitMask = mask.setBit(mId);
        $.metrics[mId] = T.Metric({defaultWeight: defaultWeight});

        updCnt = _setWeightsAllStrategies($, mId, defaultWeight);
    }

    function disableMetric(T.STASStorage storage $, uint8 mId) public returns (uint256 updCnt) {
        uint16 mask = $.enabledMetricsBitMask;
        if (!mask.isBitSet(mId)) revert E.NotEnabled(); // skip non-enabled metrics

        updCnt = _setWeightsAllStrategies($, mId, 0);

        $.enabledMetricsBitMask = mask.clearBit(mId);
        delete $.metrics[mId];
    }

    function addEntity(T.STASStorage storage $, uint256 eId) public {
        uint256[] memory eIds = new uint256[](1);
        eIds[0] = eId;
        _addEntities($, eIds);
    }

    function addEntities(T.STASStorage storage $, uint256[] memory eIds) public {
        _addEntities($, eIds);
    }

    function addEntities(T.STASStorage storage $, uint256[] memory eIds, uint8[] memory mIds, uint16[][] memory newVals)
        public
        returns (uint256 updCnt)
    {
        _addEntities($, eIds);

        if (mIds.length > 0) {
            updCnt = _applyUpdate($, eIds, mIds, newVals);
        }
    }

    function removeEntities(T.STASStorage storage $, uint256[] memory eIds) public returns (uint256 updCnt) {
        uint256 n = eIds.length;
        if (n == 0) revert E.NotFound();

        uint16 mask = $.enabledMetricsBitMask;
        uint8[] memory mIds = mask.bitsToValues();
        uint256 mCnt = mIds.length;
        uint16[][] memory delVals = new uint16[][](n);

        for (uint256 i; i < n; ++i) {
            uint256 eId = eIds[i];
            if (!$.entityIds.remove(eId)) {
                revert E.NotFound();
            }

            uint256 slot = $.entities[eId].packedMetricValues;
            if (slot == 0) continue; // nothing to remove
            delVals[i] = new uint16[](mCnt);
            for (uint8 k = 0; k < mCnt; ++k) {
                delVals[i][k] = slot.get16(mIds[k]);
            }
        }

        updCnt = _applyUpdate($, eIds, mIds, delVals);
    }

    function setWeights(T.STASStorage storage $, uint8 sId, uint8[] memory mIds, uint16[] memory newWeights)
        public
        returns (uint256 updCnt)
    {
        uint256 mCnt = mIds.length;
        _checkLength(mCnt, newWeights.length);
        _checkBounds(mCnt, MAX_METRICS);

        uint16 mask = $.enabledStrategiesBitMask;
        if (!mask.isBitSet(sId)) revert E.NotEnabled(); // skip non-enabled strategies

        updCnt = _setWeights($, sId, mIds, newWeights);
    }

    function batchUpdate(
        T.STASStorage storage $,
        uint256[] memory eIds,
        uint8[] memory mIds,
        uint16[][] memory newVals // индексы+значения per id/per cat
            // uint16[][] memory mask // 1 если k изменяем, иначе 0
    ) public returns (uint256 updCnt) {
        updCnt = _applyUpdate($, eIds, mIds, newVals);
    }

    function _getEntityRaw(T.STASStorage storage $, uint256 eId) public view returns (T.Entity memory) {
        return $.entities[eId];
    }

    function _getStrategyRaw(T.STASStorage storage $, uint256 sId) public view returns (T.Strategy memory) {
        return $.strategies[sId];
    }

    function _getMetricRaw(T.STASStorage storage $, uint256 mId) public view returns (T.Metric memory) {
        return $.metrics[mId];
    }

    function getMetricValues(T.STASStorage storage $, uint256 eId) public view returns (uint16[] memory) {
        _checkEntity($, eId);

        uint256 pVals = $.entities[eId].packedMetricValues;
        return pVals.unpack16();
    }

    function getWeights(T.STASStorage storage $, uint8 sId)
        public
        view
        returns (uint16[] memory weights, uint256 sumWeights)
    {
        uint16 mask = $.enabledStrategiesBitMask;
        if (!mask.isBitSet(sId)) revert E.NotEnabled(); // skip non-enabled strategies

        uint256 pW = $.strategies[sId].packedWeights;
        return (pW.unpack16(), $.strategies[sId].sumWeights);
    }

    function getEnabledStrategies(T.STASStorage storage $) public view returns (uint8[] memory) {
        uint16 mask = $.enabledStrategiesBitMask;
        return mask.bitsToValues();
    }

    function getEnabledMetrics(T.STASStorage storage $) public view returns (uint8[] memory) {
        uint16 mask = $.enabledMetricsBitMask;
        return mask.bitsToValues();
    }

    function getEntities(T.STASStorage storage $) public view returns (uint256[] memory) {
        return $.entityIds.values();
    }

    function shareOf(T.STASStorage storage $, uint256 eId, uint8 sId) public view returns (uint256) {
        uint16 mask = $.enabledStrategiesBitMask;
        if (!mask.isBitSet(sId)) revert E.NotEnabled(); // skip non-enabled strategies

        _checkEntity($, eId);
        return _calculateShare($, eId, sId);
    }

    function sharesOf(T.STASStorage storage $, uint256[] memory eIds, uint8 sId)
        public
        view
        returns (uint256[] memory)
    {
        uint256[] memory shares = new uint256[](eIds.length);
        uint16 mask = $.enabledStrategiesBitMask;
        if (!mask.isBitSet(sId)) revert E.NotEnabled(); // skip non-enabled strategies

        for (uint256 i = 0; i < eIds.length; i++) {
            uint256 eId = eIds[i];
            _checkEntity($, eId);
            shares[i] = _calculateShare($, eId, sId);
        }
        return shares;
    }

    // function _shareOf(T.STASStorage storage $, uint256 eId, uint8 sId) internal view returns (uint256) {
    //     _checkEntity($, eId);
    //     uint16 mask = $.enabledStrategiesBitMask;
    //     if (!mask.isBitSet(sId)) revert E.NotEnabled(); // skip non-enabled strategies
    //     return _calculateShare($, eId, sId);
    // }

    function _addEntities(T.STASStorage storage $, uint256[] memory eIds) private {
        uint256 n = eIds.length;
        if (n == 0) revert E.NoData();

        for (uint256 i; i < n; ++i) {
            uint256 eId = eIds[i];
            if (!$.entityIds.add(eId)) {
                revert E.AlreadyExists();
            }
            $.entities[eId] = T.Entity({packedMetricValues: 0});
        }
    }

    function _setWeightsAllStrategies(T.STASStorage storage $, uint8 mId, uint16 newWeight)
        private
        returns (uint256 updCnt)
    {
        uint16 mask = $.enabledStrategiesBitMask;
        uint8[] memory mIds = new uint8[](1);
        mIds[0] = mId;
        uint16[] memory newWeights = new uint16[](1);
        newWeights[0] = newWeight;

        for (uint8 i; i < MAX_STRATEGIES; ++i) {
            if (!mask.isBitSet(i)) continue; // skip non-enabled strategies
            updCnt += _setWeights($, i, mIds, newWeights);
        }
    }

    function _setWeights(T.STASStorage storage $, uint8 sId, uint8[] memory mIds, uint16[] memory newWeights)
        private
        returns (uint256 updCnt)
    {
        T.Strategy storage ss = $.strategies[sId];
        // get old weights/sum
        uint256 pW = ss.packedWeights;
        int256 dSum;
        uint16 mask = $.enabledMetricsBitMask;
        // forge-lint: disable-start(unsafe-typecast)
        unchecked {
            for (uint8 k; k < mIds.length; ++k) {
                uint8 mId = mIds[k];
                if (!mask.isBitSet(mId)) continue;

                uint16 oldW = pW.get16(mId);
                uint16 newW = newWeights[k];
                if (newW == oldW) continue;

                int256 dx = int256(uint256(newW)) - int256(uint256(oldW));
                dSum += dx;
                // update local packedWeights
                pW = pW.set16(mId, newW);
                ++updCnt;
            }
        }
        // apply delta to sumWeights
        uint256 sW = ss.sumWeights;
        if (dSum != 0) {
            if (dSum > 0) sW += uint256(dSum);
            else sW -= uint256(-dSum);
        }
        // forge-lint: disable-end(unsafe-typecast)
        ss.packedWeights = pW;
        ss.sumWeights = sW;
        emit UpdatedStrategyWeights(sId, updCnt);
    }

    function _applyUpdate(
        T.STASStorage storage $,
        uint256[] memory eIds,
        uint8[] memory mIds,
        uint16[][] memory newVals // или компактнее: индексы+значения per id
            // uint16[][] memory mask // 1 если k изменяем, иначе 0
    ) private returns (uint256 updCnt) {
        uint256 n = eIds.length;
        _checkLength(newVals.length, n);

        uint256 mCnt = mIds.length;
        _checkBounds(mCnt, MAX_METRICS);

        // дельты сумм по параметрам
        int256[] memory dSum = new int256[](mCnt);
        uint16 mask = $.enabledMetricsBitMask;
        // forge-lint: disable-start(unsafe-typecast)
        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 eId = eIds[i];
                _checkEntity($, eId);
                _checkLength(newVals[i].length, mCnt);

                uint256 pVals = $.entities[eId].packedMetricValues;
                uint256 pValsNew = pVals;

                for (uint256 k; k < mCnt; ++k) {
                    // if (mask[i][k] == 0) continue;
                    uint8 mId = mIds[k];
                    if (!mask.isBitSet(mId)) continue; // skip non-enabled metrics

                    uint16 xOld = pValsNew.get16(mId);
                    uint16 xNew = newVals[i][k];
                    if (xNew == xOld) continue;

                    pValsNew = pValsNew.set16(mId, xNew);
                    int256 dx = int256(uint256(xNew)) - int256(uint256(xOld));
                    dSum[k] += dx;
                }

                if (pValsNew != pVals) {
                    $.entities[eId].packedMetricValues = pValsNew;
                    ++updCnt;
                }
            }
        }

        mask = $.enabledStrategiesBitMask;
        for (uint256 i; i < MAX_STRATEGIES; ++i) {
            if (!mask.isBitSet(uint8(i))) continue; // skip non-enabled strategies
            T.Strategy storage ss = $.strategies[i];
            // update sumX[k]
            for (uint256 k; k < mCnt; ++k) {
                int256 dx = dSum[k];
                if (dx == 0) continue;
                uint8 mId = mIds[k];
                if (dx > 0) ss.sumX[mId] += uint256(dx);
                else ss.sumX[mId] -= uint256(-dx); // no overflow, due to dx = Σ(new-old)
            }
        }
        // forge-lint: disable-end(unsafe-typecast)
        emit UpdatedEntities(updCnt);
    }

    function _applyUpdate2(
        T.STASStorage storage $,
        uint256[] memory eIds,
        uint8[] memory mIds,
        uint16[][] memory newVals // или компактнее: индексы+значения per id
            // uint16[][] memory mask // 1 если k изменяем, иначе 0
    ) private returns (uint256 updCnt) {
        uint256 mCnt = mIds.length;
        _checkBounds(mCnt, MAX_METRICS);
        _checkLength(newVals.length, mCnt);

        uint256 n = eIds.length;
        // todo check values length for each metric
        // _checkLength(newVals[i].length, n);

        // дельты сумм по параметрам
        int256[] memory dSum = new int256[](mCnt);
        uint16 mask = $.enabledMetricsBitMask;
        // forge-lint: disable-start(unsafe-typecast)
        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 eId = eIds[i];
                _checkEntity($, eId);

                uint256 pVals = $.entities[eId].packedMetricValues;
                uint256 pValsNew = pVals;

                for (uint256 k; k < mCnt; ++k) {
                    uint8 mId = mIds[k];
                    if (!mask.isBitSet(mId)) continue; // skip non-enabled metrics

                    uint16 xOld = pValsNew.get16(mId);
                    uint16 xNew = newVals[k][i];
                    if (xNew == xOld) continue; // skip non-changed values

                    pValsNew = pValsNew.set16(mId, xNew);
                    int256 dx = int256(uint256(xNew)) - int256(uint256(xOld));
                    dSum[k] += dx;
                }

                if (pValsNew != pVals) {
                    $.entities[eId].packedMetricValues = pValsNew;
                    ++updCnt;
                }
            }
        }

        mask = $.enabledStrategiesBitMask;
        for (uint256 i; i < MAX_STRATEGIES; ++i) {
            if (!mask.isBitSet(uint8(i))) continue; // skip non-enabled strategies
            T.Strategy storage ss = $.strategies[i];
            // update sumX[k]
            for (uint256 k; k < mCnt; ++k) {
                int256 dx = dSum[k];
                if (dx == 0) continue;
                uint8 mId = mIds[k];
                if (dx > 0) ss.sumX[mId] += uint256(dx);
                else ss.sumX[mId] -= uint256(-dx); // no overflow, due to dx = Σ(new-old)
            }
        }
        // forge-lint: disable-end(unsafe-typecast)
        emit UpdatedEntities(updCnt);
    }

    function _calculateShare(T.STASStorage storage $, uint256 eId, uint8 sId) private view returns (uint256) {
        T.Strategy storage ss = $.strategies[sId];

        uint256 sW = ss.sumWeights;
        if (sW == 0) return 0;

        uint256 pW = ss.packedWeights;
        uint256 pVals = $.entities[eId].packedMetricValues;
        uint256 acc; // Σ_k w_k * x_{i,k} / sumX[k]

        unchecked {
            for (uint8 k; k < 16; ++k) {
                uint256 xk = pVals.get16(k);
                if (xk == 0) continue;
                uint256 sx = ss.sumX[k];
                if (sx == 0) continue;
                uint256 wk = pW.get16(k);
                //  w * x / sumX[k]
                // acc += Math.mulDiv(wk, xk, sx, Math.Rounding.Floor);
                acc += Math.mulDiv(wk, xk, sx);
            }
        }
        // return Math.mulDiv(acc, S_SCALE, sW, Math.Rounding.Floor);
        return (acc << S_FRAC) / sW; // Q32.32
    }

    function _checkEntity(T.STASStorage storage $, uint256 eId) private view {
        if (!$.entityIds.contains(eId)) {
            revert E.NotFound();
        }
    }

    function _checkIdBounds(uint256 value, uint256 max) private pure {
        if (value >= max) {
            revert E.OutOfBounds();
        }
    }

    function _checkBounds(uint256 value, uint256 max) private pure {
        if (value > max) {
            revert E.OutOfBounds();
        }
    }

    function _checkLength(uint256 l1, uint256 l2) private pure {
        if (l1 != l2) {
            revert E.LengthMismatch();
        }
    }

    /// @dev Returns the storage slot for the given position.
    function _getStorage(bytes32 _position) private pure returns (T.STASStorage storage $) {
        assembly ("memory-safe") {
            $.slot := _position
        }
    }
}
