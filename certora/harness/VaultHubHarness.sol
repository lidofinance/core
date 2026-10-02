// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import { VaultHub } from "contracts/0.8.25/vaults/VaultHub.sol";
import { ILidoLocator } from "contracts/common/interfaces/ILidoLocator.sol";
import { ILido } from "contracts/common/interfaces/ILido.sol";
import { IHashConsensus } from "contracts/common/interfaces/IHashConsensus.sol";
import { DoubleRefSlotCache, DOUBLE_CACHE_LENGTH } from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";

/// @notice Harness for VaultHub contract, exposing some data.
contract VaultHubHarness is VaultHub {
    using DoubleRefSlotCache for DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH];

    constructor(
        ILidoLocator _locator,
        ILido _lido,
        IHashConsensus _consensusContract,
        uint256 _maxRelativeShareLimitBP
    ) VaultHub(_locator, _lido, _consensusContract, _maxRelativeShareLimitBP) {
    }

    function getVaultRecordDeltaValue(address _vault) external view returns (int104) {
        VaultRecord storage record = _vaultRecord(_vault);
        return record.inOutDelta.currentValue();
    }

    function getVaultRecordInOutDelta(address _vault, uint48 _refSlot) external returns (int104) {
        VaultRecord storage record = _vaultRecord(_vault);
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory inOutDelta = record.inOutDelta;
        return inOutDelta.getValueForRefSlot(_refSlot);
    }

    /// @dev This relies on DOUBLE_CACHE_LENGTH being 2!
    function getVaultRecordBothDeltas(address _vault) external returns (int104, int104) {
        VaultRecord storage record = _vaultRecord(_vault);
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory inOutDelta = record.inOutDelta;
        return (inOutDelta[0].value, inOutDelta[1].value);
    }

    function getVaultReportDelta(address _vault) external view returns (int104) {
        VaultRecord storage record = _vaultRecord(_vault);
        return record.report.inOutDelta;
    }

    function getVaultReportTotal(address _vault) external view returns (uint104) {
        VaultRecord storage record = _vaultRecord(_vault);
        return record.report.totalValue;
    }
    
    function vaultsArrayLength() external view returns (uint256) {
        return _storage().vaults.length;
    }

    function vaultArrayAtIndex(uint256 _index) external view returns (address) {
        return _storage().vaults[_index];
    }

    function getInitializedVersion() external view returns (uint64) {
        return _getInitializedVersion();
    }

    function reserveRatioBP(address _vault) external view returns (uint16) {
        VaultConnection storage connection = _vaultConnection(_vault);
        return connection.reserveRatioBP;
    }

    function maxLiabilityShares(address _vault) external view returns (uint96) {
        VaultRecord storage record = _vaultRecord(_vault);
        return record.maxLiabilityShares;
    }

    function minimalReserve(address _vault) external view returns (uint128) {
        VaultRecord storage record = _vaultRecord(_vault);
        return record.minimalReserve;
    } 

    function forcedRebalanceThresholdBP(address _vault) external view returns (uint16) {
        VaultConnection storage connection = _vaultConnection(_vault);
        return connection.forcedRebalanceThresholdBP;
    }

    function unsettledLidoFees(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);
        return _unsettledLidoFeesValue(record);
    }
    
    function obligationsShares(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);
        return _obligationsShares(_vaultConnection(_vault), record);
    }

    function redemptionShares(address _vault) external view returns (uint128) {
        VaultRecord storage record = _vaultRecord(_vault);
        return record.redemptionShares;
    }


    function withdrawableValueFeesIncluded(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);
        VaultConnection storage connection = _vaultConnection(_vault);
        return _withdrawableValueFeesIncluded(_vault, connection, record);
    }


    function vaultData(address _vault) external view returns (uint256 reserveRatioBP_, uint256 thresholdBP_, uint256 totalValue_, uint256 liabilityShares_) {
        VaultConnection storage connection = _vaultConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        reserveRatioBP_ = connection.reserveRatioBP;
        thresholdBP_ = connection.forcedRebalanceThresholdBP;
        liabilityShares_ = record.liabilityShares;
        totalValue_ = _totalValue(record);
    }

    
} 
