// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "../interfaces/ILido.sol";
import {Math256} from "contracts/common/lib/Math256.sol";


contract LazyOracle {
    /// @custom:storage-location erc7201:LazyOracle
    struct Storage {
        /// @notice root of the vaults data tree
        bytes32 vaultsDataTreeRoot;
        /// @notice CID of the vaults data tree
        string vaultsDataReportCid;
        /// @notice timestamp of the vaults data
        uint64 vaultsDataTimestamp;
    }

    struct VaultInfo {
        address vault;
        uint256 balance;
        int256 inOutDelta;
        bytes32 withdrawalCredentials;
        uint256 liabilityShares;
        uint96 shareLimit;
        uint256 mintedStETH;
        uint256 mintableCapacityStETH;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 treasuryFeeBP;
        bool pendingDisconnect;
    }

    // keccak256(abi.encode(uint256(keccak256("LazyOracle")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LAZY_ORACLE_STORAGE_LOCATION =
        0xe5459f2b48ec5df2407caac4ec464a5cb0f7f31a1f22f649728a9579b25c1d00;

    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;

    ILidoLocator public immutable LIDO_LOCATOR;

    constructor(address _lidoLocator) {
        LIDO_LOCATOR = ILidoLocator(payable(_lidoLocator));
    }

    /// @notice returns the latest report data
    /// @return timestamp of the report
    /// @return treeRoot merkle root of the report
    /// @return reportCid IPFS CID for the report JSON file
    function latestReportData() external view returns (uint64 timestamp, bytes32 treeRoot, string memory reportCid) {
        Storage storage $ = _storage();
        return ($.vaultsDataTimestamp, $.vaultsDataTreeRoot, $.vaultsDataReportCid);
    }

    /// @notice returns the latest report timestamp
    function latestReportTimestamp() external view returns (uint64) {
        return _storage().vaultsDataTimestamp;
    }

    function getVaultCount() external view returns (uint256) {
        return VaultHub(payable(LIDO_LOCATOR.vaultHub())).vaultsCount();
    }

    /// @notice returns batch of vaults info
    /// @param _offset in the vaults list [0, vaultsCount)
    /// @param _limit maximum number of vaults to return
    /// @return batch of vaults info
    function batchVaultsInfo(uint256 _offset, uint256 _limit) external view returns (VaultInfo[] memory) {
        VaultHub vaultHub = VaultHub(payable(LIDO_LOCATOR.vaultHub()));

        uint256 vaultCount = vaultHub.vaultsCount();
        uint256 batchSize;
        if (_offset > vaultCount) {
            batchSize = 0;
        } else {
            batchSize = _offset + _limit > vaultCount ? vaultCount - _offset : _limit;
        }

        VaultInfo[] memory batch = new VaultInfo[](batchSize);
        for (uint256 i = 0; i < batchSize; i++) {
            address vaultAddress = vaultHub.vaultByIndex(_offset + i + 1);
            IStakingVault vault = IStakingVault(vaultAddress);
            VaultHub.VaultConnection memory connection = vaultHub.vaultConnection(vaultAddress);
            VaultHub.VaultRecord memory record = vaultHub.vaultRecord(vaultAddress);

            uint256 maxMintableStETH = (vaultHub.totalValue(vaultAddress) *
                (TOTAL_BASIS_POINTS - connection.reserveRatioBP)) / TOTAL_BASIS_POINTS;
            uint256 mintableCapacityStETH = Math256.min(
                ILido(LIDO_LOCATOR.lido()).getSharesByPooledEth(maxMintableStETH),
                connection.shareLimit
            );
            uint256 mintedStETH = record.locked - connection.reserveRatioBP / TOTAL_BASIS_POINTS;
    
            batch[i] = VaultInfo(
                vaultAddress,
                address(vault).balance,
                record.inOutDelta,
                vault.withdrawalCredentials(),
                record.liabilityShares,
                connection.shareLimit,
                mintedStETH,
                mintableCapacityStETH,
                connection.reserveRatioBP,
                connection.forcedRebalanceThresholdBP,
                connection.treasuryFeeBP,
                connection.pendingDisconnect
            );
        }
        return batch;
    }

    function updateReportData(
        uint64 _vaultsDataTimestamp,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataReportCid
    ) external {
        if (msg.sender != LIDO_LOCATOR.accountingOracle()) revert NotAuthorized();

        Storage storage $ = _storage();
        $.vaultsDataTimestamp = _vaultsDataTimestamp;
        $.vaultsDataTreeRoot = _vaultsDataTreeRoot;
        $.vaultsDataReportCid = _vaultsDataReportCid;
        emit VaultsReportDataUpdated(_vaultsDataTimestamp, _vaultsDataTreeRoot, _vaultsDataReportCid);
    }

    /// @notice Permissionless update of the vault data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault
    /// @param _inOutDelta the inOutDelta of the vault
    /// @param _feeSharesCharged the feeSharesCharged of the vault
    /// @param _liabilityShares the liabilityShares of the vault
    /// @param _proof the proof of the reported data
    function updateVaultData(
        address _vault,
        uint256 _totalValue,
        int256 _inOutDelta,
        uint256 _feeSharesCharged,
        uint256 _liabilityShares,
        bytes32[] calldata _proof
    ) external {
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(_vault, _totalValue, _inOutDelta, _feeSharesCharged, _liabilityShares)))
        );
        if (!MerkleProof.verify(_proof, _storage().vaultsDataTreeRoot, leaf)) revert InvalidProof();

        VaultHub(payable(LIDO_LOCATOR.vaultHub()))
            .applyVaultReport(
                _vault,
                _storage().vaultsDataTimestamp,
                _totalValue,
                _inOutDelta,
                _feeSharesCharged,
                _liabilityShares
            );
    }

    function _storage() internal pure returns (Storage storage $) {
        assembly {
            $.slot := LAZY_ORACLE_STORAGE_LOCATION
        }
    }

    event VaultsReportDataUpdated(uint64 timestamp, bytes32 root, string cid);

    error NotAuthorized();
    error InvalidProof();
}
