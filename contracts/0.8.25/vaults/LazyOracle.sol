// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {ILazyOracle} from "contracts/common/interfaces/ILazyOracle.sol";
import {VaultHub} from "./VaultHub.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IHashConsensus} from "./interfaces/IHashConsensus.sol";
import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

contract LazyOracle is ILazyOracle, AccessControlEnumerable {
    /// @custom:storage-location erc7201:LazyOracle
    struct Storage {
        /// @notice root of the vaults data tree
        bytes32 vaultsDataTreeRoot;
        /// @notice CID of the vaults data tree
        string vaultsDataReportCid;
        /// @notice timestamp of the vaults data
        uint64 vaultsDataTimestamp;
        /// @notice total value increase quarantine period
        uint64 quarantinePeriod;
        /// @notice max reward ratio for refSlot total value, basis points
        uint16 maxRewardRatioBP;
        /// @notice deposit quarantines for each vault
        mapping(address vault => Quarantine) vaultQuarantines;
    }

    struct Quarantine {
        uint128 pendingTotalValueIncrease;
        uint64 startTimestamp;
    }

    struct VaultInfo {
        address vault;
        uint256 balance;
        int256 inOutDelta;
        bytes32 withdrawalCredentials;
        uint256 liabilityShares;
        uint96 shareLimit;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 infraFeeBP;
        uint16 liquidityFeeBP;
        uint16 reservationFeeBP;
        bool pendingDisconnect;
    }

    // keccak256(abi.encode(uint256(keccak256("LazyOracle")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LAZY_ORACLE_STORAGE_LOCATION =
        0xe5459f2b48ec5df2407caac4ec464a5cb0f7f31a1f22f649728a9579b25c1d00;

    bytes32 public constant UPDATE_SANITY_PARAMS_ROLE = keccak256("UPDATE_SANITY_PARAMS_ROLE");

    // total basis points = 100%
    uint256 internal constant TOTAL_BP = 100_00;

    ILidoLocator public immutable LIDO_LOCATOR;
    IHashConsensus public immutable HASH_CONSENSUS;

    constructor(address _lidoLocator, address _hashConsensus, address _admin, uint64 _quarantinePeriod, uint16 _maxRewardRatioBP) {
        LIDO_LOCATOR = ILidoLocator(payable(_lidoLocator));
        HASH_CONSENSUS = IHashConsensus(_hashConsensus);

        _updateSanityParams(_quarantinePeriod, _maxRewardRatioBP);

        if (_admin == address(0)) revert AdminCannotBeZero();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
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

    /// @notice returns the quarantine period
    function quarantinePeriod() external view returns (uint64) {
        return _storage().quarantinePeriod;
    }

    /// @notice returns the max reward ratio for refSlot total value, basis points
    function maxRewardRatioBP() external view returns (uint16) {
        return _storage().maxRewardRatioBP;
    }

    /// @notice returns the quarantine for the vault
    /// @param _vault the address of the vault
    /// @return the quarantine for the vault
    function vaultQuarantine(address _vault) external view returns (Quarantine memory) {
        return _storage().vaultQuarantines[_vault];
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
            batch[i] = VaultInfo(
                vaultAddress,
                address(vault).balance,
                record.inOutDelta,
                vault.withdrawalCredentials(),
                record.liabilityShares,
                connection.shareLimit,
                connection.reserveRatioBP,
                connection.forcedRebalanceThresholdBP,
                connection.infraFeeBP,
                connection.liquidityFeeBP,
                connection.reservationFeeBP,
                connection.pendingDisconnect
            );
        }
        return batch;
    }

    /// @notice update the sanity parameters
    /// @param _quarantinePeriod the quarantine period
    /// @param _maxRewardRatioBP the max EL CL rewards
    function updateSanityParams(uint64 _quarantinePeriod, uint16 _maxRewardRatioBP) external onlyRole(UPDATE_SANITY_PARAMS_ROLE) {
        _updateSanityParams(_quarantinePeriod, _maxRewardRatioBP);
    }

    /// @notice Store the report root and its meta information
    /// @param _vaultsDataTimestamp the timestamp of the report
    /// @param _vaultsDataTreeRoot the root of the report
    /// @param _vaultsDataReportCid the CID of the report
    function updateReportData(
        uint256 _vaultsDataTimestamp,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataReportCid
    ) external override(ILazyOracle) {
        if (msg.sender != LIDO_LOCATOR.accountingOracle()) revert NotAuthorized();

        Storage storage $ = _storage();
        $.vaultsDataTimestamp = uint64(_vaultsDataTimestamp);
        $.vaultsDataTreeRoot = _vaultsDataTreeRoot;
        $.vaultsDataReportCid = _vaultsDataReportCid;

        emit VaultsReportDataUpdated(_vaultsDataTimestamp, _vaultsDataTreeRoot, _vaultsDataReportCid);
    }

    /// @notice Permissionless update of the vault data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault
    /// @param _feeSharesCharged the feeSharesCharged of the vault
    /// @param _liabilityShares the liabilityShares of the vault
    /// @param _proof the proof of the reported data
    function updateVaultData(
        address _vault,
        uint256 _totalValue,
        uint256 _feeSharesCharged,
        uint256 _liabilityShares,
        bytes32[] calldata _proof
    ) external {
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(_vault, _totalValue, _feeSharesCharged, _liabilityShares)))
        );
        if (!MerkleProof.verify(_proof, _storage().vaultsDataTreeRoot, leaf)) revert InvalidProof();

        int256 inOutDelta;
        (_totalValue, inOutDelta) = _handleSanityChecks(_vault, _totalValue);

        VaultHub(payable(LIDO_LOCATOR.vaultHub()))
            .applyVaultReport(
                _vault,
                _storage().vaultsDataTimestamp,
                _totalValue,
                inOutDelta,
                _feeSharesCharged,
                _liabilityShares
            );
    }

    /// @notice handle sanity checks for the vault lazy report data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault in refSlot
    /// @return totalValue the smoothed total value of the vault after sanity checks
    /// @return inOutDelta the inOutDelta in the refSlot
    function _handleSanityChecks(address _vault, uint256 _totalValue) public returns (uint256 totalValue, int256 inOutDelta) {
        VaultHub vaultHub = VaultHub(payable(LIDO_LOCATOR.vaultHub()));
        VaultHub.VaultConnection memory connection = vaultHub.vaultConnection(_vault);
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(_vault);

        // 1. Calculate inOutDelta in the refSlot
        int256 curInOutDelta = record.inOutDelta;
        (uint256 refSlot, ) = HASH_CONSENSUS.getCurrentFrame();
        if (record.cachedRefSlot == refSlot) {
            inOutDelta = record.cachedInOutDelta;
        } else {
            inOutDelta = curInOutDelta;
        }

        // 2. Sanity check for total value increase
        totalValue = _checkTotalValue(_vault, _totalValue, inOutDelta, record);

        // 3. Sanity check for dynamic total value underflow
        if (int256(totalValue) + curInOutDelta - inOutDelta < 0) revert UnderflowInTotalValueCalculation();

        return (totalValue, inOutDelta);
    }

    /*
        Here we need to introduce 2 concepts direct and side fund:
        1. Direct fund happens when the vault owner first tops up ETH balance of the vault contract (through fund() method) 
        and then bring lazy (on-demand) report. In this case we can proof that ETH really exist, so vault owner can add 
        as much ETH as he wants.  
        2. Any other ways of topping up vault's totalValue (consolidations, direct deposit to beaconchain contract, etc.) are 
        considered side. In this case we set "quarantine" period for this side fund. It means that totalValue actually 
        will be increased by this amount only after quarantine period expires.
    */
    function _checkTotalValue(address _vault, uint256 _totalValue, int256 _inOutDelta, VaultHub.VaultRecord memory record) internal returns (uint256) {
        Storage storage $ = _storage();

        uint256 refSlotTotalValue = uint256(int256(uint256(record.report.totalValue)) + _inOutDelta - record.report.inOutDelta);
        // small percentage of unsafe funds is allowed for the EL CL rewards handling
        uint256 limit = refSlotTotalValue * (TOTAL_BP + $.maxRewardRatioBP) / TOTAL_BP;

        if (_totalValue > limit) {
            Quarantine storage q = $.vaultQuarantines[_vault];
            uint64 reportTs = $.vaultsDataTimestamp;
            uint128 quarDelta = q.pendingTotalValueIncrease;
            // Safe conversion from uint256 to uint128
            if (_totalValue - refSlotTotalValue > type(uint128).max) revert ValueExceedsUint128();
            uint128 delta = uint128(_totalValue - refSlotTotalValue);

            if (quarDelta == 0) {
                // first overlimit report
                _totalValue = refSlotTotalValue;
                q.pendingTotalValueIncrease = delta;
                q.startTimestamp = reportTs;
                emit QuarantinedDeposit(_vault, delta);
            } else {
                // subsequent overlimit reports
                if (reportTs - q.startTimestamp < $.quarantinePeriod) {
                    _totalValue = refSlotTotalValue;
                } else {
                    // quarantine period expired
                    if (delta <= quarDelta + refSlotTotalValue * $.maxRewardRatioBP / TOTAL_BP) {
                        q.pendingTotalValueIncrease = 0;
                    } else {
                        _totalValue = refSlotTotalValue + quarDelta;
                        q.pendingTotalValueIncrease = delta - quarDelta;
                        q.startTimestamp = reportTs;
                        emit QuarantinedDeposit(_vault, delta - quarDelta);
                    }
                }
            }
        }

        return _totalValue;
    }

    function _updateSanityParams(uint64 _quarantinePeriod, uint16 _maxRewardRatioBP) internal {
        Storage storage $ = _storage();
        $.quarantinePeriod = _quarantinePeriod;
        $.maxRewardRatioBP = _maxRewardRatioBP;
        emit SanityParamsUpdated(_quarantinePeriod, _maxRewardRatioBP);
    }

    function _storage() internal pure returns (Storage storage $) {
        assembly {
            $.slot := LAZY_ORACLE_STORAGE_LOCATION
        }
    }

    event VaultsReportDataUpdated(uint256 indexed timestamp, bytes32 indexed root, string cid);
    event QuarantinedDeposit(address vault, uint128 delta);
    event SanityParamsUpdated(uint64 quarantinePeriod, uint16 maxRewardRatioBP);

    error AdminCannotBeZero();
    error NotAuthorized();
    error InvalidProof();
    error UnderflowInTotalValueCalculation();
    error ValueExceedsUint128();
}
