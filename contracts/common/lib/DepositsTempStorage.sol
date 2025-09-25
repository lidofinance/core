// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

library DepositsTempStorage {
    bytes32 private constant OPERATORS = keccak256("lido.DepositsTempStorage.operatorIds");
    bytes32 private constant COUNTS = keccak256("lido.DepositsTempStorage.depositCounts");
    /// need to store operators and allocations
    /// allocations or counts

    function storeOperators(uint256[] memory operators) public {
        _storeArray(OPERATORS, operators);
    }

    function storeCounts(uint256[] memory counts) public {
        _storeArray(COUNTS, counts);
    }

    function storeOperatorCounts(uint256[] memory operators, uint256[] memory counts) public {
        _storeArray(OPERATORS, operators);
        _storeArray(COUNTS, counts);
    }

    function getOperators() public view returns (uint256[] memory operators) {
        return _readArray(OPERATORS);
    }

    function getCounts() public view returns (uint256[] memory operators) {
        return _readArray(COUNTS);
    }

    function getOperatorCounts() public view returns (uint256[] memory operators, uint256[] memory counts) {
        operators = _readArray(OPERATORS);
        counts = _readArray(COUNTS);
    }

    function clearOperators() public {
        _clearArray(OPERATORS);
    }

    function clearCounts() public {
        _clearArray(COUNTS);
    }

    /// @notice Clear all transient storage data at once
    /// @dev Should be called at the end of transactions to maintain composability
    function clearOperatorCounts() public {
        _clearArray(OPERATORS);
        _clearArray(COUNTS);
    }

    function _storeArray(bytes32 base, uint256[] memory values) internal {
        // stor length of array
        assembly {
            tstore(base, mload(values))
        }

        unchecked {
            for (uint256 i = 0; i < values.length; ++i) {
                bytes32 slot = bytes32(uint256(base) + 1 + i);

                assembly {
                    tstore(slot, mload(add(values, add(0x20, mul(0x20, i)))))
                }
            }
        }
    }

    function _readArray(bytes32 base) internal view returns (uint256[] memory values) {
        uint256 arrayLength;
        assembly {
            arrayLength := tload(base)
        }
        values = new uint256[](arrayLength);

        unchecked {
            for (uint256 i = 0; i < arrayLength; ++i) {
                bytes32 slot = bytes32(uint256(base) + 1 + i);
                assembly {
                    mstore(add(values, add(0x20, mul(0x20, i))), tload(slot))
                }
            }
        }
    }

    function _clearArray(bytes32 base) private {
        uint256 len;
        assembly {
            tstore(base, 0)
        }

        unchecked {
            for (uint256 i = 0; i < len; ++i) {
                bytes32 slot = bytes32(uint256(base) + 1 + i);
                assembly {
                    tstore(slot, 0)
                }
            }
        }
    }

    /// TODO: need to store {operator_id, module_id} =>  allocations
    /// topUps will be calculated based on IStakingModuleV2.getAllocation(depositAmount,operators,topUpLimits) returns (uint256[] memory allocations) method
    /// topUpLimits - based on keys balances calc sum on each operator
}
