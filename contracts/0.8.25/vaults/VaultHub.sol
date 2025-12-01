// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/SafeCast.sol";

import {Math256} from "contracts/common/lib/Math256.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "./interfaces/IPredepositGuarantee.sol";
import {IPinnedBeaconProxy} from "./interfaces/IPinnedBeaconProxy.sol";
import {IVaultFactory} from "./interfaces/IVaultFactory.sol";

import {OperatorGrid} from "./OperatorGrid.sol";
import {LazyOracle} from "./LazyOracle.sol";

import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";
import {RefSlotCache, DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "./lib/RefSlotCache.sol";

/// @notice VaultHub is a contract that manages StakingVaults connected to the Lido protocol
/// It allows to connect and disconnect vaults, mint and burn stETH using vaults as collateral
/// Also, it facilitates the individual per-vault reports from the lazy oracle to the vaults and charges Lido fees
/// @author folkyatina
contract VaultHub is PausableUntilWithRoles {
    using RefSlotCache for RefSlotCache.Uint104WithCache;
    using DoubleRefSlotCache for DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH];

    // -----------------------------
    //           STORAGE STRUCTS
    // -----------------------------
    /// @custom:storage-location erc7201:Lido.Vaults.VaultHub
    struct Storage {
        /// @notice accounting records for each vault
        mapping(address vault => VaultRecord) records;
        /// @notice connection parameters for each vault
        mapping(address vault => VaultConnection) connections;
        /// @notice 1-based array of vaults connected to the hub. index 0 is reserved for not connected vaults
        address[] vaults;
        /// @notice amount of bad debt that was internalized from the vault to become the protocol loss
        RefSlotCache.Uint104WithCache badDebtToInternalize;
    }

    struct VaultConnection {
        // ### 1st slot
        /// @notice address of the vault owner
        address owner;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        // ### 2nd slot
        /// @notice index of the vault in the list of vaults. Indexes are not guaranteed to be stable.
        /// @dev vaultIndex is always greater than 0
        uint96 vaultIndex;
        /// @notice timestamp of the block when disconnection was initiated
        /// equal 0 if vault is disconnected and max(uint48) - for connected ,
        uint48 disconnectInitiatedTs;
        /// @notice share of ether that is locked on the vault as an additional reserve
        /// e.g RR=30% means that for 1stETH minted 1/(1-0.3)=1.428571428571428571 ETH is locked on the vault
        uint16 reserveRatioBP;
        /// @notice if vault's reserve decreases to this threshold, it should be force rebalanced
        uint16 forcedRebalanceThresholdBP;
        /// @notice infra fee in basis points
        uint16 infraFeeBP;
        /// @notice liquidity fee in basis points
        uint16 liquidityFeeBP;
        /// @notice reservation fee in basis points
        uint16 reservationFeeBP;
        /// @notice if true, vault owner intends to pause the beacon chain deposits
        bool beaconChainDepositsPauseIntent;
        /// 24 bits gap
    }

    struct VaultRecord {
        // ### 1st slot
        /// @notice latest report for the vault
        Report report;
        // ### 2nd slot
        /// @notice max number of shares that was minted by the vault in current Oracle period
        /// (used to calculate the locked value on the vault)
        uint96 maxLiabilityShares;
        /// @notice liability shares of the vault
        uint96 liabilityShares;
        // ### 3rd and 4th slots
        /// @notice inOutDelta of the vault (all deposits - all withdrawals)
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] inOutDelta;
        // ### 5th slot
        /// @notice the minimal value that the reserve part of the locked can be
        uint128 minimalReserve;
        /// @notice part of liability shares reserved to be burnt as Lido core redemptions
        uint128 redemptionShares;
        // ### 6th slot
        /// @notice cumulative value for Lido fees that accrued on the vault
        uint128 cumulativeLidoFees;
        /// @notice cumulative value for Lido fees that were settled on the vault
        uint128 settledLidoFees;
    }

    struct Report {
        /// @notice total value of the vault
        uint104 totalValue;
        /// @notice inOutDelta of the report
        int104 inOutDelta;
        /// @notice timestamp (in seconds)
        uint48 timestamp;
    }

    // -----------------------------
    //           CONSTANTS
    // -----------------------------
    // some constants are immutables to save bytecode

    // keccak256(abi.encode(uint256(keccak256("Lido.Vaults.VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x9eb73ffa4c77d08d5d1746cf5a5e50a47018b610ea5d728ea9bd9e399b76e200;

    /// @notice role that allows to disconnect vaults from the hub
    /// @dev 0x479bc4a51d27fbdc8e51b5b1ebd3dcd58bd229090980bff226f8930587e69ce3
    bytes32 public immutable VAULT_MASTER_ROLE = keccak256("vaults.VaultHub.VaultMasterRole");
    /// @notice role that allows to accrue Lido Core redemptions on the vault
    /// @dev 0x44f007e8cc2a08047a03d8d9c295057454942eb49ee3ced9c87e9b9406f21174
    bytes32 public immutable REDEMPTION_MASTER_ROLE = keccak256("vaults.VaultHub.RedemptionMasterRole");
    /// @notice role that allows to trigger validator exits under extreme conditions
    /// @dev 0x2159c5943234d9f3a7225b9a743ea06e4a0d0ba5ed82889e867759a8a9eb7883
    bytes32 public immutable VALIDATOR_EXIT_ROLE = keccak256("vaults.VaultHub.ValidatorExitRole");
    /// @notice role that allows to bail out vaults with bad debt
    /// @dev 0xa85bab4b576ca359fa6ae02ab8744b5c85c7e7ed4d7e0bca7b5b64580ac5d17d
    bytes32 public immutable BAD_DEBT_MASTER_ROLE = keccak256("vaults.VaultHub.BadDebtMasterRole");

    /// @notice amount of ETH that is locked on the vault on connect and can be withdrawn on disconnect only
    uint256 public constant CONNECT_DEPOSIT = 1 ether;
    /// @notice The time delta for report freshness check
    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;

    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    /// @dev special value for `disconnectTimestamp` storage means the vault is not marked for disconnect
    uint48 internal constant DISCONNECT_NOT_INITIATED = type(uint48).max;
    /// @notice minimum amount of ether that is required for the beacon chain deposit
    /// @dev used as a threshold for the beacon chain deposits pause
    uint256 internal constant MIN_BEACON_DEPOSIT = 1 ether;
    /// @dev amount of ether required to activate a validator after PDG
    uint256 internal constant PDG_ACTIVATION_DEPOSIT = 31 ether;

    // -----------------------------
    //           IMMUTABLES
    // -----------------------------

    /// @notice limit for a single vault share limit relative to Lido TVL in basis points
    uint256 public immutable MAX_RELATIVE_SHARE_LIMIT_BP;

    ILido public immutable LIDO;
    ILidoLocator public immutable LIDO_LOCATOR;
    /// @dev it's cached as immutable to save the gas, but it's add some rigidity to the contract structure
    /// and will require update of the VaultHub if HashConsensus changes
    IHashConsensus public immutable CONSENSUS_CONTRACT;

    /// @param _locator Lido Locator contract
    /// @param _lido Lido stETH contract
    /// @param _consensusContract Hash consensus contract
    /// @param _maxRelativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(ILidoLocator _locator, ILido _lido, IHashConsensus _consensusContract, uint256 _maxRelativeShareLimitBP) {
        _requireNotZero(address(_locator));
        _requireNotZero(address(_lido));
        _requireNotZero(address(_consensusContract));

        _requireNotZero(_maxRelativeShareLimitBP);
        if (_maxRelativeShareLimitBP > TOTAL_BASIS_POINTS) revert InvalidBasisPoints(_maxRelativeShareLimitBP, TOTAL_BASIS_POINTS);

        MAX_RELATIVE_SHARE_LIMIT_BP = _maxRelativeShareLimitBP;

        LIDO_LOCATOR = _locator;
        LIDO = _lido;
        CONSENSUS_CONTRACT = _consensusContract;

        _disableInitializers();
        _pauseUntil(PAUSE_INFINITELY);
    }

    /// @dev used to perform rebalance operations
    receive() external payable {}

    /// @notice initialize the vault hub
    /// @param _admin default admin address
    function initialize(address _admin) external initializer {
        _requireNotZero(_admin);

        __AccessControlEnumerable_init();

        // the stone in the elevator. index 0 is reserved for not connected vaults
        _storage().vaults.push(address(0));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice returns the number of vaults connected to the hub
    /// @dev since index 0 is reserved for not connected vaults, it's always 1 less than the vaults array length
    function vaultsCount() external view returns (uint256) {
        return _storage().vaults.length - 1;
    }

    /// @notice returns the vault address by its index
    /// @param _index index of the vault in the 1-based list of vaults. possible range [1, vaultsCount()]
    /// @dev Indexes are guaranteed to be stable only in one transaction.
    function vaultByIndex(uint256 _index) external view returns (address) {
        _requireNotZero(_index);
        return _storage().vaults[_index];
    }

    /// @return connection parameters struct for the given vault
    /// @dev it returns empty struct if the vault is not connected to the hub
    /// @dev it may return connection even if it's pending to be disconnected
    function vaultConnection(address _vault) external view returns (VaultConnection memory) {
        return _vaultConnection(_vault);
    }

    /// @return the accounting record struct for the given vault
    /// @dev it returns empty struct if the vault is not connected to the hub
    function vaultRecord(address _vault) external view returns (VaultRecord memory) {
        return _vaultRecord(_vault);
    }

    /// @return true if the vault is connected to the hub or pending to be disconnected
    function isVaultConnected(address _vault) external view returns (bool) {
        return _vaultConnection(_vault).vaultIndex != 0;
    }

    /// @return true if vault is pending for disconnect, false if vault is connected or disconnected
    /// @dev disconnect can be performed by applying the report for the period when it was initiated
    function isPendingDisconnect(address _vault) external view returns (bool) {
        return _isPendingDisconnect(_vaultConnection(_vault));
    }

    /// @return total value of the vault
    /// @dev returns 0 if the vault is not connected
    function totalValue(address _vault) external view returns (uint256) {
        return _totalValue(_vaultRecord(_vault));
    }

    /// @return liability shares of the vault
    /// @dev returns 0 if the vault is not connected
    function liabilityShares(address _vault) external view returns (uint256) {
        return _vaultRecord(_vault).liabilityShares;
    }

    /// @return locked amount of ether for the vault
    /// @dev returns 0 if the vault is not connected
    function locked(address _vault) external view returns (uint256) {
        return _locked(_vaultConnection(_vault), _vaultRecord(_vault));
    }

    /// @return the amount of ether that can be locked in the vault given the current total value
    /// @dev returns 0 if the vault is not connected
    function maxLockableValue(address _vault) external view returns (uint256) {
        return _maxLockableValue(_vaultRecord(_vault), 0);
    }

    /// @notice Calculates the total number of shares that is possible to mint on the vault
    /// @param _vault The address of the vault
    /// @param _deltaValue The delta value to apply to the total value of the vault (may be negative)
    /// @return the number of shares that can be minted
    /// @dev returns 0 if the vault is not connected
    function totalMintingCapacityShares(address _vault, int256 _deltaValue) external view returns (uint256) {
        return _totalMintingCapacityShares(_vault, _deltaValue);
    }

    /// @return the amount of ether that can be instantly withdrawn from the staking vault
    /// @dev returns 0 if the vault is not connected or disconnect pending
    function withdrawableValue(address _vault) external view returns (uint256) {
        VaultConnection storage connection = _vaultConnection(_vault);
        if (_isPendingDisconnect(connection)) return 0;

        return _withdrawableValue(_vault, connection, _vaultRecord(_vault));
    }

    /// @return latest report for the vault
    /// @dev returns empty struct if the vault is not connected
    function latestReport(address _vault) external view returns (Report memory) {
        return _vaultRecord(_vault).report;
    }

    /// @return true if the report for the vault is fresh, false otherwise
    /// @dev returns false if the vault is not connected
    function isReportFresh(address _vault) external view returns (bool) {
        return _isReportFresh(_vaultRecord(_vault));
    }

    /// @notice checks if the vault is healthy by comparing its total value after applying forced rebalance threshold
    ///         against current liability shares
    /// @param _vault vault address
    /// @return true if vault is healthy, false otherwise
    /// @dev returns true if the vault is not connected
    function isVaultHealthy(address _vault) external view returns (bool) {
        return _isVaultHealthy(_vaultConnection(_vault), _vaultRecord(_vault));
    }

    /// @notice calculate shares amount to make the vault healthy using rebalance
    /// @param _vault vault address
    /// @return shares amount or UINT256_MAX if it's impossible to make the vault healthy using rebalance
    /// @dev returns 0 if the vault is not connected
    function healthShortfallShares(address _vault) external view returns (uint256) {
        return _healthShortfallShares(_vaultConnection(_vault), _vaultRecord(_vault));
    }

    /// @notice calculate ether amount required to cover obligations shortfall of the vault
    /// @param _vault vault address
    /// @return ether amount or UINT256_MAX if it's impossible to cover obligations shortfall
    /// @dev returns 0 if the vault is not connected
    function obligationsShortfallValue(address _vault) external view returns (uint256) {
        VaultConnection storage connection = _vaultConnection(_vault);
        if (connection.vaultIndex == 0) return 0;

        return _obligationsShortfallValue(_vault, connection, _vaultRecord(_vault));
    }

    /// @notice returns the vault's current obligations toward the protocol
    ///
    /// Obligations are amounts the vault must cover, in the following priority:
    /// 1) Maintain healthiness - burn/rebalance liability shares until the health ratio is restored
    /// 2) Cover redemptions - burn/rebalance part of the liability shares marked as `redemptionShares`
    /// 3) Pay Lido fees - settle accrued but unsettled fees
    ///
    /// Effects:
    /// - Withdrawals from the vault are limited by the amount required to cover the obligations
    /// - Beacon chain deposits are auto-paused while the vault is unhealthy, has redemptions to cover, or has
    ///   unsettled fees ≥ `MIN_BEACON_DEPOSIT` (1 ETH)
    ///
    /// How to settle:
    /// - Anyone can:
    ///   - Rebalance shares permissionlessly when there are funds via `forceRebalance` (restores health / covers redemptions)
    ///   - Settle fees permissionlessly when there are funds via `settleLidoFees`
    /// - The owner (or a trusted role) can trigger validator exits / withdrawals to source ETH when needed
    ///
    /// @param _vault vault address
    /// @return sharesToBurn amount of shares to burn / rebalance
    /// @return feesToSettle amount of Lido fees to settle
    /// @dev if the vault has bad debt (i.e. not fixable by rebalance), returns `type(uint256).max` for `sharesToBurn`
    /// @dev returns (0, 0) if the vault is not connected
    function obligations(address _vault) external view returns (uint256 sharesToBurn, uint256 feesToSettle) {
        VaultConnection storage connection = _vaultConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        return (
            _obligationsShares(connection, record),
            _unsettledLidoFeesValue(record)
        );
    }

    /// @return the amount of Lido fees that currently can be settled. Even if vault's balance is sufficient to cover
    ///         the fees, some amount may be blocked for redemptions, or locked ether
    /// @dev returns 0 if the vault is not connected
    function settleableLidoFeesValue(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);
        return _settleableLidoFeesValue(_vault, _vaultConnection(_vault), record, _unsettledLidoFeesValue(record));
    }

    /// @notice amount of bad debt to be internalized to become the protocol loss
    function badDebtToInternalize() external view returns (uint256) {
        return _storage().badDebtToInternalize.value;
    }

    /// @notice amount of bad debt to be internalized to become the protocol loss (that was actual on the last refSlot)
    function badDebtToInternalizeForLastRefSlot() external view returns (uint256) {
        return _storage().badDebtToInternalize.getValueForLastRefSlot(CONSENSUS_CONTRACT);
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    /// @dev vault should have transferred ownership to the VaultHub contract
    function connectVault(address _vault) external whenResumed {
        _requireNotZero(_vault);

        if (!IVaultFactory(LIDO_LOCATOR.vaultFactory()).deployedVaults(_vault)) revert VaultNotFactoryDeployed(_vault);
        IStakingVault vault_ = IStakingVault(_vault);
        _requireSender(vault_.owner());
        if (vault_.pendingOwner() != address(this)) revert VaultHubNotPendingOwner(_vault);
        if (IPinnedBeaconProxy(address(vault_)).isOssified()) revert VaultOssified(_vault);
        if (vault_.depositor() != address(_predepositGuarantee())) revert PDGNotDepositor(_vault);
        // we need vault to match staged balance with pendingActivations
        if (vault_.stagedBalance() != _predepositGuarantee().pendingActivations(vault_) * PDG_ACTIVATION_DEPOSIT) {
            revert InsufficientStagedBalance(_vault);
        }

        (
            , // nodeOperatorInTier
            , // tierId
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 infraFeeBP,
            uint256 liquidityFeeBP,
            uint256 reservationFeeBP
        ) = _operatorGrid().vaultTierInfo(_vault);

        _connectVault(_vault,
            shareLimit,
            reserveRatioBP,
            forcedRebalanceThresholdBP,
            infraFeeBP,
            liquidityFeeBP,
            reservationFeeBP
        );

        IStakingVault(_vault).acceptOwnership();

        emit VaultConnected({
            vault: _vault,
            shareLimit: shareLimit,
            reserveRatioBP: reserveRatioBP,
            forcedRebalanceThresholdBP: forcedRebalanceThresholdBP,
            infraFeeBP: infraFeeBP,
            liquidityFeeBP: liquidityFeeBP,
            reservationFeeBP: reservationFeeBP
        });
    }

    /// @notice updates a redemption shares on the vault
    /// @param _vault The address of the vault
    /// @param _liabilitySharesTarget maximum amount of liabilityShares that will be preserved, the rest will be
    ///         marked as redemptionShares. If value is greater than liabilityShares, redemptionShares are set to 0
    /// @dev NB: Mechanism to be triggered when Lido Core TVL <= stVaults TVL
    function setLiabilitySharesTarget(address _vault, uint256 _liabilitySharesTarget) external onlyRole(REDEMPTION_MASTER_ROLE) {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 liabilityShares_ = record.liabilityShares;
        uint256 redemptionShares = liabilityShares_ > _liabilitySharesTarget ? liabilityShares_ - _liabilitySharesTarget : 0;
        record.redemptionShares = uint128(redemptionShares);

        _updateBeaconChainDepositsPause(_vault, record, connection);

        emit VaultRedemptionSharesUpdated(_vault, record.redemptionShares);
    }

    /// @notice updates the vault's connection parameters
    /// @param _vault vault address
    /// @param _shareLimit new share limit
    /// @param _reserveRatioBP new reserve ratio
    /// @param _forcedRebalanceThresholdBP new forced rebalance threshold
    /// @param _infraFeeBP new infra fee
    /// @param _liquidityFeeBP new liquidity fee
    /// @param _reservationFeeBP new reservation fee
    /// @dev reverts if the vault's minting capacity will be exceeded with new reserve parameters
    /// @dev requires the fresh report
    function updateConnection(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) external {
        _requireSender(address(_operatorGrid()));
        _requireSaneShareLimit(_shareLimit);

        VaultConnection storage connection = _vaultConnection(_vault);
        _requireConnected(connection, _vault);

        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        if (
            _reserveRatioBP != connection.reserveRatioBP ||
            _forcedRebalanceThresholdBP != connection.forcedRebalanceThresholdBP
        ) {
            uint256 totalValue_ = _totalValue(record);
            uint256 liabilityShares_ = record.liabilityShares;

            if (_isThresholdBreached(totalValue_, liabilityShares_, _reserveRatioBP)) {
                revert VaultMintingCapacityExceeded(_vault, totalValue_, liabilityShares_, _reserveRatioBP);
            }
        }

        // special event for the Oracle to track fee calculation
        emit VaultFeesUpdated({
            vault: _vault,
            preInfraFeeBP: connection.infraFeeBP,
            preLiquidityFeeBP: connection.liquidityFeeBP,
            preReservationFeeBP: connection.reservationFeeBP,
            infraFeeBP: _infraFeeBP,
            liquidityFeeBP: _liquidityFeeBP,
            reservationFeeBP: _reservationFeeBP
        });

        connection.shareLimit = uint96(_shareLimit);
        connection.reserveRatioBP = uint16(_reserveRatioBP);
        connection.forcedRebalanceThresholdBP = uint16(_forcedRebalanceThresholdBP);
        connection.infraFeeBP = uint16(_infraFeeBP);
        connection.liquidityFeeBP = uint16(_liquidityFeeBP);
        connection.reservationFeeBP = uint16(_reservationFeeBP);

        emit VaultConnectionUpdated({
            vault: _vault,
            nodeOperator: _nodeOperator(_vault),
            shareLimit: _shareLimit,
            reserveRatioBP: _reserveRatioBP,
            forcedRebalanceThresholdBP: _forcedRebalanceThresholdBP
        });
    }

    /// @notice disconnect a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    /// @dev vault's `liabilityShares` should be zero
    /// @dev requires the fresh report (see _initiateDisconnection)
    function disconnect(address _vault) external onlyRole(VAULT_MASTER_ROLE) {
        _initiateDisconnection(_vault, _checkConnection(_vault), _vaultRecord(_vault), false);

        emit VaultDisconnectInitiated(_vault);
    }

    /// @notice update of the vault data by the lazy oracle report
    /// @param _vault the address of the vault
    /// @param _reportTimestamp the timestamp of the report (last 32 bits of it)
    /// @param _reportTotalValue the total value of the vault
    /// @param _reportInOutDelta the inOutDelta of the vault
    /// @param _reportCumulativeLidoFees the cumulative Lido fees of the vault
    /// @param _reportLiabilityShares the liabilityShares of the vault on refSlot
    /// @param _reportMaxLiabilityShares the maxLiabilityShares of the vault on refSlot
    /// @param _reportSlashingReserve the slashingReserve of the vault
    /// @dev NB: LazyOracle sanity checks already verify that the fee can only increase
    function applyVaultReport(
        address _vault,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportMaxLiabilityShares,
        uint256 _reportSlashingReserve
    ) external whenResumed {
        _requireSender(address(_lazyOracle()));

        VaultConnection storage connection = _vaultConnection(_vault);
        _requireConnected(connection, _vault);

        VaultRecord storage record = _vaultRecord(_vault);

        if (connection.disconnectInitiatedTs <= _reportTimestamp) {
            if (_reportSlashingReserve == 0 && record.liabilityShares == 0) {
                // liabilityShares can increase if badDebt was socialized to this vault
                IStakingVault(_vault).transferOwnership(connection.owner);
                _deleteVault(_vault, connection);

                emit VaultDisconnectCompleted(_vault);
                return;
            } else {
                // we abort the disconnect process as there is a slashing conflict yet to be resolved
                connection.disconnectInitiatedTs = DISCONNECT_NOT_INITIATED;
                emit VaultDisconnectAborted(_vault, _reportSlashingReserve);
            }
        }

        _applyVaultReport(
            record,
            _reportTimestamp,
            _reportTotalValue,
            _reportInOutDelta,
            _reportCumulativeLidoFees,
            _reportLiabilityShares,
            _reportMaxLiabilityShares,
            _reportSlashingReserve
        );

        emit VaultReportApplied({
            vault: _vault,
            reportTimestamp: _reportTimestamp,
            reportTotalValue: _reportTotalValue,
            reportInOutDelta: _reportInOutDelta,
            reportCumulativeLidoFees: _reportCumulativeLidoFees,
            reportLiabilityShares: _reportLiabilityShares,
            reportMaxLiabilityShares: _reportMaxLiabilityShares,
            reportSlashingReserve: _reportSlashingReserve
        });

        _updateBeaconChainDepositsPause(_vault, record, connection);
    }

    /// @notice Transfer the bad debt from the donor vault to the acceptor vault
    /// @param _badDebtVault address of the vault that has the bad debt
    /// @param _vaultAcceptor address of the vault that will accept the bad debt
    /// @param _maxSharesToSocialize maximum amount of shares to socialize
    /// @return number of shares that was socialized
    ///         (it's limited by acceptor vault capacity and bad debt actual size)
    /// @dev msg.sender must have BAD_DEBT_MASTER_ROLE
    /// @dev requires the fresh report for both bad debt and acceptor vaults
    function socializeBadDebt(
        address _badDebtVault,
        address _vaultAcceptor,
        uint256 _maxSharesToSocialize
    ) external onlyRole(BAD_DEBT_MASTER_ROLE) returns (uint256) {
        _requireNotZero(_badDebtVault);
        _requireNotZero(_vaultAcceptor);
        _requireNotZero(_maxSharesToSocialize);
        if (_nodeOperator(_vaultAcceptor) != _nodeOperator(_badDebtVault)) {
            revert BadDebtSocializationNotAllowed();
        }

        VaultConnection storage badDebtConnection = _vaultConnection(_badDebtVault);
        VaultRecord storage badDebtRecord = _vaultRecord(_badDebtVault);
        VaultConnection storage acceptorConnection = _vaultConnection(_vaultAcceptor);
        VaultRecord storage acceptorRecord = _vaultRecord(_vaultAcceptor);

        _requireConnected(badDebtConnection, _badDebtVault);
        _requireConnected(acceptorConnection, _vaultAcceptor);
        _requireFreshReport(_badDebtVault, badDebtRecord);
        _requireFreshReport(_vaultAcceptor, acceptorRecord);

        uint256 badDebtShares = _badDebtShares(badDebtRecord);
        uint256 badDebtToSocialize = Math256.min(badDebtShares, _maxSharesToSocialize);

        uint256 acceptorTotalValueShares = _getSharesByPooledEth(_totalValue(acceptorRecord));
        uint256 acceptorLiabilityShares = acceptorRecord.liabilityShares;

        // it's possible to socialize up to bad debt:
        uint256 acceptorCapacity = acceptorTotalValueShares < acceptorLiabilityShares ? 0
            : acceptorTotalValueShares - acceptorLiabilityShares;

        uint256 badDebtSharesToAccept = Math256.min(badDebtToSocialize, acceptorCapacity);

        if (badDebtSharesToAccept > 0) {
            _decreaseLiability(_badDebtVault, badDebtRecord, badDebtSharesToAccept);
            _increaseLiability({
                _vault: _vaultAcceptor,
                _record: acceptorRecord,
                _amountOfShares: badDebtSharesToAccept,
                _reserveRatioBP: acceptorConnection.reserveRatioBP,
                // don't check any limits
                _lockableValueLimit: type(uint256).max,
                _shareLimit: type(uint256).max,
                _overrideOperatorLimits: true
            });

            _updateBeaconChainDepositsPause(_vaultAcceptor, acceptorRecord, acceptorConnection);

            emit BadDebtSocialized(_badDebtVault, _vaultAcceptor, badDebtSharesToAccept);
        }

        return badDebtSharesToAccept;
    }

    /// @notice Internalize the bad debt to the protocol
    /// @param _badDebtVault address of the vault that has the bad debt
    /// @param _maxSharesToInternalize maximum amount of shares to internalize
    /// @return number of shares that was internalized (limited by actual size of the bad debt)
    /// @dev msg.sender must have BAD_DEBT_MASTER_ROLE
    /// @dev requires the fresh report
    function internalizeBadDebt(
        address _badDebtVault,
        uint256 _maxSharesToInternalize
    ) external onlyRole(BAD_DEBT_MASTER_ROLE) returns (uint256) {
        _requireNotZero(_badDebtVault);
        _requireNotZero(_maxSharesToInternalize);

        VaultConnection storage badDebtConnection = _vaultConnection(_badDebtVault);
        VaultRecord storage badDebtRecord = _vaultRecord(_badDebtVault);
        _requireConnected(badDebtConnection, _badDebtVault);
        _requireFreshReport(_badDebtVault, badDebtRecord);

        uint256 badDebtShares = _badDebtShares(badDebtRecord);
        uint256 badDebtToInternalize_ = Math256.min(badDebtShares, _maxSharesToInternalize);

        if (badDebtToInternalize_ > 0) {
            _decreaseLiability(_badDebtVault, badDebtRecord, badDebtToInternalize_);

            // store internalization in a separate counter that will be settled
            // by the Accounting Oracle during the report
            _storage().badDebtToInternalize = _storage().badDebtToInternalize.withValueIncrease({
                _consensus: CONSENSUS_CONTRACT,
                _increment: SafeCast.toUint104(badDebtToInternalize_)
            });

            emit BadDebtWrittenOffToBeInternalized(_badDebtVault, badDebtToInternalize_);
        }

        return badDebtToInternalize_;
    }

    /// @notice Reset the internalized bad debt to zero
    /// @dev msg.sender must be the accounting contract
    function decreaseInternalizedBadDebt(uint256 _amountOfShares) external {
        _requireSender(LIDO_LOCATOR.accounting());

        // don't cache previous value, we don't need it for sure
        _storage().badDebtToInternalize.value -= uint104(_amountOfShares);
    }

    /// @notice transfer the ownership of the vault to a new owner without disconnecting it from the hub
    /// @param _vault vault address
    /// @param _newOwner new owner address
    /// @dev msg.sender should be vault's owner
    function transferVaultOwnership(address _vault, address _newOwner) external {
        _requireNotZero(_newOwner);
        VaultConnection storage connection = _checkConnection(_vault);
        address oldOwner = connection.owner;

        _requireSender(oldOwner);

        connection.owner = _newOwner;

        emit VaultOwnershipTransferred({
            vault: _vault,
            newOwner: _newOwner,
            oldOwner: oldOwner
        });
    }

    /// @notice disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    /// @dev vault's `liabilityShares` should be zero
    /// @dev requires the fresh report (see _initiateDisconnection)
    function voluntaryDisconnect(address _vault) external whenResumed {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);

        _initiateDisconnection(_vault, connection, _vaultRecord(_vault), true);

        emit VaultDisconnectInitiated(_vault);
    }

    /// @notice funds the vault passing ether as msg.value
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    function fund(address _vault) external payable whenResumed {
        _requireNotZero(_vault);
        VaultConnection storage connection = _vaultConnection(_vault);
        _requireConnected(connection, _vault);
        _requireSender(connection.owner);

        _updateInOutDelta(_vault, _vaultRecord(_vault), int104(int256(msg.value)));

        IStakingVault(_vault).fund{value: msg.value}();
    }

    /// @notice withdraws ether from the vault to the recipient address
    /// @param _vault vault address
    /// @param _recipient recipient address
    /// @param _ether amount of ether to withdraw
    /// @dev msg.sender should be vault's owner
    /// @dev requires the fresh report
    function withdraw(address _vault, address _recipient, uint256 _ether) external whenResumed {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        uint256 withdrawable = _withdrawableValue(_vault, connection, record);
        if (_ether > withdrawable) {
            revert AmountExceedsWithdrawableValue(_vault, withdrawable, _ether);
        }

        _withdraw(_vault, record, _recipient, _ether);
    }

    /// @notice Rebalances StakingVault by withdrawing ether to VaultHub
    /// @param _vault vault address
    /// @param _shares amount of shares to rebalance
    /// @dev msg.sender should be vault's owner
    /// @dev requires the fresh report
    function rebalance(address _vault, uint256 _shares) external whenResumed {
        _requireNotZero(_shares);
        _checkConnectionAndOwner(_vault);

        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        _rebalance(_vault, record, _shares);
    }

    /// @notice mint StETH shares backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _amountOfShares amount of stETH shares to mint
    /// @dev requires the fresh report
    function mintShares(address _vault, address _recipient, uint256 _amountOfShares) external whenResumed {
        _requireNotZero(_recipient);
        _requireNotZero(_amountOfShares);

        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        _requireFreshReport(_vault, record);

        _increaseLiability({
            _vault: _vault,
            _record: record,
            _amountOfShares: _amountOfShares,
            _reserveRatioBP: connection.reserveRatioBP,
            _lockableValueLimit: _maxLockableValue(record, 0),
            _shareLimit: connection.shareLimit,
            _overrideOperatorLimits: false
        });

        LIDO.mintExternalShares(_recipient, _amountOfShares);

        emit MintedSharesOnVault(_vault, _amountOfShares, _locked(connection, record));
    }

    /// @notice burn steth shares from the balance of the VaultHub contract
    /// @param _vault vault address
    /// @param _amountOfShares amount of shares to burn
    /// @dev msg.sender should be vault's owner
    /// @dev this function is designed to be used by the smart contract, for EOA see `transferAndBurnShares`
    function burnShares(address _vault, uint256 _amountOfShares) public whenResumed {
        _requireNotZero(_amountOfShares);
        _checkConnectionAndOwner(_vault);

        VaultRecord storage record = _vaultRecord(_vault);

        _decreaseLiability(_vault, record, _amountOfShares);

        LIDO.burnExternalShares(_amountOfShares);

        _updateBeaconChainDepositsPause(_vault, record, _vaultConnection(_vault));

        emit BurnedSharesOnVault(_vault, _amountOfShares);
    }

    /// @notice separate burn function for EOA vault owners; requires vaultHub to be approved to transfer stETH
    /// @param _vault vault address
    /// @param _amountOfShares amount of shares to transfer and burn
    /// @dev msg.sender should be vault's owner
    function transferAndBurnShares(address _vault, uint256 _amountOfShares) external {
        LIDO.transferSharesFrom(msg.sender, address(this), _amountOfShares);

        burnShares(_vault, _amountOfShares);
    }

    /// @notice pauses beacon chain deposits for the vault
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    function pauseBeaconChainDeposits(address _vault) external {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        if (connection.beaconChainDepositsPauseIntent) revert PauseIntentAlreadySet();

        connection.beaconChainDepositsPauseIntent = true;
        emit BeaconChainDepositsPauseIntentSet(_vault, true);

        _pauseBeaconChainDepositsIfNotAlready(IStakingVault(_vault));
    }

    /// @notice resumes beacon chain deposits for the vault
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    /// @dev requires the fresh report
    /// @dev NB: if the vault has outstanding obligations, this call will clear the manual pause flag but deposits will
    ///         remain paused until the obligations are covered. Once covered, deposits will resume automatically
    function resumeBeaconChainDeposits(address _vault) external {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        if (!connection.beaconChainDepositsPauseIntent) revert PauseIntentAlreadyUnset();

        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        connection.beaconChainDepositsPauseIntent = false;
        emit BeaconChainDepositsPauseIntentSet(_vault, false);

        _updateBeaconChainDepositsPause(_vault, record, connection);
    }

    /// @notice Emits a request event for the node operator to perform validator exit
    /// @param _vault vault address
    /// @param _pubkeys array of public keys of the validators to exit
    /// @dev msg.sender should be vault's owner
    function requestValidatorExit(address _vault, bytes calldata _pubkeys) external {
        _checkConnectionAndOwner(_vault);

        IStakingVault(_vault).requestValidatorExit(_pubkeys);
    }

    /// @notice Triggers validator withdrawals for the vault using EIP-7002
    /// @param _vault vault address
    /// @param _pubkeys array of public keys of the validators to withdraw from
    /// @param _amountsInGwei array of amounts to withdraw from each validator (0 for full withdrawal)
    /// @param _refundRecipient address that will receive the refund for transaction costs
    /// @dev msg.sender should be vault's owner
    /// @dev requires the fresh report (in case of partial withdrawals)
    /// @dev A withdrawal fee must be paid via msg.value.
    ///      `StakingVault.calculateValidatorWithdrawalFee()` can be used to calculate the approximate fee amount but
    ///      it's accurate only for the current block. The fee may change when the tx is included, so it's recommended
    ///      to send some surplus. The exact amount required will be paid and the excess will be refunded to the
    ///      `_refundRecipient` address. The fee required can grow exponentially, so limit msg.value wisely to avoid
    ///      overspending.
    function triggerValidatorWithdrawals(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amountsInGwei,
        address _refundRecipient
    ) external payable {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 minPartialAmountInGwei = type(uint256).max;
        for (uint256 i = 0; i < _amountsInGwei.length; i++) {
            if (_amountsInGwei[i] > 0 && _amountsInGwei[i] < minPartialAmountInGwei) {
                minPartialAmountInGwei = _amountsInGwei[i];
            }
        }

        if (minPartialAmountInGwei < type(uint256).max) {
            _requireFreshReport(_vault, record);

            /// @dev NB: Disallow partial withdrawals when the vault has obligations shortfall in order to prevent the
            ///      vault owner from clogging the consensus layer withdrawal queue by front-running and delaying the
            ///      forceful validator exits required for rebalancing the vault. Partial withdrawals only allowed if
            ///      the requested amount of withdrawals is enough to cover the uncovered obligations.
            uint256 obligationsShortfallAmount = _obligationsShortfallValue(_vault, connection, record);
            if (obligationsShortfallAmount > 0 && minPartialAmountInGwei * 1e9 < obligationsShortfallAmount) {
                revert PartialValidatorWithdrawalNotAllowed();
            }
        }

        _triggerVaultValidatorWithdrawals(_vault, msg.value, _pubkeys, _amountsInGwei, _refundRecipient);
    }

    /// @notice Triggers validator full withdrawals for the vault using EIP-7002 if the vault has obligations shortfall
    /// @param _vault address of the vault to exit validators from
    /// @param _pubkeys array of public keys of the validators to exit
    /// @param _refundRecipient address that will receive the refund for transaction costs
    /// @dev In case the vault has obligations shortfall, trusted actor with the role can force its validators to
    ///      exit the beacon chain. This returns the vault's deposited ETH back to vault's balance and allows to
    ///      rebalance the vault
    /// @dev requires the fresh report
    /// @dev A withdrawal fee must be paid via msg.value.
    ///      `StakingVault.calculateValidatorWithdrawalFee()` can be used to calculate the approximate fee amount but
    ///      it's accurate only for the current block. The fee may change when the tx is included, so it's recommended
    ///      to send some surplus. The exact amount required will be paid and the excess will be refunded to the
    ///      `_refundRecipient` address. The fee required can grow exponentially, so limit msg.value wisely to avoid
    ///      overspending.
    function forceValidatorExit(
        address _vault,
        bytes calldata _pubkeys,
        address _refundRecipient
    ) external payable onlyRole(VALIDATOR_EXIT_ROLE) {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        uint256 obligationsShortfallAmount = _obligationsShortfallValue(_vault, connection, record);
        if (obligationsShortfallAmount == 0) revert ForcedValidatorExitNotAllowed();

        uint64[] memory amountsInGwei = new uint64[](0);
        _triggerVaultValidatorWithdrawals(_vault, msg.value, _pubkeys, amountsInGwei, _refundRecipient);

        emit ForcedValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
    }

    /// @notice allows anyone to rebalance a vault with an obligations shortfall
    /// @param _vault vault address
    /// @dev uses all available ether in the vault to cover outstanding obligations and restore vault health; this
    ///      operation does not settle Lido fees
    /// @dev requires the fresh report
    function forceRebalance(address _vault) external {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        uint256 availableBalance = Math256.min(_availableBalance(_vault), _totalValue(record));
        if (availableBalance == 0) revert NoFundsForForceRebalance(_vault);

        uint256 sharesToForceRebalance = Math256.min(
            _obligationsShares(connection, record),
            _getSharesByPooledEth(availableBalance)
        );

        if (sharesToForceRebalance == 0) revert NoReasonForForceRebalance(_vault);

        _rebalance(_vault, record, sharesToForceRebalance);
    }

    /// @notice allows anyone to settle any outstanding Lido fees for a vault, sending them to the treasury
    /// @param _vault vault address
    /// @dev requires the fresh report
    function settleLidoFees(address _vault) external {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        uint256 unsettledLidoFees = _unsettledLidoFeesValue(record);
        if (unsettledLidoFees == 0) revert NoUnsettledLidoFeesToSettle(_vault);

        uint256 valueToSettle = _settleableLidoFeesValue(_vault, connection, record, unsettledLidoFees);
        if (valueToSettle == 0) revert NoFundsToSettleLidoFees(_vault, unsettledLidoFees);

        _settleLidoFees(_vault, record, connection, valueToSettle);
    }

    /// @notice Proves that validators unknown to PDG have correct WC to participate in the vault
    /// @param _vault vault address
    /// @param _witness ValidatorWitness struct proving validator WC belonging to staking vault
    function proveUnknownValidatorToPDG(
        address _vault,
        IPredepositGuarantee.ValidatorWitness calldata _witness
    ) external {
        _checkConnectionAndOwner(_vault);

        _predepositGuarantee().proveUnknownValidator(_witness, IStakingVault(_vault));
    }

    /// @notice collects ERC20 tokens from vault
    /// @param _vault vault address
    /// @param _token address of the ERC20 token to collect
    /// @param _recipient address to send collected tokens to
    /// @param _amount amount of tokens to collect
    /// @dev will revert with ZeroArgument() if _token, _recipient or _amount is zero
    /// @dev will revert with EthCollectionNotAllowed() if _token is ETH (via EIP-7528 address)
    function collectERC20FromVault(
        address _vault,
        address _token,
        address _recipient,
        uint256 _amount
    ) external {
         _checkConnectionAndOwner(_vault);
         IStakingVault(_vault).collectERC20(_token, _recipient, _amount);
    }

    function _connectVault(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) internal {
        _requireSaneShareLimit(_shareLimit);

        VaultConnection memory connection = _vaultConnection(_vault);
        if (connection.vaultIndex != 0) revert AlreadyConnected(_vault, connection.vaultIndex);

        uint256 vaultBalance = _availableBalance(_vault);
        if (vaultBalance < CONNECT_DEPOSIT) revert VaultInsufficientBalance(_vault, vaultBalance, CONNECT_DEPOSIT);

        IStakingVault vault = IStakingVault(_vault);

        // Connecting a new vault with totalValue == balance
        VaultRecord memory record = VaultRecord({
            report: Report({
                totalValue: uint104(vaultBalance),
                inOutDelta: int104(int256(vaultBalance)),
                timestamp: uint48(block.timestamp)
            }),
            maxLiabilityShares: 0,
            liabilityShares: 0,
            inOutDelta: DoubleRefSlotCache.initializeInt104DoubleCache(int104(int256(vaultBalance))),
            minimalReserve: uint128(CONNECT_DEPOSIT),
            redemptionShares: 0,
            cumulativeLidoFees: 0,
            settledLidoFees: 0
        });

        connection = VaultConnection({
            owner: vault.owner(),
            shareLimit: uint96(_shareLimit),
            vaultIndex: uint96(_storage().vaults.length),
            disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
            reserveRatioBP: uint16(_reserveRatioBP),
            forcedRebalanceThresholdBP: uint16(_forcedRebalanceThresholdBP),
            infraFeeBP: uint16(_infraFeeBP),
            liquidityFeeBP: uint16(_liquidityFeeBP),
            reservationFeeBP: uint16(_reservationFeeBP),
            beaconChainDepositsPauseIntent: vault.beaconChainDepositsPaused()
        });

        _addVault(_vault, connection, record);
    }

    function _initiateDisconnection(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record,
        bool _forceFullFeesSettlement
    ) internal {
        _requireFreshReport(_vault, _record);

        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ > 0) revert NoLiabilitySharesShouldBeLeft(_vault, liabilityShares_);

        uint256 unsettledLidoFees = _unsettledLidoFeesValue(_record);
        if (unsettledLidoFees > 0) {
            uint256 balance = Math256.min(_availableBalance(_vault), _totalValue(_record));
            if (_forceFullFeesSettlement) {
                if (balance < unsettledLidoFees) revert NoUnsettledLidoFeesShouldBeLeft(_vault, unsettledLidoFees);

                _settleLidoFees(_vault, _record, _connection, unsettledLidoFees);
            } else {
                uint256 withdrawable = Math256.min(balance, unsettledLidoFees);
                if (withdrawable > 0) {
                    _settleLidoFees(_vault, _record, _connection, withdrawable);
                }
            }
        }

        _connection.disconnectInitiatedTs = uint48(block.timestamp);
    }

    function _applyVaultReport(
        VaultRecord storage _record,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportMaxLiabilityShares,
        uint256 _reportSlashingReserve
    ) internal {
        _record.cumulativeLidoFees = uint128(_reportCumulativeLidoFees);
        _record.minimalReserve = uint128(Math256.max(CONNECT_DEPOSIT, _reportSlashingReserve));

        // We want to prevent 1 tx looping here:
        // 1. bring ETH (TV+)
        // 2. mint stETH (locked+)
        // 3. burn stETH
        // 4. bring the last report (locked-)
        // 5. withdraw ETH(TV-)

        // current maxLiabilityShares will be greater than the report one
        // if any stETH is minted on funds added after the refslot
        // in that case we don't update it (preventing unlock)
        if (_record.maxLiabilityShares == _reportMaxLiabilityShares) {
            _record.maxLiabilityShares = uint96(Math256.max(_record.liabilityShares, _reportLiabilityShares));
        }
        _record.report = Report({
            totalValue: uint104(_reportTotalValue),
            inOutDelta: int104(_reportInOutDelta),
            timestamp: uint48(_reportTimestamp)
        });
    }

    function _rebalance(address _vault, VaultRecord storage _record, uint256 _shares) internal {
        uint256 valueToRebalance = _getPooledEthBySharesRoundUp(_shares);

        _decreaseLiability(_vault, _record, _shares);
        _withdraw(_vault, _record, address(this), valueToRebalance);
        _rebalanceExternalEtherToInternal(valueToRebalance, _shares);

        _updateBeaconChainDepositsPause(_vault, _record, _vaultConnection(_vault));

        emit VaultRebalanced(_vault, _shares, valueToRebalance);
    }

    function _withdraw(address _vault, VaultRecord storage _record, address _recipient, uint256 _amount) internal {
        uint256 totalValue_ = _totalValue(_record);
        if (_amount > totalValue_) {
            revert AmountExceedsTotalValue(_vault, totalValue_, _amount);
        }

        _updateInOutDelta(_vault, _record, -int104(int256(_amount)));
        _withdrawFromVault(_vault, _recipient, _amount);
    }

    /// @dev Increases liabilityShares of the vault and updates the locked amount
    function _increaseLiability(
        address _vault,
        VaultRecord storage _record,
        uint256 _amountOfShares,
        uint256 _reserveRatioBP,
        uint256 _lockableValueLimit,
        uint256 _shareLimit,
        bool _overrideOperatorLimits
    ) internal {
        uint256 sharesAfterMint = _record.liabilityShares + _amountOfShares;
        if (sharesAfterMint > _shareLimit) {
            revert ShareLimitExceeded(_vault, sharesAfterMint, _shareLimit);
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 etherToLock = _locked(sharesAfterMint, _record.minimalReserve, _reserveRatioBP);
        if (etherToLock > _lockableValueLimit) {
            revert InsufficientValue(_vault, etherToLock, _lockableValueLimit);
        }

        if (sharesAfterMint > _record.maxLiabilityShares) {
            _record.maxLiabilityShares = uint96(sharesAfterMint);
        }

        _record.liabilityShares = uint96(sharesAfterMint);

        _operatorGrid().onMintedShares(_vault, _amountOfShares, _overrideOperatorLimits);
    }

    function _decreaseLiability(address _vault, VaultRecord storage _record, uint256 _amountOfShares) internal {
        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ < _amountOfShares) revert InsufficientSharesToBurn(_vault, liabilityShares_);

        _record.liabilityShares = uint96(liabilityShares_ - _amountOfShares);

        uint256 redemptionShares = _record.redemptionShares;
        if (_amountOfShares > 0 && redemptionShares > 0) {
            uint256 decreasedRedemptionShares = redemptionShares - Math256.min(redemptionShares, _amountOfShares);
            _record.redemptionShares = uint128(decreasedRedemptionShares);

            emit VaultRedemptionSharesUpdated(_vault, decreasedRedemptionShares);
        }

        _operatorGrid().onBurnedShares(_vault, _amountOfShares);
    }

    function _badDebtShares(VaultRecord storage _record) internal view returns (uint256) {
        uint256 liabilityShares_ = _record.liabilityShares;
        uint256 totalValueShares = _getSharesByPooledEth(_totalValue(_record));

        if (totalValueShares > liabilityShares_) {
            return 0;
        }

        return liabilityShares_ - totalValueShares;
    }

    function _healthShortfallShares(
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_record);
        uint256 liabilityShares_ = _record.liabilityShares;

        bool isHealthy = !_isThresholdBreached(
            totalValue_,
            liabilityShares_,
            _connection.forcedRebalanceThresholdBP
        );

        // Health vault do not need to rebalance
        if (isHealthy) {
            return 0;
        }

        uint256 reserveRatioBP = _connection.reserveRatioBP;
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);
        uint256 liability = _getPooledEthBySharesRoundUp(liabilityShares_);

        // Impossible to rebalance a vault with bad debt
        if (liability > totalValue_) {
            return type(uint256).max;
        }

        // if not healthy and low in debt, please rebalance the whole amount
        if (liabilityShares_ <= 100) return liabilityShares_;

        // Solve the equation for X:
        // L - liability, TV - totalValue
        // MR - maxMintableRatio, 100 - TOTAL_BASIS_POINTS, RR - reserveRatio
        // X - amount of ether that should be withdrawn (TV - X) and used to repay the debt (L - X) to reduce the
        // L/TV ratio back to MR

        // (L - X) / (TV - X) = MR / 100
        // (L - X) * 100 = (TV - X) * MR
        // L * 100 - X * 100 = TV * MR - X * MR
        // X * MR - X * 100 = TV * MR - L * 100
        // X * (MR - 100) = TV * MR - L * 100
        // X = (TV * MR - L * 100) / (MR - 100)
        // X = (L * 100 - TV * MR) / (100 - MR)
        // RR = 100 - MR
        // X = (L * 100 - TV * MR) / RR
        uint256 shortfallEth = Math256.ceilDiv(liability * TOTAL_BASIS_POINTS - totalValue_ * maxMintableRatio,
            reserveRatioBP);

        // Add 100 extra shares to avoid dealing with rounding/precision issues
        uint256 shortfallShares = _getSharesByPooledEth(shortfallEth) + 100;

        return Math256.min(shortfallShares, liabilityShares_);
    }

    function _totalValue(VaultRecord storage _record) internal view returns (uint256) {
        Report memory report = _record.report;
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory inOutDelta = _record.inOutDelta;
        return SafeCast.toUint256(int256(uint256(report.totalValue)) + inOutDelta.currentValue() - report.inOutDelta);
    }

    function _locked(
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        return _locked(_record.maxLiabilityShares, _record.minimalReserve, _connection.reserveRatioBP);
    }

    /// @param _liabilityShares amount of shares that the vault is minted
    /// @param _minimalReserve minimal amount of additional reserve to be locked
    /// @param _reserveRatioBP the reserve ratio of the vault
    /// @return the amount of collateral to be locked on the vault
    function _locked(
        uint256 _liabilityShares,
        uint256 _minimalReserve,
        uint256 _reserveRatioBP
    ) internal view returns (uint256) {
        uint256 liability = _getPooledEthBySharesRoundUp(_liabilityShares);

        // uint256 reserve = liability * TOTAL_BASIS_POINTS / (TOTAL_BASIS_POINTS - _reserveRatioBP) - liability;
        // simplified to:
        uint256 reserve = Math256.ceilDiv(liability * _reserveRatioBP, TOTAL_BASIS_POINTS - _reserveRatioBP);

        return liability + Math256.max(reserve, _minimalReserve);
    }

    function _isReportFresh(VaultRecord storage _record) internal view returns (bool) {
        uint256 latestReportTimestamp = _lazyOracle().latestReportTimestamp();
        return
            // check if AccountingOracle brought fresh report
            uint48(latestReportTimestamp) <= _record.report.timestamp &&
            // if Accounting Oracle stop bringing the report, last report is fresh during this time
            block.timestamp - latestReportTimestamp < REPORT_FRESHNESS_DELTA;
    }

    function _isVaultHealthy(
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (bool) {
        return !_isThresholdBreached(
            _totalValue(_record),
            _record.liabilityShares,
            _connection.forcedRebalanceThresholdBP
        );
    }

    /// @dev Returns true if the vault liability breached the given threshold (inverted)
    function _isThresholdBreached(
        uint256 _vaultTotalValue,
        uint256 _vaultLiabilityShares,
        uint256 _thresholdBP
    ) internal view returns (bool) {
        uint256 liability = _getPooledEthBySharesRoundUp(_vaultLiabilityShares);
        return liability > _vaultTotalValue * (TOTAL_BASIS_POINTS - _thresholdBP) / TOTAL_BASIS_POINTS;
    }

    /// @return the total amount of ether needed to fully cover all outstanding obligations of the vault, including:
    ///         - shares to burn required to restore vault healthiness or cover redemptions
    ///         - unsettled Lido fees (if above the minimum beacon deposit)
    function _obligationsAmount(
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 sharesToBurn = _obligationsShares(_connection, _record);
        if (sharesToBurn == type(uint256).max) return type(uint256).max;

        // no need to cover fees if they are less than the minimum beacon deposit
        uint256 unsettledLidoFees = _unsettledLidoFeesValue(_record);
        uint256 feesToSettle = unsettledLidoFees < MIN_BEACON_DEPOSIT ? 0 : unsettledLidoFees;

        return _getPooledEthBySharesRoundUp(sharesToBurn) + feesToSettle;
    }

    /// @return the ether shortfall required to fully cover all outstanding obligations amount of the vault
    function _obligationsShortfallValue(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 obligationsAmount_ = _obligationsAmount(_connection, _record);
        if (obligationsAmount_ == type(uint256).max) return type(uint256).max;

        uint256 balance = _availableBalance(_vault);

        return obligationsAmount_ > balance ? obligationsAmount_ - balance : 0;
    }

    function _addVault(address _vault, VaultConnection memory _connection, VaultRecord memory _record) internal {
        Storage storage $ = _storage();
        $.vaults.push(_vault);

        $.connections[_vault] = _connection;
        $.records[_vault] = _record;
    }

    function _deleteVault(address _vault, VaultConnection storage _connection) internal {
        Storage storage $ = _storage();
        uint96 vaultIndex = _connection.vaultIndex;

        address lastVault = $.vaults[$.vaults.length - 1];
        $.connections[lastVault].vaultIndex = vaultIndex;
        $.vaults[vaultIndex] = lastVault;
        $.vaults.pop();

        delete $.connections[_vault];
        delete $.records[_vault];

        _lazyOracle().removeVaultQuarantine(_vault);
        _operatorGrid().resetVaultTier(_vault);
    }

    function _checkConnectionAndOwner(address _vault) internal view returns (VaultConnection storage connection) {
        connection = _checkConnection(_vault);
        _requireSender(connection.owner);
    }

    function _isPendingDisconnect(VaultConnection storage _connection) internal view returns (bool) {
        uint256 disconnectionTs = _connection.disconnectInitiatedTs;
        return disconnectionTs != 0 // vault is disconnected
            && disconnectionTs != DISCONNECT_NOT_INITIATED; // vault in connected but not pending for disconnect
    }

    function _checkConnection(address _vault) internal view returns (VaultConnection storage) {
        _requireNotZero(_vault);

        VaultConnection storage connection = _vaultConnection(_vault);
        _requireConnected(connection, _vault);
        if (_isPendingDisconnect(connection)) revert VaultIsDisconnecting(_vault);

        return connection;
    }

    /// @dev Caches the inOutDelta of the latest refSlot and updates the value
    function _updateInOutDelta(address _vault, VaultRecord storage _record, int104 _increment) internal {
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory inOutDelta = _record.inOutDelta.withValueIncrease({
            _consensus: CONSENSUS_CONTRACT,
            _increment: _increment
        });
        _record.inOutDelta = inOutDelta;
        emit VaultInOutDeltaUpdated(_vault, inOutDelta.currentValue());
    }

    function _updateBeaconChainDepositsPause(
        address _vault,
        VaultRecord storage _record,
        VaultConnection storage _connection
    ) internal {
        IStakingVault vault_ = IStakingVault(_vault);
        uint256 obligationsAmount_ = _obligationsAmount(_connection, _record);
        if (obligationsAmount_ > 0) {
            _pauseBeaconChainDepositsIfNotAlready(vault_);
        } else if (!_connection.beaconChainDepositsPauseIntent) {
            _resumeBeaconChainDepositsIfNotAlready(vault_);
        }
    }

    function _settleLidoFees(
        address _vault,
        VaultRecord storage _record,
        VaultConnection storage _connection,
        uint256 _valueToSettle
    ) internal {
        uint256 settledLidoFees = _record.settledLidoFees + _valueToSettle;
        _record.settledLidoFees = uint128(settledLidoFees);

        _withdraw(_vault, _record, LIDO_LOCATOR.treasury(), _valueToSettle);
        _updateBeaconChainDepositsPause(_vault, _record, _connection);

        emit LidoFeesSettled({
            vault: _vault,
            transferred: _valueToSettle,
            cumulativeLidoFees: _record.cumulativeLidoFees,
            settledLidoFees: settledLidoFees
        });
    }

    /// @notice the amount of ether that can be withdrawn from the vault based on the available balance,
    ///         locked value, vault redemption shares (does not include Lido fees)
    function _withdrawableValueFeesIncluded(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 availableBalance = Math256.min(_availableBalance(_vault), _totalValue(_record));

        // We can't withdraw funds that can be used to cover redemptions
        uint256 redemptionValue = _getPooledEthBySharesRoundUp(_record.redemptionShares);
        if (redemptionValue > availableBalance) return 0;
        availableBalance -= redemptionValue;

        // We must account vaults locked value when calculating the withdrawable amount
        return Math256.min(availableBalance, _unlocked(_connection, _record));
    }

    /// @notice the amount of lido fees that can be settled on the vault based on the withdrawable value
    function _settleableLidoFeesValue(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record,
        uint256 _feesToSettle
    ) internal view returns (uint256) {
        return Math256.min(_withdrawableValueFeesIncluded(_vault, _connection, _record), _feesToSettle);
    }

    /// @notice the amount of ether that can be instantly withdrawn from the vault based on the available balance,
    ///         locked value, vault redemption shares and unsettled Lido fees accrued on the vault
    function _withdrawableValue(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 withdrawable = _withdrawableValueFeesIncluded(_vault, _connection, _record);
        uint256 feesValue = _unsettledLidoFeesValue(_record);
        return withdrawable > feesValue ? withdrawable - feesValue : 0;
    }

    /// @notice Calculates the max lockable value of the vault
    /// @param _record The record of the vault
    /// @param _deltaValue The delta value to apply to the total value of the vault (may be negative)
    /// @return the max lockable value of the vault
    function _maxLockableValue(VaultRecord storage _record, int256 _deltaValue) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_record);
        uint256 unsettledLidoFees_ = _unsettledLidoFeesValue(_record);
        if (_deltaValue < 0) {
            uint256 absDeltaValue = uint256(-_deltaValue);
            totalValue_ = totalValue_ > absDeltaValue ? totalValue_ - absDeltaValue : 0;
        } else {
            totalValue_ += uint256(_deltaValue);
        }

        return totalValue_ > unsettledLidoFees_ ? totalValue_ - unsettledLidoFees_ : 0;
    }

    /// @notice Calculates the total number of shares that is possible to mint on the vault taking into account
    ///         minimal reserve, reserve ratio and the operator grid share limit
    /// @param _vault The address of the vault
    /// @param _deltaValue The delta value to apply to the total value of the vault (may be negative)
    /// @return the number of shares that can be minted
    /// @dev returns 0 if the vault is not connected
    function _totalMintingCapacityShares(address _vault, int256 _deltaValue) internal view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);
        VaultConnection storage connection = _vaultConnection(_vault);

        uint256 maxLockableValue_ = _maxLockableValue(record, _deltaValue);
        uint256 minimalReserve_ = record.minimalReserve;
        if (maxLockableValue_ <= minimalReserve_) return 0;

        uint256 reserve = Math256.ceilDiv(maxLockableValue_ * connection.reserveRatioBP, TOTAL_BASIS_POINTS);

        uint256 capacityShares = _getSharesByPooledEth(maxLockableValue_ - Math256.max(reserve, minimalReserve_));
        return Math256.min(capacityShares, _operatorGrid().effectiveShareLimit(_vault));
    }

    function _unlocked(
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_record);
        uint256 locked_ = _locked(_connection, _record);
        return totalValue_ > locked_ ? totalValue_ - locked_ : 0;
    }

    function _unsettledLidoFeesValue(VaultRecord storage _record) internal view returns (uint256) {
        return _record.cumulativeLidoFees - _record.settledLidoFees;
    }

    function _obligationsShares(
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        return Math256.max(_healthShortfallShares(_connection, _record), _record.redemptionShares);
    }

    function _storage() internal pure returns (Storage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    function _vaultConnection(address _vault) internal view returns (VaultConnection storage) {
        return _storage().connections[_vault];
    }

    function _vaultRecord(address _vault) internal view returns (VaultRecord storage) {
        return _storage().records[_vault];
    }

    // -----------------------------
    //          EXTERNAL CALLS
    // -----------------------------
    // All external calls that is used more than once is wrapped in internal function to save bytecode

    function _operatorGrid() internal view returns (OperatorGrid) {
        return OperatorGrid(LIDO_LOCATOR.operatorGrid());
    }

    function _lazyOracle() internal view returns (LazyOracle) {
        return LazyOracle(LIDO_LOCATOR.lazyOracle());
    }

    function _predepositGuarantee() internal view returns (IPredepositGuarantee) {
        return IPredepositGuarantee(LIDO_LOCATOR.predepositGuarantee());
    }

    function _getSharesByPooledEth(uint256 _ether) internal view returns (uint256) {
        return LIDO.getSharesByPooledEth(_ether);
    }

    function _getPooledEthBySharesRoundUp(uint256 _shares) internal view returns (uint256) {
        return LIDO.getPooledEthBySharesRoundUp(_shares);
    }

    function _rebalanceExternalEtherToInternal(uint256 _ether, uint256 _amountOfShares) internal {
        LIDO.rebalanceExternalEtherToInternal{value: _ether}(_amountOfShares);
    }

    function _triggerVaultValidatorWithdrawals(
        address _vault,
        uint256 _value,
        bytes calldata _pubkeys,
        uint64[] memory _amountsInGwei,
        address _refundRecipient
    ) internal {
        IStakingVault(_vault).triggerValidatorWithdrawals{value: _value}(_pubkeys, _amountsInGwei, _refundRecipient);
    }

    function _withdrawFromVault(address _vault, address _recipient, uint256 _amount) internal {
        IStakingVault(_vault).withdraw(_recipient, _amount);
    }

    function _nodeOperator(address _vault) internal view returns (address) {
        return IStakingVault(_vault).nodeOperator();
    }

    function _availableBalance(address _vault) internal view returns (uint256) {
        return IStakingVault(_vault).availableBalance();
    }

    function _requireNotZero(uint256 _value) internal pure {
        if (_value == 0) revert ZeroArgument();
    }

    function _requireNotZero(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }

    function _requireSender(address _sender) internal view {
        if (msg.sender != _sender) revert NotAuthorized();
    }

    function _requireSaneShareLimit(uint256 _shareLimit) internal view {
        uint256 maxSaneShareLimit = (LIDO.getTotalShares() * MAX_RELATIVE_SHARE_LIMIT_BP) / TOTAL_BASIS_POINTS;
        if (_shareLimit > maxSaneShareLimit) revert ShareLimitTooHigh(_shareLimit, maxSaneShareLimit);
    }

    function _requireConnected(VaultConnection storage _connection, address _vault) internal view {
        if (_connection.vaultIndex == 0) revert NotConnectedToHub(_vault);
    }

    function _requireFreshReport(address _vault, VaultRecord storage _record) internal view {
        if (!_isReportFresh(_record)) revert VaultReportStale(_vault);
    }

    function _isBeaconChainDepositsPaused(IStakingVault _vault) internal view returns (bool) {
        return _vault.beaconChainDepositsPaused();
    }

    function _pauseBeaconChainDepositsIfNotAlready(IStakingVault _vault) internal {
        if (!_isBeaconChainDepositsPaused(_vault)) {
            _vault.pauseBeaconChainDeposits();
        }
    }

    function _resumeBeaconChainDepositsIfNotAlready(IStakingVault _vault) internal {
        if (_isBeaconChainDepositsPaused(_vault)) {
            _vault.resumeBeaconChainDeposits();
        }
    }

    // -----------------------------
    //           EVENTS
    // -----------------------------

    /// @dev Warning! used by Accounting Oracle to calculate fees
    event VaultConnected(
        address indexed vault,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );

    event VaultConnectionUpdated(
        address indexed vault,
        address indexed nodeOperator,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP
    );

    /// @dev Warning! used by Accounting Oracle to calculate fees
    event VaultFeesUpdated(
        address indexed vault,
        uint256 preInfraFeeBP,
        uint256 preLiquidityFeeBP,
        uint256 preReservationFeeBP,
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );
    event VaultDisconnectInitiated(address indexed vault);
    event VaultDisconnectCompleted(address indexed vault);
    event VaultDisconnectAborted(address indexed vault, uint256 slashingReserve);
    event VaultReportApplied(
        address indexed vault,
        uint256 reportTimestamp,
        uint256 reportTotalValue,
        int256 reportInOutDelta,
        uint256 reportCumulativeLidoFees,
        uint256 reportLiabilityShares,
        uint256 reportMaxLiabilityShares,
        uint256 reportSlashingReserve
    );

    /// @dev Warning! used by Accounting Oracle to calculate fees
    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares, uint256 lockedAmount);
    /// @dev Warning! used by Accounting Oracle to calculate fees
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    /// @dev Warning! used by Accounting Oracle to calculate fees
    event VaultRebalanced(address indexed vault, uint256 sharesBurned, uint256 etherWithdrawn);
    event VaultInOutDeltaUpdated(address indexed vault, int256 inOutDelta);
    event ForcedValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);

    /**
     * @notice Emitted when the vault ownership is changed
     * @param vault The address of the vault
     * @param newOwner The address of the new owner
     * @param oldOwner The address of the old owner
     */
    event VaultOwnershipTransferred(address indexed vault, address indexed newOwner, address indexed oldOwner);

    event LidoFeesSettled(address indexed vault, uint256 transferred, uint256 cumulativeLidoFees, uint256 settledLidoFees);
    event VaultRedemptionSharesUpdated(address indexed vault, uint256 redemptionShares);

    event BeaconChainDepositsPauseIntentSet(address indexed vault, bool pauseIntent);

    /// @dev Warning! used by Accounting Oracle to calculate fees
    event BadDebtSocialized(address indexed vaultDonor, address indexed vaultAcceptor, uint256 badDebtShares);
    /// @dev Warning! used by Accounting Oracle to calculate fees
    event BadDebtWrittenOffToBeInternalized(address indexed vault, uint256 badDebtShares);

    // -----------------------------
    //           ERRORS
    // -----------------------------

    error PauseIntentAlreadySet();
    error PauseIntentAlreadyUnset();

    error AmountExceedsTotalValue(address vault, uint256 totalValue, uint256 withdrawAmount);
    error AmountExceedsWithdrawableValue(address vault, uint256 withdrawable, uint256 requested);

    error NoFundsForForceRebalance(address vault);
    error NoReasonForForceRebalance(address vault);

    error NoUnsettledLidoFeesToSettle(address vault);
    error NoFundsToSettleLidoFees(address vault, uint256 unsettledLidoFees);

    error VaultMintingCapacityExceeded(
        address vault,
        uint256 totalValue,
        uint256 liabilityShares,
        uint256 newRebalanceThresholdBP
    );
    error InsufficientSharesToBurn(address vault, uint256 amount);
    error ShareLimitExceeded(address vault, uint256 expectedSharesAfterMint, uint256 shareLimit);
    error AlreadyConnected(address vault, uint256 index);
    error InsufficientStagedBalance(address vault);
    error NotConnectedToHub(address vault);
    error NotAuthorized();
    error ZeroAddress();
    error ZeroArgument();
    error InvalidBasisPoints(uint256 valueBP, uint256 maxValueBP);
    error ShareLimitTooHigh(uint256 shareLimit, uint256 maxShareLimit);
    error InsufficientValue(address vault, uint256 etherToLock, uint256 maxLockableValue);
    error NoLiabilitySharesShouldBeLeft(address vault, uint256 liabilityShares);
    error NoUnsettledLidoFeesShouldBeLeft(address vault, uint256 unsettledLidoFees);
    error VaultOssified(address vault);
    error VaultInsufficientBalance(address vault, uint256 currentBalance, uint256 expectedBalance);
    error VaultReportStale(address vault);
    error PDGNotDepositor(address vault);
    error VaultHubNotPendingOwner(address vault);
    error VaultIsDisconnecting(address vault);
    error PartialValidatorWithdrawalNotAllowed();
    error ForcedValidatorExitNotAllowed();
    error BadDebtSocializationNotAllowed();
    error VaultNotFactoryDeployed(address vault);
}
