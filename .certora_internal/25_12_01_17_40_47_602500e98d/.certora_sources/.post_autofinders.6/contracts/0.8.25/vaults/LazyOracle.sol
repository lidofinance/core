// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {ILazyOracle} from "contracts/common/interfaces/ILazyOracle.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";

import {VaultHub} from "./VaultHub.sol";
import {OperatorGrid} from "./OperatorGrid.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "./interfaces/IPredepositGuarantee.sol";

import {DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "./lib/RefSlotCache.sol";

contract LazyOracle is ILazyOracle, AccessControlEnumerableUpgradeable {
    using DoubleRefSlotCache for DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH];

    enum QuarantineState {
        NO_QUARANTINE,      // No active quarantine
        QUARANTINE_ACTIVE,  // Quarantine active, not expired
        QUARANTINE_EXPIRED  // Quarantine period has passed
    }

    /// @custom:storage-location erc7201:Lido.Vaults.LazyOracle
    struct Storage {
        /// @notice root of the vaults data tree
        bytes32 vaultsDataTreeRoot;
        /// @notice CID of the vaults data tree
        string vaultsDataReportCid;
        /// @notice timestamp of the vaults data
        uint64 vaultsDataTimestamp;
        /// @notice refSlot of the vaults data
        uint48 vaultsDataRefSlot;
        /// @notice total value increase quarantine period
        uint64 quarantinePeriod;
        /// @notice max reward ratio for refSlot-observed total value, basis points
        uint16 maxRewardRatioBP;
        /// @notice max Lido fee rate per second, in wei
        uint64 maxLidoFeeRatePerSecond;  // 64 bit is enough for up to 18 ETH/s
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
        uint128 totalValueRemainder;
    }

    struct QuarantineInfo {
        bool isActive;
        uint256 pendingTotalValueIncrease;
        uint256 startTimestamp;
        uint256 endTimestamp;
        uint256 totalValueRemainder;
    }

    struct VaultInfo {
        address vault;
        uint256 aggregatedBalance; // includes availableBalance and stagedBalance
        int256 inOutDelta;
        bytes32 withdrawalCredentials;
        uint256 liabilityShares;
        uint256 maxLiabilityShares;
        uint256 mintableStETH;
        uint96 shareLimit;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 infraFeeBP;
        uint16 liquidityFeeBP;
        uint16 reservationFeeBP;
        bool pendingDisconnect;
    }

    // keccak256(abi.encode(uint256(keccak256("Lido.Vaults.LazyOracle")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LAZY_ORACLE_STORAGE_LOCATION =
        0x73a2a247d4b1b6fe056fe90935e9bd3694e896bafdd08f046c2afe6ec2db2100;

    /// @dev 0x7baf7f4a9784fa74c97162de631a3eb567edeb85878cb6965945310f2c512c63
    bytes32 public constant UPDATE_SANITY_PARAMS_ROLE = keccak256("vaults.LazyOracle.UpdateSanityParams");

    ILidoLocator public immutable LIDO_LOCATOR;

    /// @dev basis points base
    uint256 private constant TOTAL_BASIS_POINTS = 100_00;
    uint256 private constant MAX_SANE_TOTAL_VALUE = type(uint96).max;
    uint256 public constant MAX_QUARANTINE_PERIOD = 30 days;
    /// @dev max value for reward ratio - it's about 650%
    uint256 public constant MAX_REWARD_RATIO = type(uint16).max;
    uint256 public constant MAX_LIDO_FEE_RATE_PER_SECOND = 10 ether;

    constructor(address _lidoLocator) {
        LIDO_LOCATOR = ILidoLocator(payable(_lidoLocator));

        _disableInitializers();
    }

    /// @notice Initializes the contract
    /// @param _admin Address of the admin
    /// @param _quarantinePeriod the quarantine period, seconds
    /// @param _maxRewardRatioBP the max reward ratio, basis points
    /// @param _maxLidoFeeRatePerSecond the max Lido fee rate per second
    function initialize(
        address _admin,
        uint256 _quarantinePeriod,
        uint256 _maxRewardRatioBP,
        uint256 _maxLidoFeeRatePerSecond
    ) external initializer {
        if (_admin == address(0)) revert AdminCannotBeZero();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        _updateSanityParams(_quarantinePeriod, _maxRewardRatioBP, _maxLidoFeeRatePerSecond);
    }

    /// @notice returns the latest report data
    /// @return timestamp of the report
    /// @return refSlot of the report
    /// @return treeRoot merkle root of the report
    /// @return reportCid IPFS CID for the report JSON file
    function latestReportData() external view returns (
        uint256 timestamp,
        uint256 refSlot,
        bytes32 treeRoot,
        string memory reportCid
    ) {
        Storage storage $ = _storage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000f,0)}
        return ($.vaultsDataTimestamp, $.vaultsDataRefSlot, $.vaultsDataTreeRoot, $.vaultsDataReportCid);
    }

    /// @notice returns the latest report timestamp
    function latestReportTimestamp() external view returns (uint256) {
        return _storage().vaultsDataTimestamp;
    }

    /// @notice returns the quarantine period
    function quarantinePeriod() external view returns (uint256) {
        return _storage().quarantinePeriod;
    }

    /// @notice returns the max reward ratio for refSlot total value, basis points
    function maxRewardRatioBP() external view returns (uint256) {
        return _storage().maxRewardRatioBP;
    }

    /// @notice returns the max Lido fee rate per second, in ether
    function maxLidoFeeRatePerSecond() external view returns (uint256) {
        return _storage().maxLidoFeeRatePerSecond;
    }

    /// @notice returns the amount of total value that is pending in the quarantine for the given vault
    function quarantineValue(address _vault) external view returns (uint256) {
        Quarantine memory q = _storage().vaultQuarantines[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010010,0)}
        uint256 pendingValue = q.pendingTotalValueIncrease;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000011,pendingValue)}
        if (pendingValue > 0) {
            // saving one SLOAD if pendingValue is zero
            pendingValue += q.totalValueRemainder;
        }
        return pendingValue;
    }

    /// @notice returns the quarantine info for the vault
    /// @param _vault the address of the vault
    /// @dev returns zeroed structure if there is no active quarantine
    function vaultQuarantine(address _vault) external view returns (QuarantineInfo memory) {
        Quarantine memory q = _storage().vaultQuarantines[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010012,0)}

        bool isQuarantineInactive = q.pendingTotalValueIncrease == 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000013,isQuarantineInactive)}

        if (isQuarantineInactive) {
            return QuarantineInfo(false, 0, 0, 0, 0);
        }

        return QuarantineInfo({
            isActive: true,
            pendingTotalValueIncrease: q.pendingTotalValueIncrease,
            startTimestamp: q.startTimestamp,
            endTimestamp: q.startTimestamp + _storage().quarantinePeriod,
            totalValueRemainder: q.totalValueRemainder
        });
    }

    /// @notice returns the number of vaults connected to the VaultHub
    /// @return the number of vaults connected to the VaultHub
    function vaultsCount() external view returns (uint256) {
        return _vaultHub().vaultsCount();
    }

    /// @notice returns batch of vaults info
    /// @param _offset in the vaults list [0, vaultsCount)
    /// @param _limit maximum number of vaults to return
    /// @return batch of vaults info
    function batchVaultsInfo(uint256 _offset, uint256 _limit) external view returns (VaultInfo[] memory) {
        VaultHub vaultHub = _vaultHub();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010014,0)}
        uint256 vaultCount = vaultHub.vaultsCount();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000015,vaultCount)}
        uint256 batchSize;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000016,batchSize)}
        if (_offset > vaultCount) {
            batchSize = 0;
        } else {
            batchSize = _offset + _limit > vaultCount ? vaultCount - _offset : _limit;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003d,batchSize)}
        }

        VaultInfo[] memory batch = new VaultInfo[](batchSize);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010017,0)}
        for (uint256 i = 0; i < batchSize; i++) {
            address vaultAddress = vaultHub.vaultByIndex(_offset + i + 1);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003c,vaultAddress)}
            batch[i] = _vaultInfo(vaultAddress, vaultHub);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0002003e,0)}
        }
        return batch;
    }

    /// @notice returns the vault data info
    /// @param _vault the address of the vault
    /// @return the vault data info
    function vaultInfo(address _vault) external view returns (VaultInfo memory) {
        return _vaultInfo(_vault, _vaultHub());
    }

    /**
     * @notice batch method to mass check the validator statuses in PredepositGuarantee contract
     * @param _pubkeys the array of validator's pubkeys to check
     * @return batch array of IPredepositGuarantee.ValidatorStatus structs
     */
    function batchValidatorStatuses(
        bytes[] calldata _pubkeys
    ) external view returns (IPredepositGuarantee.ValidatorStatus[] memory batch) {
        batch = new IPredepositGuarantee.ValidatorStatus[](_pubkeys.length);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0002002f,0)}

        for (uint256 i = 0; i < _pubkeys.length; i++) {
            batch[i] = predepositGuarantee().validatorStatus(_pubkeys[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0002003f,0)}
        }
    }

    /// @notice update the sanity parameters
    /// @param _quarantinePeriod the quarantine period
    /// @param _maxRewardRatioBP the max EL CL rewards
    /// @param _maxLidoFeeRatePerSecond the max Lido fee rate per second
    function updateSanityParams(
        uint256 _quarantinePeriod,
        uint256 _maxRewardRatioBP,
        uint256 _maxLidoFeeRatePerSecond
    ) external onlyRole(UPDATE_SANITY_PARAMS_ROLE) {
        _updateSanityParams(_quarantinePeriod, _maxRewardRatioBP, _maxLidoFeeRatePerSecond);
    }

    /// @notice Store the report root and its meta information
    /// @param _vaultsDataTimestamp the timestamp of the report
    /// @param _vaultsDataRefSlot the refSlot of the report
    /// @param _vaultsDataTreeRoot the root of the report
    /// @param _vaultsDataReportCid the CID of the report
    function updateReportData(
        uint256 _vaultsDataTimestamp,
        uint256 _vaultsDataRefSlot,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataReportCid
    ) external override(ILazyOracle) {
        if (msg.sender != LIDO_LOCATOR.accountingOracle()) revert NotAuthorized();

        Storage storage $ = _storage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010018,0)}
        $.vaultsDataTimestamp = uint64(_vaultsDataTimestamp);uint64 certora_local48 = $.vaultsDataTimestamp;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000030,certora_local48)}
        $.vaultsDataRefSlot = uint48(_vaultsDataRefSlot);uint48 certora_local49 = $.vaultsDataRefSlot;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000031,certora_local49)}
        $.vaultsDataTreeRoot = _vaultsDataTreeRoot;bytes32 certora_local50 = $.vaultsDataTreeRoot;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000032,certora_local50)}
        $.vaultsDataReportCid = _vaultsDataReportCid;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00020033,0)}

        emit VaultsReportDataUpdated(
            _vaultsDataTimestamp,
            _vaultsDataRefSlot,
            _vaultsDataTreeRoot,
            _vaultsDataReportCid
        );
    }

    /// @notice Permissionless update of the vault data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault
    /// @param _cumulativeLidoFees the cumulative Lido fees accrued on the vault (nominated in ether)
    /// @param _liabilityShares the liabilityShares value of the vault (on the vaultsDataRefSlot)
    /// @param _maxLiabilityShares the maxLiabilityShares value of the vault (on the vaultsDataRefSlot)
    /// @param _proof the proof of the reported data
    function updateVaultData(
        address _vault,
        uint256 _totalValue,
        uint256 _cumulativeLidoFees,
        uint256 _liabilityShares,
        uint256 _maxLiabilityShares,
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
                        _maxLiabilityShares,
                        _slashingReserve
                    )
                )
            )
        );assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000019,leaf)}
        if (!MerkleProof.verify(_proof, _storage().vaultsDataTreeRoot, leaf)) revert InvalidProof();

        uint256 vaultsDataTimestamp = _storage().vaultsDataTimestamp;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001a,vaultsDataTimestamp)}
        (uint256 checkedTotalValue, int256 inOutDelta) = _handleSanityChecks(
            _vault,
            _totalValue,
            _storage().vaultsDataRefSlot,
            vaultsDataTimestamp,
            _cumulativeLidoFees,
            _liabilityShares,
            _maxLiabilityShares
        );assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001b,0)}

        _vaultHub().applyVaultReport(
            _vault,
            vaultsDataTimestamp,
            checkedTotalValue,
            inOutDelta,
            _cumulativeLidoFees,
            _liabilityShares,
            _maxLiabilityShares,
            _slashingReserve
        );
    }

    /// @notice removes the quarantine for the vault
    /// @param _vault the address of the vault
    function removeVaultQuarantine(address _vault) external {
        if (msg.sender != LIDO_LOCATOR.vaultHub()) revert NotAuthorized();

        mapping(address => Quarantine) storage quarantines = _storage().vaultQuarantines;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001c,0)}
        if (quarantines[_vault].pendingTotalValueIncrease > 0) {
            emit QuarantineRemoved(_vault);
        }
        delete quarantines[_vault];
    }

    function _vaultInfo(address _vault, VaultHub _vh) internal view returns (VaultInfo memory) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01220000, 1037618708770) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01220001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01221000, _vault) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01221001, _vh) }
        IStakingVault vault = IStakingVault(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001d,0)}
        VaultHub.VaultConnection memory connection = _vh.vaultConnection(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001e,0)}
        VaultHub.VaultRecord memory record = _vh.vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001f,0)}
        return VaultInfo(
            _vault,
            vault.availableBalance() + vault.stagedBalance(),
            record.inOutDelta.currentValue(),
            vault.withdrawalCredentials(),
            record.liabilityShares,
            record.maxLiabilityShares,
            _mintableStETH(_vault, _vh),
            connection.shareLimit,
            connection.reserveRatioBP,
            connection.forcedRebalanceThresholdBP,
            connection.infraFeeBP,
            connection.liquidityFeeBP,
            connection.reservationFeeBP,
            _vh.isPendingDisconnect(_vault)
        );
    }

    /// @notice handle sanity checks for the vault lazy report data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault in refSlot
    /// @param _reportRefSlot the refSlot of the report
    /// @param _reportTimestamp the timestamp of the report
    /// @param _cumulativeLidoFees the cumulative Lido fees accrued on the vault (nominated in ether)
    /// @param _liabilityShares the liabilityShares value of the vault (on the _reportRefSlot)
    /// @param _maxLiabilityShares the maxLiabilityShares value of the vault (on the _reportRefSlot)
    /// @return totalValueWithoutQuarantine the smoothed total value of the vault after sanity checks
    /// @return inOutDeltaOnRefSlot the inOutDelta in the refSlot
    function _handleSanityChecks(
        address _vault,
        uint256 _totalValue,
        uint256 _reportRefSlot,
        uint256 _reportTimestamp,
        uint256 _cumulativeLidoFees,
        uint256 _liabilityShares,
        uint256 _maxLiabilityShares
    ) internal returns (uint256 totalValueWithoutQuarantine, int256 inOutDeltaOnRefSlot) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01230000, 1037618708771) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01230001, 7) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01231000, _vault) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01231001, _totalValue) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01231002, _reportRefSlot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01231003, _reportTimestamp) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01231004, _cumulativeLidoFees) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01231005, _liabilityShares) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01231006, _maxLiabilityShares) }
        VaultHub vaultHub = _vaultHub();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010020,0)}
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(_vault);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010021,0)}
        uint48 previousReportTs = record.report.timestamp;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000022,previousReportTs)}

        // 0. Check if the report is already fresh enough
        if (uint48(_reportTimestamp) <= previousReportTs) {
            revert VaultReportIsFreshEnough();
        }

        // 1. Calculate inOutDelta in the refSlot
        int256 currentInOutDelta = record.inOutDelta.currentValue();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000023,currentInOutDelta)}
        inOutDeltaOnRefSlot = record.inOutDelta.getValueForRefSlot(uint48(_reportRefSlot));assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000034,inOutDeltaOnRefSlot)}

        // 2. Sanity check for total value increase
        totalValueWithoutQuarantine = _processTotalValue(
            _vault, _totalValue, inOutDeltaOnRefSlot, record, _reportTimestamp);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000035,totalValueWithoutQuarantine)}

        // 3. Sanity check for dynamic total value underflow
        if (int256(totalValueWithoutQuarantine) + currentInOutDelta - inOutDeltaOnRefSlot < 0) {
            revert UnderflowInTotalValueCalculation();
        }

        // 4. Sanity check for cumulative Lido fees
        uint256 previousCumulativeLidoFees = record.cumulativeLidoFees;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000024,previousCumulativeLidoFees)}
        if (previousCumulativeLidoFees > _cumulativeLidoFees) {
            revert CumulativeLidoFeesTooLow(_cumulativeLidoFees, previousCumulativeLidoFees);
        }

        uint256 maxLidoFees = (_reportTimestamp - previousReportTs) * uint256(_storage().maxLidoFeeRatePerSecond);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000025,maxLidoFees)}
        if (_cumulativeLidoFees - previousCumulativeLidoFees > maxLidoFees) {
            revert CumulativeLidoFeesTooLarge(_cumulativeLidoFees - previousCumulativeLidoFees, maxLidoFees);
        }

        // 5. _maxLiabilityShares must be greater or equal than _liabilityShares
        // _maxLiabilityShares must be less or equal than the currently tracked on-chain record.maxLiabilityShares
        // (the latter can increase after the ref slot reported)
        if (_maxLiabilityShares < _liabilityShares || _maxLiabilityShares > record.maxLiabilityShares) {
            revert InvalidMaxLiabilityShares();
        }
    }

    /*
        Quarantine State Diagram

        States:
        • NO_QUARANTINE: No active quarantine, all value is immediately available
        • QUARANTINE_ACTIVE: Total value increase is quarantined, waiting for expiration
        • QUARANTINE_EXPIRED: Quarantine period passed, quarantined value can be released

        ┌─────────────────┐                              ┌──────────────────┐
        │  NO_QUARANTINE  │ reported > threshold         │QUARANTINE_ACTIVE │
        │                 ├─────────────────────────────►│                  │
        │  quarantined=0  │                              │  quarantined>0   │
        │  startTime=0    │◄─────────────────────────────┤  startTime>0     │
        │                 |                              │  time<expiration |
        └─────────────────┘ reported ≤ threshold         └───┬──────────────┘
                ▲         (early release)                    │       ▲
                │                                            │       │  increase > quarantined + rewards
                │                          time ≥            │       │  (release old, start new)
                │                          quarantine period │       │
                │                                            ▼       │
                │                                      ┌─────────────┴────────┐
                │ reported ≤ threshold OR              │  QUARANTINE_EXPIRED  │
                │ increase ≤ quarantined + rewards     │                      │
                │                                      │  quarantined>0       │
                │                                      │  startTime>0         │
                └──────────────────────────────────────┤  time>=expiration    │
                                                       └──────────────────────┘

        Legend:
        • threshold = onchainTotalValue * (100% + maxRewardRatio)
        • increase = reportedTotalValue - onchainTotalValue
        • quarantined - total value increase that is currently quarantined
        • rewards - expected EL/CL rewards based on maxRewardRatio
        • time = block.timestamp
        • expiration = quarantine.startTimestamp + quarantinePeriod
    */
    function _processTotalValue(
        address _vault,
        uint256 _reportedTotalValue,
        int256 _inOutDeltaOnRefSlot,
        VaultHub.VaultRecord memory record,
        uint256 _reportTimestamp
    ) internal returns (uint256 totalValueWithoutQuarantine) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01250000, 1037618708773) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01250001, 5) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01251000, _vault) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01251001, _reportedTotalValue) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01251002, _inOutDeltaOnRefSlot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01251003, record) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01251004, _reportTimestamp) }
        if (_reportedTotalValue > MAX_SANE_TOTAL_VALUE) {
            revert TotalValueTooLarge();
        }

        // Calculate base values for quarantine logic -------------------------
        // --------------------------------------------------------------------

        // 0. Read storage values
        Storage storage $ = _storage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010026,0)}
        Quarantine storage quarantine = $.vaultQuarantines[_vault];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010027,0)}
        uint256 quarantinedValue = quarantine.pendingTotalValueIncrease;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000028,quarantinedValue)}
        // 1. Onchain total value on refSlot, it does not include CL difference and EL rewards for the period
        uint256 onchainTotalValueOnRefSlot =
            uint256(int256(uint256(record.report.totalValue)) + _inOutDeltaOnRefSlot - record.report.inOutDelta);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000029,onchainTotalValueOnRefSlot)}
        // 2. Some percentage of funds that haven’t passed through the vault’s balance is allowed for handling EL and CL rewards.
        // NB: allowed amount of rewards is not scaled by time here, because:
        // - if we set a small per-day percentage, honest vaults receiving unexpectedly high MEV would get quarantined;
        // - if we set a large per-day percentage, a vault that hasn’t reported for a long time could bypass quarantine;
        // As a result, we would need to impose very tiny limits for non-quarantine percentage — which would complicate the logic
        // without bringing meaningful improvements.
        uint256 quarantineThreshold =
            onchainTotalValueOnRefSlot * (TOTAL_BASIS_POINTS + $.maxRewardRatioBP) / TOTAL_BASIS_POINTS;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002a,quarantineThreshold)}
        // 3. Determine current quarantine state
        QuarantineState currentState = _determineQuarantineState(quarantine, quarantinedValue, _reportTimestamp);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001002b,0)}


        // Execute logic based on current state and conditions ----------------
        // --------------------------------------------------------------------

        if (currentState == QuarantineState.NO_QUARANTINE) {
            if (_reportedTotalValue <= quarantineThreshold) {
                // Transition: NO_QUARANTINE → NO_QUARANTINE (no change needed)
                return _reportedTotalValue;
            } else {
                // Transition: NO_QUARANTINE → QUARANTINE_ACTIVE (start new quarantine)
                _startNewQuarantine(quarantine, _reportedTotalValue - onchainTotalValueOnRefSlot, _reportTimestamp);
                emit QuarantineActivated(_vault, _reportedTotalValue - onchainTotalValueOnRefSlot);
                return onchainTotalValueOnRefSlot;
            }
        } else if (currentState == QuarantineState.QUARANTINE_ACTIVE) {
            if (_reportedTotalValue <= quarantineThreshold) {
                // Transition: QUARANTINE_ACTIVE → NO_QUARANTINE (release quarantine early)
                delete $.vaultQuarantines[_vault];
                emit QuarantineReleased(_vault, 0);
                return _reportedTotalValue;
            } else {
                // Transition: QUARANTINE_ACTIVE → QUARANTINE_ACTIVE (maintain quarantine)
                uint256 reminder = _reportedTotalValue > (onchainTotalValueOnRefSlot + quarantinedValue)
                    ? _reportedTotalValue - (onchainTotalValueOnRefSlot + quarantinedValue)
                    : 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000042,reminder)}
                quarantine.totalValueRemainder = uint128(reminder);uint128 certora_local67 = quarantine.totalValueRemainder;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000043,certora_local67)}
                emit QuarantineUpdated(reminder);
                return onchainTotalValueOnRefSlot;
            }
        } else { // QuarantineState.QUARANTINE_EXPIRED
            uint256 totalValueIncrease = _reportedTotalValue > onchainTotalValueOnRefSlot
                ? _reportedTotalValue - onchainTotalValueOnRefSlot
                : 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000040,totalValueIncrease)}
            uint256 quarantineThresholdWithRewards = quarantineThreshold + quarantinedValue
                * (TOTAL_BASIS_POINTS + $.maxRewardRatioBP) / TOTAL_BASIS_POINTS;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000041,quarantineThresholdWithRewards)}

            if (_reportedTotalValue <= quarantineThresholdWithRewards) {
                // Transition: QUARANTINE_EXPIRED → NO_QUARANTINE (release and accept all)
                delete $.vaultQuarantines[_vault];
                emit QuarantineReleased(_vault, _reportedTotalValue <= quarantineThreshold ? 0 : totalValueIncrease);
                return _reportedTotalValue;
            } else {
                // Transition: QUARANTINE_EXPIRED → QUARANTINE_ACTIVE (release old, start new)
                emit QuarantineReleased(_vault, quarantinedValue);

                _startNewQuarantine(quarantine, totalValueIncrease - quarantinedValue, _reportTimestamp);
                emit QuarantineActivated(_vault, totalValueIncrease - quarantinedValue);

                return onchainTotalValueOnRefSlot + quarantinedValue;
            }
        }
    }

    function _determineQuarantineState(
        Quarantine storage _quarantine,
        uint256 _quarantinedValue,
        uint256 _vaultsDataTimestamp
    ) internal view returns (QuarantineState) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01260000, 1037618708774) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01260001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01261000, _quarantine.slot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01261001, _quarantinedValue) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01261002, _vaultsDataTimestamp) }
        if (_quarantinedValue == 0) {
            return QuarantineState.NO_QUARANTINE;
        }

        bool isQuarantineExpired = (_vaultsDataTimestamp - _quarantine.startTimestamp) >= _storage().quarantinePeriod;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002c,isQuarantineExpired)}
        return isQuarantineExpired ? QuarantineState.QUARANTINE_EXPIRED : QuarantineState.QUARANTINE_ACTIVE;
    }

    function _startNewQuarantine(
        Quarantine storage _quarantine,
        uint256 _amountToQuarantine,
        uint256 _currentTimestamp
    ) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01240000, 1037618708772) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01240001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01241000, _quarantine.slot) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01241001, _amountToQuarantine) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01241002, _currentTimestamp) }
        _quarantine.pendingTotalValueIncrease = uint128(_amountToQuarantine);uint128 certora_local54 = _quarantine.pendingTotalValueIncrease;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000036,certora_local54)}
        _quarantine.startTimestamp = uint64(_currentTimestamp);uint64 certora_local55 = _quarantine.startTimestamp;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000037,certora_local55)}
        _quarantine.totalValueRemainder = 0;uint128 certora_local56 = _quarantine.totalValueRemainder;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000038,certora_local56)}
    }

    function _updateSanityParams(
        uint256 _quarantinePeriod,
        uint256 _maxRewardRatioBP,
        uint256 _maxLidoFeeRatePerSecond
    ) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01270000, 1037618708775) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01270001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01271000, _quarantinePeriod) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01271001, _maxRewardRatioBP) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01271002, _maxLidoFeeRatePerSecond) }
        if (_quarantinePeriod > MAX_QUARANTINE_PERIOD) {
            revert QuarantinePeriodTooLarge(_quarantinePeriod, MAX_QUARANTINE_PERIOD);
        }
        if (_maxRewardRatioBP > MAX_REWARD_RATIO) {
            revert MaxRewardRatioTooLarge(_maxRewardRatioBP, MAX_REWARD_RATIO);
        }
        if (_maxLidoFeeRatePerSecond > MAX_LIDO_FEE_RATE_PER_SECOND) {
            revert MaxLidoFeeRatePerSecondTooLarge(_maxLidoFeeRatePerSecond, MAX_LIDO_FEE_RATE_PER_SECOND);
        }

        Storage storage $ = _storage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001002d,0)}
        $.quarantinePeriod = uint64(_quarantinePeriod);uint64 certora_local57 = $.quarantinePeriod;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000039,certora_local57)}
        $.maxRewardRatioBP = uint16(_maxRewardRatioBP);uint16 certora_local58 = $.maxRewardRatioBP;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003a,certora_local58)}
        $.maxLidoFeeRatePerSecond = uint64(_maxLidoFeeRatePerSecond);uint64 certora_local59 = $.maxLidoFeeRatePerSecond;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003b,certora_local59)}

        emit SanityParamsUpdated(_quarantinePeriod, _maxRewardRatioBP, _maxLidoFeeRatePerSecond);
    }

    function _mintableStETH(address _vault, VaultHub _vh) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01280000, 1037618708776) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01280001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01281000, _vault) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01281001, _vh) }
        uint256 mintableShares = _vh.totalMintingCapacityShares(_vault, 0 /* zero eth delta */);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002e,mintableShares)}
        return _getPooledEthBySharesRoundUp(mintableShares);
    }

    function _storage() internal pure returns (Storage storage $) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01290000, 1037618708777) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01290001, 0) }
        assembly {
            $.slot := LAZY_ORACLE_STORAGE_LOCATION
        }
    }

    function predepositGuarantee() internal view returns (IPredepositGuarantee) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012a0000, 1037618708778) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012a0001, 0) }
        return IPredepositGuarantee(LIDO_LOCATOR.predepositGuarantee());
    }

    function _vaultHub() internal view returns (VaultHub) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012b0000, 1037618708779) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012b0001, 0) }
        return VaultHub(payable(LIDO_LOCATOR.vaultHub()));
    }

    function _operatorGrid() internal view returns (OperatorGrid) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012c0000, 1037618708780) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012c0001, 0) }
        return OperatorGrid(LIDO_LOCATOR.operatorGrid());
    }

    function _getPooledEthBySharesRoundUp(uint256 _shares) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012d0000, 1037618708781) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012d0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff012d1000, _shares) }
        return ILido(LIDO_LOCATOR.lido()).getPooledEthBySharesRoundUp(_shares);
    }

    event VaultsReportDataUpdated(uint256 indexed timestamp, uint256 indexed refSlot, bytes32 indexed root, string cid);
    event QuarantineActivated(address indexed vault, uint256 delta);
    event QuarantineReleased(address indexed vault, uint256 delta);
    event QuarantineRemoved(address indexed vault);
    event QuarantineUpdated(uint256 totalValueReminder);

    event SanityParamsUpdated(uint256 quarantinePeriod, uint256 maxRewardRatioBP, uint256 maxLidoFeeRatePerSecond);

    error AdminCannotBeZero();
    error NotAuthorized();
    error InvalidProof();
    error UnderflowInTotalValueCalculation();
    error TotalValueTooLarge();
    error VaultReportIsFreshEnough();
    error CumulativeLidoFeesTooLow(uint256 reportingFees, uint256 previousFees);
    error CumulativeLidoFeesTooLarge(uint256 feeIncrease, uint256 maxFeeIncrease);
    error QuarantinePeriodTooLarge(uint256 quarantinePeriod, uint256 maxQuarantinePeriod);
    error MaxRewardRatioTooLarge(uint256 rewardRatio, uint256 maxRewardRatio);
    error MaxLidoFeeRatePerSecondTooLarge(uint256 feeRate, uint256 maxFeeRate);
    error InvalidMaxLiabilityShares();
}
