// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {Math256} from "contracts/common/lib/Math256.sol";
import {ILazyOracle} from "contracts/common/interfaces/ILazyOracle.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

import {VaultHub} from "./VaultHub.sol";
import {OperatorGrid} from "./OperatorGrid.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

contract LazyOracle is ILazyOracle, AccessControlEnumerableUpgradeable {
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
        /// @notice max reward ratio for refSlot-observed total value, basis points
        uint16 maxRewardRatioBP;
        /// @notice deposit quarantines for each vault
        mapping(address vault => Quarantine) vaultQuarantines;
    }

    /*
        A quarantine is a timelock applied to any sudden jump in a vault's reported total value
        that cannot be immediately confirmed on-chain (via the inOutDelta difference). If the
        reported total value exceeds the expected routine EL/CL rewards, the excess is pushed
        into a quarantine buffer for a predefined cooldown period. Only after this delay is the
        quarantined value released into VaultHub's total value.

        Normal top-ups — where the vault owner funds the contract directly using the `fund()`
        function — do not go through quarantine, as they can be verified on-chain via the
        inOutDelta value. These direct fundings are reflected immediately. In contrast,
        consolidations or deposits that bypass the vault's balance must sit in quarantine.

        Example flow:

        Time 0: Total Value = 100 ETH
        ┌────────────────────────────────────┐
        │            100 ETH Active          │
        └────────────────────────────────────┘

        Time 1: Sudden jump of +50 ETH → start quarantine for 50 ETH
        ┌────────────────────────────────────┐
        │            100 ETH Active          │
        │            50 ETH Quarantined      │
        └────────────────────────────────────┘

        Time 2: Another jump of +70 ETH → wait for current quarantine to expire
        ┌────────────────────────────────────┐
        │            100 ETH Active          │
        │            50 ETH Quarantined      │
        │            70 ETH Quarantine Queue │
        └────────────────────────────────────┘

        Time 3: First quarantine expires → add 50 ETH to active value, start new quarantine for 70 ETH
        ┌────────────────────────────────────┐
        │            150 ETH Active          │
        │            70 ETH Quarantined      │
        └────────────────────────────────────┘

        Time 4: Second quarantine expires → add 70 ETH to active value
        ┌────────────────────────────────────┐
        │            220 ETH Active          │
        └────────────────────────────────────┘
    */
    struct Quarantine {
        uint128 pendingTotalValueIncrease;
        uint64 startTimestamp;
    }

    struct QuarantineInfo {
        bool isActive;
        uint256 pendingTotalValueIncrease;
        uint256 startTimestamp;
        uint256 endTimestamp;
    }

    struct VaultInfo {
        address vault;
        uint96 vaultIndex;
        uint256 balance;
        bytes32 withdrawalCredentials;
        uint256 liabilityShares;
        uint256 mintableStETH;
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

    ILidoLocator public immutable LIDO_LOCATOR;

    /// @dev basis points base
    uint256 private constant TOTAL_BASIS_POINTS = 100_00;
    uint256 private constant MAX_SANE_TOTAL_VALUE = type(uint96).max;

    constructor(address _lidoLocator) {
        LIDO_LOCATOR = ILidoLocator(payable(_lidoLocator));

        _disableInitializers();
    }

    /// @notice Initializes the contract
    /// @param _admin Address of the admin
    /// @param _quarantinePeriod the quarantine period, seconds
    /// @param _maxRewardRatioBP the max reward ratio, basis points
    function initialize(address _admin, uint64 _quarantinePeriod, uint16 _maxRewardRatioBP) external initializer {
        if (_admin == address(0)) revert AdminCannotBeZero();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        _updateSanityParams(_quarantinePeriod, _maxRewardRatioBP);
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

    /// @notice returns the quarantine info for the vault
    /// @param _vault the address of the vault
    // @dev returns zeroed structure if there is no active quarantine
    function vaultQuarantine(address _vault) external view returns (QuarantineInfo memory) {
        Quarantine storage q = _storage().vaultQuarantines[_vault];
        if (q.pendingTotalValueIncrease == 0) {
            return QuarantineInfo(false, 0, 0, 0);
        }

        return QuarantineInfo({
            isActive: true,
            pendingTotalValueIncrease: q.pendingTotalValueIncrease,
            startTimestamp: q.startTimestamp,
            endTimestamp: q.startTimestamp + _storage().quarantinePeriod
        });
    }

    /// @notice returns batch of vaults info
    /// @param _offset in the vaults list [0, vaultsCount)
    /// @param _limit maximum number of vaults to return
    /// @return batch of vaults info
    function batchVaultsInfo(uint256 _offset, uint256 _limit) external view returns (VaultInfo[] memory) {
        VaultHub vaultHub = _vaultHub();
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
                connection.vaultIndex,
                address(vault).balance,
                vault.withdrawalCredentials(),
                record.liabilityShares,
                _mintableStETH(vaultAddress),
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
    function updateSanityParams(
        uint64 _quarantinePeriod,
        uint16 _maxRewardRatioBP
    ) external onlyRole(UPDATE_SANITY_PARAMS_ROLE) {
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
    /// @param _cumulativeLidoFees the cumulative Lido fees accrued on the vault (nominated in ether)
    /// @param _liabilityShares the liabilityShares of the vault
    /// @param _proof the proof of the reported data
    function updateVaultData(
        address _vault,
        uint256 _totalValue,
        uint256 _cumulativeLidoFees,
        uint256 _liabilityShares,
        uint256 _slashingReserve,
        bytes32[] calldata _proof
    ) external {
        bytes32 leaf = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        _vault,
                        _totalValue,
                        _cumulativeLidoFees,
                        _liabilityShares,
                        _slashingReserve
                    )
                )
            )
        );
        if (!MerkleProof.verify(_proof, _storage().vaultsDataTreeRoot, leaf)) revert InvalidProof();

        int256 inOutDelta;
        (_totalValue, inOutDelta) = _handleSanityChecks(_vault, _totalValue);

        _vaultHub().applyVaultReport(
            _vault,
            _storage().vaultsDataTimestamp,
            _totalValue,
            inOutDelta,
            _cumulativeLidoFees,
            _liabilityShares,
            _slashingReserve
        );
    }

    /// @notice handle sanity checks for the vault lazy report data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault in refSlot
    /// @return totalValueWithoutQuarantine the smoothed total value of the vault after sanity checks
    /// @return inOutDeltaOnRefSlot the inOutDelta in the refSlot
    function _handleSanityChecks(
        address _vault,
        uint256 _totalValue
    ) public returns (uint256 totalValueWithoutQuarantine, int256 inOutDeltaOnRefSlot) {
        VaultHub vaultHub = _vaultHub();
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(_vault);

        // 1. Calculate inOutDelta in the refSlot
        int256 currentInOutDelta = record.inOutDelta.value;
        inOutDeltaOnRefSlot = vaultHub.inOutDeltaAsOfLastRefSlot(_vault);

        // 2. Sanity check for total value increase
        totalValueWithoutQuarantine = _processTotalValue(_vault, _totalValue, inOutDeltaOnRefSlot, record);

        // 3. Sanity check for dynamic total value underflow
        if (int256(totalValueWithoutQuarantine) + currentInOutDelta - inOutDeltaOnRefSlot < 0) {
            revert UnderflowInTotalValueCalculation();
        }
    }

    function _processTotalValue(
        address _vault,
        uint256 _reportedTotalValue,
        int256 _inOutDeltaOnRefSlot,
        VaultHub.VaultRecord memory record
    ) internal returns (uint256 totalValueWithoutQuarantine) {
        if (_reportedTotalValue > MAX_SANE_TOTAL_VALUE) {
            revert TotalValueTooLarge();
        }

        Storage storage $ = _storage();

        // total value from the previous report with inOutDelta correction till the current refSlot
        // it does not include CL difference and EL rewards for the period
        uint256 onchainTotalValueOnRefSlot =
            uint256(int256(uint256(record.report.totalValue)) + _inOutDeltaOnRefSlot - record.report.inOutDelta);
        // some percentage of funds hasn't passed through the vault's balance is allowed for the EL and CL rewards handling
        uint256 maxSaneTotalValue = onchainTotalValueOnRefSlot *
            (TOTAL_BASIS_POINTS + $.maxRewardRatioBP) / TOTAL_BASIS_POINTS;

        if (_reportedTotalValue > maxSaneTotalValue) {
            Quarantine storage q = $.vaultQuarantines[_vault];
            uint64 reportTs = $.vaultsDataTimestamp;
            uint128 quarDelta = q.pendingTotalValueIncrease;
            uint128 delta = uint128(_reportedTotalValue - onchainTotalValueOnRefSlot);

            if (quarDelta == 0) { // first overlimit report
                _reportedTotalValue = onchainTotalValueOnRefSlot;
                q.pendingTotalValueIncrease = delta;
                q.startTimestamp = reportTs;
                emit QuarantinedDeposit(_vault, delta);
            } else if (reportTs - q.startTimestamp < $.quarantinePeriod) { // quarantine not expired
                _reportedTotalValue = onchainTotalValueOnRefSlot;
            } else if (delta <= quarDelta + onchainTotalValueOnRefSlot * $.maxRewardRatioBP / TOTAL_BASIS_POINTS) { // quarantine expired
                q.pendingTotalValueIncrease = 0;
                emit QuarantineExpired(_vault, delta);
            } else { // start new quarantine
                _reportedTotalValue = onchainTotalValueOnRefSlot + quarDelta;
                q.pendingTotalValueIncrease = delta - quarDelta;
                q.startTimestamp = reportTs;
                emit QuarantinedDeposit(_vault, delta - quarDelta);
            }
        }

        return _reportedTotalValue;
    }

    function _updateSanityParams(uint64 _quarantinePeriod, uint16 _maxRewardRatioBP) internal {
        Storage storage $ = _storage();
        $.quarantinePeriod = _quarantinePeriod;
        $.maxRewardRatioBP = _maxRewardRatioBP;
        emit SanityParamsUpdated(_quarantinePeriod, _maxRewardRatioBP);
    }

    function _mintableStETH(address _vault) internal view returns (uint256) {
        VaultHub vaultHub = _vaultHub();
        uint256 maxLockableValue = vaultHub.maxLockableValue(_vault);
        uint256 reserveRatioBP = vaultHub.vaultConnection(_vault).reserveRatioBP;
        uint256 mintableStETHByRR = maxLockableValue * (TOTAL_BASIS_POINTS - reserveRatioBP) / TOTAL_BASIS_POINTS;

        uint256 effectiveShareLimit = _operatorGrid().effectiveShareLimit(_vault);
        uint256 mintableStEthByShareLimit = ILido(LIDO_LOCATOR.lido()).getPooledEthBySharesRoundUp(effectiveShareLimit);

        return Math256.min(mintableStETHByRR, mintableStEthByShareLimit);
    }

    function _storage() internal pure returns (Storage storage $) {
        assembly {
            $.slot := LAZY_ORACLE_STORAGE_LOCATION
        }
    }

    function _vaultHub() internal view returns (VaultHub) {
        return VaultHub(payable(LIDO_LOCATOR.vaultHub()));
    }

    function _operatorGrid() internal view returns (OperatorGrid) {
        return OperatorGrid(LIDO_LOCATOR.operatorGrid());
    }

    event VaultsReportDataUpdated(uint256 indexed timestamp, bytes32 indexed root, string cid);
    event QuarantinedDeposit(address indexed vault, uint128 delta);
    event SanityParamsUpdated(uint64 quarantinePeriod, uint16 maxRewardRatioBP);
    event QuarantineExpired(address indexed vault, uint128 delta);
    error AdminCannotBeZero();
    error NotAuthorized();
    error InvalidProof();
    error UnderflowInTotalValueCalculation();
    error TotalValueTooLarge();
}
