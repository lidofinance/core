// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

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
    }

    // keccak256(abi.encode(uint256(keccak256("LazyOracle")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LAZY_ORACLE_STORAGE_LOCATION =
        0xe5459f2b48ec5df2407caac4ec464a5cb0f7f31a1f22f649728a9579b25c1d00;

    ILidoLocator public immutable LIDO_LOCATOR;

    constructor(address _lidoLocator) {
        LIDO_LOCATOR = ILidoLocator(payable(_lidoLocator));
    }

    /// @notice returns the latest report data
    /// @return timestamp of the report
    /// @return treeRoot of the report
    /// @return reportCid of the report
    function latestReportData() external view returns (uint64 timestamp, bytes32 treeRoot, string memory reportCid) {
        Storage storage $ = _storage();
        return ($.vaultsDataTimestamp, $.vaultsDataTreeRoot, $.vaultsDataReportCid);
    }

    /// @notice returns batch of vaults info
    /// @param _offset offset of the vault in the batch (indexes start from 0)
    /// @param _limit limit of the batch
    /// @return batch of vaults info
    function batchVaultsInfo(uint256 _offset, uint256 _limit) external view returns (VaultInfo[] memory batch) {
        VaultHub vaultHub = VaultHub(payable(LIDO_LOCATOR.vaultHub()));
        uint256 vaultCount = vaultHub.vaultsCount();
        uint256 limit = _offset + _limit > vaultCount - 1 ? vaultCount - 1 - _offset : _limit;
        batch = new VaultInfo[](limit);
        for (uint256 i = 0; i < limit; i++) {
            VaultHub.VaultSocket memory socket = vaultHub.vaultSocket(i + 1 + _offset);
            IStakingVault currentVault = IStakingVault(socket.vault);
            batch[i] = VaultInfo(
                address(currentVault),
                address(currentVault).balance,
                socket.inOutDelta,
                currentVault.withdrawalCredentials(),
                socket.liabilityShares
            );
        }
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
    /// @param _chargedFees the fees charged to the vault
    /// @param _liabilityShares the liabilityShares of the vault
    /// @param _proof the proof of the reported data
    function updateVaultData(
        address _vault,
        uint256 _totalValue,
        int256 _inOutDelta,
        uint256 _chargedFees,
        uint256 _liabilityShares,
        bytes32[] calldata _proof
    ) external {
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(_vault, _totalValue, _inOutDelta, _chargedFees, _liabilityShares)))
        );
        if (!MerkleProof.verify(_proof, _storage().vaultsDataTreeRoot, leaf)) revert InvalidProof();

        VaultHub(payable(LIDO_LOCATOR.vaultHub()))
            .updateSocket(
                _vault,
                _storage().vaultsDataTimestamp,
                _totalValue,
                _inOutDelta,
                _chargedFees,
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
