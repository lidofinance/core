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
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010001,0)}
        return record.inOutDelta.currentValue();
    }

    function getVaultRecordInOutDelta(address _vault, uint48 _refSlot) external returns (int104) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010002,0)}
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory inOutDelta = record.inOutDelta;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010003,0)}
        return inOutDelta.getValueForRefSlot(_refSlot);
    }

    /// @dev This relies on DOUBLE_CACHE_LENGTH being 2!
    function getVaultRecordBothDeltas(address _vault) external returns (int104, int104) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010004,0)}
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory inOutDelta = record.inOutDelta;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010005,0)}
        return (inOutDelta[0].value, inOutDelta[1].value);
    }

    function getVaultReportDelta(address _vault) external view returns (int104) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010006,0)}
        return record.report.inOutDelta;
    }

    function getVaultReportTotal(address _vault) external view returns (uint104) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010007,0)}
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
        VaultConnection storage connection = _vaultConnection(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010008,0)}
        return connection.reserveRatioBP;
    }

    function maxLiabilityShares(address _vault) external view returns (uint96) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010009,0)}
        return record.maxLiabilityShares;
    }

    function minimalReserve(address _vault) external view returns (uint128) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000a,0)}
        return record.minimalReserve;
    } 

    function forcedRebalanceThresholdBP(address _vault) external view returns (uint16) {
        VaultConnection storage connection = _vaultConnection(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000b,0)}
        return connection.forcedRebalanceThresholdBP;
    }

    function unsettledLidoFees(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000c,0)}
        return _unsettledLidoFeesValue(record);
    }
    
    function obligationsShares(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000d,0)}
        return _obligationsShares(_vaultConnection(_vault), record);
    }

    function redemptionShares(address _vault) external view returns (uint128) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000e,0)}
        return record.redemptionShares;
    }


    function withdrawableValueFeesIncluded(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000f,0)}
        VaultConnection storage connection = _vaultConnection(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010010,0)}
        return _withdrawableValueFeesIncluded(_vault, connection, record);
    }


    function vaultData(address _vault) external view returns (uint256 reserveRatioBP_, uint256 thresholdBP_, uint256 totalValue_, uint256 liabilityShares_) {
        VaultConnection storage connection = _vaultConnection(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010011,0)}
        VaultRecord storage record = _vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010012,0)}

        reserveRatioBP_ = connection.reserveRatioBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000013,reserveRatioBP_)}
        thresholdBP_ = connection.forcedRebalanceThresholdBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000014,thresholdBP_)}
        liabilityShares_ = record.liabilityShares;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000015,liabilityShares_)}
        totalValue_ = _totalValue(record);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000016,totalValue_)}
    }

    
} 
