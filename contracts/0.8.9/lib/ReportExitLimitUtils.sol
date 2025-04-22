// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {UnstructuredStorage} from "./UnstructuredStorage.sol";

// MSB ------------------------------------------------------------------------------> LSB
// 256______________160____________________________128_______________32____________________________ 0
// |_________________|______________________________|_________________|_____________________________|
// | maxExitRequests | maxExitRequestsGrowthBlocks | prevExitRequests | prevExitRequestsBlockNumber  |
// |<--- 96 bits --->|<---------- 32 bits -------->|<--- 96 bits ---->|<----- 32 bits ------------->|
//

// TODO: maybe we need smaller type for maxExitRequestsLimit
struct ExitRequestLimitData {
    uint32 prevExitRequestsBlockNumber; // block number of the previous exit requests
    // Remaining portion of the limit available  after the previous request.
    // Always less than or equal to `maxExitRequestsLimit`.
    uint96 prevExitRequestsLimit;
    // Number of block to regenerate limit from 0 to maxExitRequestsLimit
    uint32 maxExitRequestsLimitGrowthBlocks;
    // TODO: maybe use uint16 type
    uint96 maxExitRequestsLimit; // maximum exit requests limit value
}

library ReportExitLimitUtilsStorage {
    using UnstructuredStorage for bytes32;

    uint256 internal constant MAX_EXIT_REQUESTS_LIMIT_OFFSET = 160;
    uint256 internal constant MAX_EXIT_REQUESTS_LIMIT_GROWTH_BLOCKS_OFFSET = 128;
    uint256 internal constant PREV_EXIT_REQUESTS_LIMIT_OFFSET = 32;
    uint256 internal constant PREV_EXIT_REQUESTS_BLOCK_NUMBER_OFFSET = 0;

    function getStorageExitRequestLimit(bytes32 _position) internal view returns (ExitRequestLimitData memory data) {
        uint256 slotValue = _position.getStorageUint256();

        data.prevExitRequestsBlockNumber = uint32(slotValue >> PREV_EXIT_REQUESTS_BLOCK_NUMBER_OFFSET);
        data.prevExitRequestsLimit = uint96(slotValue >> PREV_EXIT_REQUESTS_LIMIT_OFFSET);
        data.maxExitRequestsLimitGrowthBlocks = uint32(slotValue >> MAX_EXIT_REQUESTS_LIMIT_GROWTH_BLOCKS_OFFSET);
        data.maxExitRequestsLimit = uint96(slotValue >> MAX_EXIT_REQUESTS_LIMIT_OFFSET);
    }

    function setStorageExitRequestLimit(bytes32 _position, ExitRequestLimitData memory _data) internal {
        _position.setStorageUint256(
            (uint256(_data.prevExitRequestsBlockNumber) << PREV_EXIT_REQUESTS_BLOCK_NUMBER_OFFSET) |
                (uint256(_data.prevExitRequestsLimit) << PREV_EXIT_REQUESTS_LIMIT_OFFSET) |
                (uint256(_data.maxExitRequestsLimitGrowthBlocks) << MAX_EXIT_REQUESTS_LIMIT_GROWTH_BLOCKS_OFFSET) |
                (uint256(_data.maxExitRequestsLimit) << MAX_EXIT_REQUESTS_LIMIT_OFFSET)
        );
    }
}

