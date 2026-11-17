// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import { LazyOracle } from "contracts/0.8.25/vaults/LazyOracle.sol";
/*
import { VaultHub } from "contracts/0.8.25/vaults/VaultHub.sol";
import { ILidoLocator } from "contracts/common/interfaces/ILidoLocator.sol";
import { ILido } from "contracts/common/interfaces/ILido.sol";
import { IHashConsensus } from "contracts/common/interfaces/IHashConsensus.sol";
*/

/// @notice Harness for LazyOracle contract, exposing some functionality
contract LazyOracleHarness is LazyOracle {
    constructor(address _lidoLocator) LazyOracle(_lidoLocator) {
    }

    function handleSanityChecks(
        address _vault,
        uint256 _totalValue,
        uint48 _reportRefSlot,
        uint256 _reportTimestamp,
        uint256 _cumulativeLidoFees,
        uint256 _liabilityShares,
        uint256 _maxLiabilityShares
    ) external returns (uint256, int256) {
        return _handleSanityChecks(
            _vault,
            _totalValue,
            _reportRefSlot,
            _reportTimestamp,
            _cumulativeLidoFees,
            _liabilityShares,
            _maxLiabilityShares
        );
    }
}