library ReportExitLimitUtils {
    /**
     * @notice Calculate exit requests limit
     * @dev using `_constGasMin` to make gas consumption independent of the current block number
     */
    function calculateCurrentExitRequestLimit(ExitRequestLimitData memory _data) internal view returns (uint256 limit) {
        uint256 exitRequestLimitIncPerBlock;
        if (_data.maxExitRequestsLimitGrowthBlocks != 0) {
            exitRequestLimitIncPerBlock = _data.maxExitRequestsLimit / _data.maxExitRequestsLimitGrowthBlocks;
        }

        uint256 blocksPassed = block.number - _data.prevExitRequestsBlockNumber;
        uint256 projectedLimit = _data.prevExitRequestsLimit + blocksPassed * exitRequestLimitIncPerBlock;

        limit = _constGasMin(projectedLimit, _data.maxExitRequestsLimit);
    }

    /**
     * @notice update exit requests limit repr after exit request
     * @dev input `_data` param is mutated and the func returns effectively the same pointer
     * @param _data exit request limit struct
     * @param _newPrevExitRequestsLimit new value for the `prevExitRequests` field
     */
    function updatePrevExitRequestsLimit(
        ExitRequestLimitData memory _data,
        uint256 _newPrevExitRequestsLimit
    ) internal view returns (ExitRequestLimitData memory) {
        _data.prevExitRequestsLimit = uint96(_newPrevExitRequestsLimit);
        _data.prevExitRequestsBlockNumber = uint32(block.number);

        return _data;
    }

    /**
     * @notice update exit request limit repr with the desired limits
     * @dev input `_data` param is mutated and the func returns effectively the same pointer
     * @param _data exit request limit struct
     * @param _maxExitRequestsLimit exit request limit max value
     * @param _exitRequestsLimitIncreasePerBlock exit request limit increase (restoration) per block
     */
    function setExitRequestLimit(
        ExitRequestLimitData memory _data,
        uint256 _maxExitRequestsLimit,
        uint256 _exitRequestsLimitIncreasePerBlock
    ) internal view returns (ExitRequestLimitData memory) {
        require(_maxExitRequestsLimit != 0, "ZERO_MAX_EXIT_REQUESTS_LIMIT");
        require(_maxExitRequestsLimit <= type(uint96).max, "TOO_LARGE_MAX_EXIT_REQUESTS_LIMIT");
        require(_maxExitRequestsLimit >= _exitRequestsLimitIncreasePerBlock, "TOO_LARGE_LIMIT_INCREASE");
        require(
            (_exitRequestsLimitIncreasePerBlock == 0) ||
                (_maxExitRequestsLimit / _exitRequestsLimitIncreasePerBlock <= type(uint32).max),
            "TOO_SMALL_LIMIT_INCREASE"
        );

        if (
            _data.prevExitRequestsBlockNumber == 0 ||
            _data.maxExitRequestsLimit == 0 ||
            _maxExitRequestsLimit < _data.prevExitRequestsLimit
        ) {
            _data.prevExitRequestsLimit = uint96(_maxExitRequestsLimit);
        }
        _data.maxExitRequestsLimitGrowthBlocks = _exitRequestsLimitIncreasePerBlock != 0
            ? uint32(_maxExitRequestsLimit / _exitRequestsLimitIncreasePerBlock)
            : 0;

        _data.maxExitRequestsLimit = uint96(_maxExitRequestsLimit);

        if (_data.prevExitRequestsBlockNumber != 0) {
            _data.prevExitRequestsBlockNumber = uint32(block.number);
        }

        return _data;
    }

    /**
     * @notice check if max exit request limit is set. Otherwise there are no limits on exits
     */
    function isExitRequestLimitSet(ExitRequestLimitData memory _data) internal pure returns (bool) {
        return _data.maxExitRequestsLimit != 0;
    }

    /**
     * @notice find a minimum of two numbers with a constant gas consumption
     * @dev doesn't use branching logic inside
     * @param _lhs left hand side value
     * @param _rhs right hand side value
     */
    function _constGasMin(uint256 _lhs, uint256 _rhs) internal pure returns (uint256 min) {
        uint256 lhsIsLess;
        assembly {
            lhsIsLess := lt(_lhs, _rhs) // lhsIsLess = (_lhs < _rhs) ? 1 : 0
        }
        min = (_lhs * lhsIsLess) + (_rhs * (1 - lhsIsLess));
    }
}
