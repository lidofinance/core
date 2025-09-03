// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Math256} from "contracts/common/lib/Math256.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "./interfaces/IPredepositGuarantee.sol";
import {IPinnedBeaconProxy} from "./interfaces/IPinnedBeaconProxy.sol";

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
    /// @custom:storage-location erc7201:VaultHub
    struct Storage {
        /// @notice vault proxy contract codehashes allowed for connecting
        mapping(bytes32 codehash => bool allowed) codehashes;
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
        /// @notice if true, vault is disconnected and fee is not accrued
        bool pendingDisconnect;
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
        /// @notice if true, vault owner manually paused the beacon chain deposits
        bool isBeaconDepositsManuallyPaused;
        /// 64 bits gap
    }

    struct VaultRecord {
        // ### 1st slot
        /// @notice latest report for the vault
        Report report;
        // ### 2nd slot
        /// @notice amount of ether that is locked from withdrawal on the vault
        /// consists of ether that back minted stETH plus reserve determined by reserve ratio and minimal reserve
        uint128 locked;
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

    // keccak256(abi.encode(uint256(keccak256("VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xb158a1a9015c52036ff69e7937a7bb424e82a8c4cbec5c5309994af06d825300;

    /// @notice role that allows to connect vaults to the hub
    /// @dev 0x479bc4a51d27fbdc8e51b5b1ebd3dcd58bd229090980bff226f8930587e69ce3
    bytes32 public immutable VAULT_MASTER_ROLE = keccak256("vaults.VaultHub.VaultMasterRole");

    /// @notice role that allows to set allowed codehashes
    /// @dev 0x712bc47e8f21e3271b5614025535450b46e67d6db1aeb3b0b1a9b76e7eaa7568
    bytes32 public immutable VAULT_CODEHASH_SET_ROLE = keccak256("vaults.VaultHub.VaultCodehashSetRole");

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
    uint256 internal immutable TOTAL_BASIS_POINTS = 100_00;
    /// @notice length of the validator pubkey in bytes
    uint256 internal immutable PUBLIC_KEY_LENGTH = 48;
    /// @dev max value for fees in basis points - it's about 650%
    uint256 internal immutable MAX_FEE_BP = type(uint16).max;

    /// @notice codehash of the account with no code
    bytes32 private immutable EMPTY_CODEHASH = keccak256("");

    /// @notice minimum amount of ether that is required for the beacon chain deposit
    /// @dev used as a threshold for the beacon chain deposits pause
    uint256 internal immutable MIN_BEACON_DEPOSIT = 1 ether;

    // -----------------------------
    //           IMMUTABLES
    // -----------------------------

    /// @notice limit for a single vault share limit relative to Lido TVL in basis points
    uint256 public immutable MAX_RELATIVE_SHARE_LIMIT_BP;

    ILido public immutable LIDO;
    ILidoLocator public immutable LIDO_LOCATOR;
    IHashConsensus public immutable CONSENSUS_CONTRACT;

    /// @param _locator Lido Locator contract
    /// @param _lido Lido stETH contract
    /// @param _consensusContract Hash consensus contract
    /// @param _maxRelativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(ILidoLocator _locator, ILido _lido, IHashConsensus _consensusContract, uint256 _maxRelativeShareLimitBP) {
        _requireNotZero(_maxRelativeShareLimitBP);
        _requireLessThanBP(_maxRelativeShareLimitBP, TOTAL_BASIS_POINTS);

        MAX_RELATIVE_SHARE_LIMIT_BP = _maxRelativeShareLimitBP;

        LIDO_LOCATOR = _locator;
        LIDO = _lido;
        CONSENSUS_CONTRACT = _consensusContract;

        _disableInitializers();
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

    /// @return true if the vault is connected to the hub
    function isVaultConnected(address _vault) external view returns (bool) {
        return _vaultConnection(_vault).vaultIndex != 0;
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
        return _vaultRecord(_vault).locked;
    }

    /// @return the amount of ether that can be locked in the vault given the current total value
    /// @dev returns 0 if the vault is not connected
    function maxLockableValue(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);
        return _totalValue(record) - _unsettledLidoFeesValue(record);
    }

    /// @return the amount of ether that can be instantly withdrawn from the staking vault
    /// @dev returns 0 if the vault is not connected or disconnect pending
    function withdrawableValue(address _vault) external view returns (uint256) {
        if (_vaultConnection(_vault).pendingDisconnect) return 0;

        return _withdrawableValue(_vault, _vaultRecord(_vault));
    }

    /// @return the amount of Lido fees that currently can be settled.
    ///         Even if vault's balance is sufficient to cover the fees, some amount may be blocked for redemptions,
    ///         or locked ether
    /// @dev returns 0 if the vault is not connected
    function settleableLidoFeesValue(address _vault) external view returns (uint256) {
        VaultRecord storage record = _vaultRecord(_vault);
        return _settleableLidoFeesValue(_vault, record, _unsettledLidoFeesValue(record));
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
    /// @return amount of shares to rebalance or UINT256_MAX if it's impossible to make the vault healthy using rebalance
    /// @dev returns 0 if the vault is not connected
    function rebalanceShortfallShares(address _vault) external view returns (uint256) {
        return _rebalanceShortfallShares(_vaultConnection(_vault), _vaultRecord(_vault));
    }

    /// @notice calculates the ether shortfall required to fully cover all outstanding obligations of a vault including:
    ///         ether for rebalancing to restore vault health or fulfill redemptions plus amount of Lido fees that are
    ///         forced to be settled (>= MIN_BEACON_DEPOSIT)
    /// @param _vault The address of the vault to check
    /// @return shortfall The amount of ether required to cover all uncovered obligations
    /// @dev returns 0 if the vault is not connected
    function obligationsShortfall(address _vault) external view returns (uint256) {
        VaultConnection storage connection = _checkConnection(_vault);
        return _obligationsShortfall(_vault, connection, _vaultRecord(_vault));
    }

    /// @notice returns the obligations of the vault: shares to rebalance to maintain healthiness or fulfill redemptions
    ///         and amount of the outstanding Lido fees
    /// @param _vault vault address
    /// @return sharesToRebalance amount of shares to rebalance
    /// @return unsettledLidoFees amount of Lido fees to be settled
    /// @dev returns 0 if the vault is not connected
    function obligations(address _vault) external view returns (uint256 sharesToRebalance, uint256 unsettledLidoFees) {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        sharesToRebalance = _sharesToRebalance(connection, record);
        unsettledLidoFees = _unsettledLidoFeesValue(record);
    }

    /// @notice amount of bad debt to be internalized to become the protocol loss
    /// @return the number of shares to internalize as bad debt during the oracle report
    /// @dev the value is lagging increases that was done after the current refSlot to the next one
    function badDebtToInternalize() external view returns (uint256) {
        return _storage().badDebtToInternalize.getValueForLastRefSlot(CONSENSUS_CONTRACT);
    }

    /// @notice Set if a vault proxy codehash is allowed to be connected to the hub
    /// @param _codehash vault proxy codehash
    /// @param _allowed true to add, false to remove
    /// @dev msg.sender must have VAULT_CODEHASH_SET_ROLE
    function setAllowedCodehash(bytes32 _codehash, bool _allowed) external onlyRole(VAULT_CODEHASH_SET_ROLE) {
        _requireNotZero(uint256(_codehash));
        if (_codehash == EMPTY_CODEHASH) revert ZeroCodehash();

        _storage().codehashes[_codehash] = _allowed;

        emit AllowedCodehashUpdated(_codehash, _allowed);
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    /// @dev vault should have transferred ownership to the VaultHub contract
    function connectVault(address _vault) external whenResumed {
        _requireNotZero(_vault);

        IStakingVault vault_ = IStakingVault(_vault);
        if (vault_.pendingOwner() != address(this)) revert VaultHubNotPendingOwner(_vault);
        if (IPinnedBeaconProxy(address(vault_)).isOssified()) revert VaultOssified(_vault);
        if (vault_.depositor() != address(_predepositGuarantee())) revert PDGNotDepositor(_vault);

        (
            , // nodeOperatorInTier
            , // tierId
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 infraFeeBP,
            uint256 liquidityFeeBP,
            uint256 reservationFeeBP
        ) = _operatorGrid().vaultInfo(_vault);

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
    /// @dev NB: Mechanism to be triggered when Lido Core TVL <= stVaults TVL.
    function setLiabilitySharesTarget(address _vault, uint256 _liabilitySharesTarget) external onlyRole(REDEMPTION_MASTER_ROLE) {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 liabilityShares_ = record.liabilityShares;
        uint256 redemptionShares = liabilityShares_ > _liabilitySharesTarget ? liabilityShares_ - _liabilitySharesTarget : 0;
        record.redemptionShares = uint128(redemptionShares);

        _updateBeaconChainDepositsPause(_vault, record, connection);

        emit VaultRedemptionSharesUpdated(_vault, record.redemptionShares);
    }

    /// @notice updates fees for the vault
    /// @param _vault vault address
    /// @param _infraFeeBP new infra fee in basis points
    /// @param _liquidityFeeBP new liquidity fee in basis points
    /// @param _reservationFeeBP new reservation fee in basis points
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function updateVaultFees(
        address _vault,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        VaultConnection storage connection = _checkConnection(_vault);
        _updateVaultFees(_vault, connection, _infraFeeBP, _liquidityFeeBP, _reservationFeeBP);
    }

    /// @notice updates the vault's connection parameters
    /// @dev Reverts if the vault is not healthy as of latest report
    /// @param _vault vault address
    /// @param _shareLimit new share limit
    /// @param _reserveRatioBP new reserve ratio
    /// @param _forcedRebalanceThresholdBP new forced rebalance threshold
    /// @param _infraFeeBP new infra fee
    /// @param _liquidityFeeBP new liquidity fee
    /// @param _reservationFeeBP new reservation fee
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

        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 totalValue_ = _totalValue(record);
        uint256 liabilityShares_ = record.liabilityShares;

        if (_isThresholdBreached(totalValue_, liabilityShares_, _reserveRatioBP)) {
            revert VaultMintingCapacityExceeded(_vault, totalValue_, liabilityShares_, _reserveRatioBP);
        }

        connection.shareLimit = uint96(_shareLimit);
        connection.reserveRatioBP = uint16(_reserveRatioBP);
        connection.forcedRebalanceThresholdBP = uint16(_forcedRebalanceThresholdBP);
        _updateVaultFees(_vault, connection, _infraFeeBP, _liquidityFeeBP, _reservationFeeBP);

        emit VaultConnectionUpdated({
            vault: _vault,
            shareLimit: _shareLimit,
            reserveRatioBP: _reserveRatioBP,
            forcedRebalanceThresholdBP: _forcedRebalanceThresholdBP
        });
    }

    /// @notice disconnect a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    /// @dev vault's `liabilityShares` should be zero
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
    /// @param _reportLiabilityShares the liabilityShares of the vault
    /// @param _reportSlashingReserve the slashingReserve of the vault
    /// @dev NB: LazyOracle sanity checks already verify that the fee can only increase
    function applyVaultReport(
        address _vault,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportSlashingReserve
    ) external whenResumed {
        _requireSender(address(_lazyOracle()));

        VaultConnection storage connection = _vaultConnection(_vault);
        _requireConnected(connection, _vault);

        VaultRecord storage record = _vaultRecord(_vault);

        if (connection.pendingDisconnect) {
            if (_reportSlashingReserve == 0 && record.liabilityShares == 0) {
                IStakingVault(_vault).transferOwnership(connection.owner);
                _deleteVault(_vault, connection);

                emit VaultDisconnectCompleted(_vault);
                return;
            } else {
                // we abort the disconnect process as there is a slashing conflict yet to be resolved
                connection.pendingDisconnect = false;
                emit VaultDisconnectAborted(_vault, _reportSlashingReserve);
            }
        }

        _applyVaultReport(
            record,
            connection,
            _reportTimestamp,
            _reportTotalValue,
            _reportInOutDelta,
            _reportCumulativeLidoFees,
            _reportLiabilityShares,
            _reportSlashingReserve
        );

        emit VaultReportApplied({
            vault: _vault,
            reportTimestamp: _reportTimestamp,
            reportTotalValue: _reportTotalValue,
            reportInOutDelta: _reportInOutDelta,
            reportCumulativeLidoFees: _reportCumulativeLidoFees,
            reportLiabilityShares: _reportLiabilityShares,
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
                _maxLockableValue: type(uint256).max,
                _shareLimit: type(uint256).max,
                _overrideOperatorLimits: true
            });

            emit BadDebtSocialized(_badDebtVault, _vaultAcceptor, badDebtSharesToAccept);
        }

        return badDebtSharesToAccept;
    }

    /// @notice Internalize the bad debt to the protocol
    /// @param _badDebtVault address of the vault that has the bad debt
    /// @param _maxSharesToInternalize maximum amount of shares to internalize
    /// @return number of shares that was internalized (limited by actual size of the bad debt)
    /// @dev msg.sender must have BAD_DEBT_MASTER_ROLE
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
                _increment: uint104(badDebtToInternalize_)
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
    function withdraw(address _vault, address _recipient, uint256 _ether) external whenResumed {
        _checkConnectionAndOwner(_vault);

        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        uint256 withdrawable = _withdrawableValue(_vault, record);
        if (_ether > withdrawable) {
            revert AmountExceedsWithdrawableValue(_vault, withdrawable, _ether);
        }

        _withdraw(_vault, record, _recipient, _ether);
    }

    /// @notice Rebalances StakingVault by withdrawing ether to VaultHub
    /// @param _vault vault address
    /// @param _shares amount of shares to rebalance
    /// @dev msg.sender should be vault's owner
    function rebalance(address _vault, uint256 _shares) external whenResumed {
        _requireNotZero(_shares);
        _checkConnectionAndOwner(_vault);

        _rebalance(_vault, _vaultRecord(_vault), _shares);
    }

    /// @notice mint StETH shares backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _amountOfShares amount of stETH shares to mint
    function mintShares(address _vault, address _recipient, uint256 _amountOfShares) external whenResumed {
        _requireNotZero(_recipient);
        _requireNotZero(_amountOfShares);

        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        _requireFreshReport(_vault, record);

        uint256 maxLockableValue_ = _totalValue(record) - _unsettledLidoFeesValue(record);

        _increaseLiability({
            _vault: _vault,
            _record: record,
            _amountOfShares: _amountOfShares,
            _reserveRatioBP: connection.reserveRatioBP,
            _maxLockableValue: maxLockableValue_,
            _shareLimit: connection.shareLimit,
            _overrideOperatorLimits: false
        });

        LIDO.mintExternalShares(_recipient, _amountOfShares);

        emit MintedSharesOnVault(_vault, _amountOfShares, record.locked);
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
        if (connection.isBeaconDepositsManuallyPaused) revert ResumedExpected();

        connection.isBeaconDepositsManuallyPaused = true;
        emit BeaconChainDepositsPausedByOwner(_vault);

        _pauseBeaconChainDepositsIfNotAlready(IStakingVault(_vault));
    }

    /// @notice resumes beacon chain deposits for the vault
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    function resumeBeaconChainDeposits(address _vault) external {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        if (!connection.isBeaconDepositsManuallyPaused) revert PausedExpected();

        VaultRecord storage record = _vaultRecord(_vault);
        if (record.redemptionShares > 0) revert HasRedemptionsCannotDeposit(_vault);
        if (_unsettledLidoFeesValue(record) >= MIN_BEACON_DEPOSIT) revert FeesTooHighCannotDeposit(_vault);
        if (!_isVaultHealthy(connection, record)) revert UnhealthyVaultCannotDeposit(_vault);

        connection.isBeaconDepositsManuallyPaused = false;
        emit BeaconChainDepositsResumedByOwner(_vault);

        _resumeBeaconChainDepositsIfNotAlready(IStakingVault(_vault));
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
    /// @dev in case of partial withdrawals, the report should be fresh
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

            /// @dev NB: Disallow partial withdrawals when the vault has uncovered obligations in order to prevent the
            ///      vault owner from clogging the consensus layer withdrawal queue by front-running and delaying the
            ///      forceful validator exits required for rebalancing the vault. Partial withdrawals only allowed if
            ///      the requested amount of withdrawals is enough to cover the uncovered obligations.
            uint256 shortfall = _obligationsShortfall(_vault, connection, record);
            if (shortfall > 0 && minPartialAmountInGwei * 1e9 < shortfall) {
                revert PartialValidatorWithdrawalNotAllowed();
            }
        }

        _triggerVaultValidatorWithdrawals(_vault, msg.value, _pubkeys, _amountsInGwei, _refundRecipient);
    }

    /// @notice Triggers validator full withdrawals for the vault using EIP-7002 permissionlessly if the vault has
    ///         uncovered obligations
    /// @param _vault address of the vault to exit validators from
    /// @param _pubkeys array of public keys of the validators to exit
    /// @param _refundRecipient address that will receive the refund for transaction costs
    /// @dev    In case the vault has uncovered obligations, trusted actor with the role can force its validators to
    ///         exit the beacon chain. This returns the vault's deposited ETH back to vault's balance and allows to
    ///         rebalance the vault.
    function forceValidatorExit(
        address _vault,
        bytes calldata _pubkeys,
        address _refundRecipient
    ) external payable onlyRole(VALIDATOR_EXIT_ROLE) {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        uint256 shortfall = _obligationsShortfall(_vault, connection, record);
        if (shortfall == 0) revert ForcedValidatorExitNotAllowed();

        uint64[] memory amountsInGwei = new uint64[](0);
        _triggerVaultValidatorWithdrawals(_vault, msg.value, _pubkeys, amountsInGwei, _refundRecipient);

        emit ForcedValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
    }

    /// @notice Permissionless rebalance for vaults with uncovered obligations
    /// @param _vault vault address
    /// @dev rebalance all available amount of ether on the vault to fullfill the vault's obligations: restore vault
    ///      to healthy state and settle outstanding redemptions. Fees are not settled in this case.
    function forceRebalance(address _vault) external {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        uint256 availableBalance = Math256.min(_vault.balance, _totalValue(record));
        if (availableBalance == 0) revert NoFundsForForceRebalance(_vault);

        uint256 sharesToForceRebalance = Math256.min(
            _sharesToRebalance(connection, record),
            _getSharesByPooledEth(availableBalance)
        );

        if (sharesToForceRebalance == 0) revert NoReasonForForceRebalance(_vault);

        _rebalance(_vault, record, sharesToForceRebalance);
    }

    /// @notice Permissionless payout of unsettled Lido fees to treasury
    /// @param _vault vault address
    function settleLidoFees(address _vault) external {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        _requireFreshReport(_vault, record);

        uint256 unsettledLidoFees = _unsettledLidoFeesValue(record);
        if (unsettledLidoFees == 0) revert NoUnsettledLidoFeesToSettle(_vault);

        uint256 valueToSettle = _settleableLidoFeesValue(_vault, record, unsettledLidoFees);
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

        bytes32 codehash = address(_vault).codehash;
        if (!_storage().codehashes[codehash]) revert CodehashNotAllowed(_vault, codehash);

        uint256 vaultBalance = _vault.balance;
        if (vaultBalance < CONNECT_DEPOSIT) revert VaultInsufficientBalance(_vault, vaultBalance, CONNECT_DEPOSIT);

        // Connecting a new vault with totalValue == balance
        VaultRecord memory record = VaultRecord({
            report: Report({
                totalValue: uint104(vaultBalance),
                inOutDelta: int104(int256(vaultBalance)),
                timestamp: uint48(block.timestamp)
            }),
            locked: uint128(CONNECT_DEPOSIT),
            liabilityShares: 0,
            inOutDelta: DoubleRefSlotCache.InitializeInt104DoubleCache(int104(int256(vaultBalance))),
            minimalReserve: uint128(CONNECT_DEPOSIT),
            redemptionShares: 0,
            cumulativeLidoFees: 0,
            settledLidoFees: 0
        });

        connection = VaultConnection({
            owner: IStakingVault(_vault).owner(),
            shareLimit: uint96(_shareLimit),
            vaultIndex: uint96(_storage().vaults.length),
            pendingDisconnect: false,
            reserveRatioBP: uint16(_reserveRatioBP),
            forcedRebalanceThresholdBP: uint16(_forcedRebalanceThresholdBP),
            infraFeeBP: uint16(_infraFeeBP),
            liquidityFeeBP: uint16(_liquidityFeeBP),
            reservationFeeBP: uint16(_reservationFeeBP),
            isBeaconDepositsManuallyPaused: false
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
            uint256 _vaultBalance = _vault.balance;
            if (_vaultBalance < unsettledLidoFees && _forceFullFeesSettlement) {
                revert NoUnsettledLidoFeesShouldBeLeft(_vault, unsettledLidoFees);
            }

            uint256 withdrawable = Math256.min(unsettledLidoFees, _vaultBalance);
            _settleLidoFees(_vault, _record, _connection, withdrawable);
        }

        _record.locked = 0; // unlock the connection deposit to allow fees settlement
        _connection.pendingDisconnect = true;

        _operatorGrid().resetVaultTier(_vault);
    }

    function _applyVaultReport(
        VaultRecord storage _record,
        VaultConnection storage _connection,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportSlashingReserve
    ) internal {
        uint256 minimalReserve = Math256.max(CONNECT_DEPOSIT, _reportSlashingReserve);

        _record.cumulativeLidoFees = uint128(_reportCumulativeLidoFees);
        _record.minimalReserve = uint128(minimalReserve);
        _record.locked = uint128(_locked({
            _liabilityShares: Math256.max(_record.liabilityShares, _reportLiabilityShares), // better way to track liability?
            _minimalReserve: minimalReserve,
            _reserveRatioBP: _connection.reserveRatioBP
        }));
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
        _rebalanceExternalEtherToInternal(valueToRebalance);

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
        uint256 _maxLockableValue,
        uint256 _shareLimit,
        bool _overrideOperatorLimits
    ) internal {
        uint256 sharesAfterMint = _record.liabilityShares + _amountOfShares;
        if (sharesAfterMint > _shareLimit) {
            revert ShareLimitExceeded(_vault, sharesAfterMint, _shareLimit);
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 etherToLock = _locked(sharesAfterMint, _record.minimalReserve, _reserveRatioBP);
        if (etherToLock > _maxLockableValue) {
            revert InsufficientValue(_vault, etherToLock, _maxLockableValue);
        }

        if (etherToLock > _record.locked) {
            _record.locked = uint128(etherToLock);
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

    function _rebalanceShortfallShares(
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
        uint256 sharesByTotalValue = _getSharesByPooledEth(totalValue_);

        // Impossible to rebalance a vault with bad debt
        if (liabilityShares_ >= sharesByTotalValue) {
            return type(uint256).max;
        }

        // Solve the equation for X:
        // LS - liabilityShares, TV - sharesByTotalValue
        // MR - maxMintableRatio, 100 - TOTAL_BASIS_POINTS, RR - reserveRatio
        // X - amount of shares that should be withdrawn (TV - X) and used to repay the debt (LS - X)
        // to reduce the LS/TVS ratio back to MR

        // (LS - X) / (TV - X) = MR / 100
        // (LS - X) * 100 = (TV - X) * MR
        // LS * 100 - X * 100 = TV * MR - X * MR
        // X * MR - X * 100 = TV * MR - LS * 100
        // X * (MR - 100) = TV * MR - LS * 100
        // X = (TV * MR - LS * 100) / (MR - 100)
        // X = (LS * 100 - TV * MR) / (100 - MR)
        // RR = 100 - MR
        // X = (LS * 100 - TV * MR) / RR

        return (liabilityShares_ * TOTAL_BASIS_POINTS - sharesByTotalValue * maxMintableRatio) / reserveRatioBP;
    }

    function _totalValue(VaultRecord storage _record) internal view returns (uint256) {
        Report memory report = _record.report;
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] memory inOutDelta = _record.inOutDelta;
        return uint256(int256(uint256(report.totalValue)) + inOutDelta.currentValue() - report.inOutDelta);
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

    function _obligationsShortfall(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 sharesToCover = _sharesToRebalance(_connection, _record);
        if (sharesToCover == type(uint256).max) return type(uint256).max;

        // no need to cover fees if they are less than the minimum beacon deposit
        uint256 unsettledLidoFees = _unsettledLidoFeesValue(_record);
        uint256 feesToCover = unsettledLidoFees < MIN_BEACON_DEPOSIT ? 0 : unsettledLidoFees;

        uint256 amountToCover = _getPooledEthBySharesRoundUp(sharesToCover) + feesToCover;
        return amountToCover > _vault.balance ? amountToCover - _vault.balance : 0;
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
    }

    function _checkConnectionAndOwner(address _vault) internal view returns (VaultConnection storage connection) {
        connection = _checkConnection(_vault);
        _requireSender(connection.owner);
    }

    function _checkConnection(address _vault) internal view returns (VaultConnection storage) {
        _requireNotZero(_vault);

        VaultConnection storage connection = _vaultConnection(_vault);
        _requireConnected(connection, _vault);
        if (connection.pendingDisconnect) revert VaultIsDisconnecting(_vault);

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

        // automatically pause beacon chain deposits:
        if (
            // if vault has unsettled redemptions
            _record.redemptionShares > 0 ||
            // if vault has unsettled lido fees to avoid indefinitely deferred fees
            _unsettledLidoFeesValue(_record) >= MIN_BEACON_DEPOSIT ||
            // if vault is not healthy, to disallow pushing funds to beacon chain instead of rebalancing
            !_isVaultHealthy(_connection, _record)
        ) {
            _pauseBeaconChainDepositsIfNotAlready(vault_);
        } else if (!_connection.isBeaconDepositsManuallyPaused) {
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

    /// @notice the amount of lido fees that can be settled on the vault based on the available balance
    /// @dev    this amount already accounts locked value
    function _settleableLidoFeesValue(
        address _vault,
        VaultRecord storage _record,
        uint256 _feesToSettle
    ) internal view returns (uint256) {
        uint256 unlocked = _unlocked(_record);
        return Math256.min(Math256.min(unlocked, _vault.balance), _feesToSettle);
    }

    /// @notice the amount of ether that can be instantly withdrawn from the vault based on the available balance,
    ///         locked value, vault redemption shares and unsettled Lido fees accrued on the vault
    function _withdrawableValue(address _vault, VaultRecord storage _record) internal view returns (uint256) {
        uint256 availableBalance = Math256.min(_vault.balance, _totalValue(_record));

        // 1. We can't withdraw funds that can be used to fulfill redemptions
        uint256 redemptionValue = _getPooledEthBySharesRoundUp(_record.redemptionShares);
        if (redemptionValue > availableBalance) return 0;
        availableBalance -= redemptionValue;

        // 2. We must account vaults locked value when calculating the withdrawable amount
        uint256 withdrawable = Math256.min(availableBalance, _unlocked(_record));

        // 3. We can't withdraw funds that are used to settle Lido fees
        uint256 feesValue = _unsettledLidoFeesValue(_record);
        return withdrawable > feesValue ? withdrawable - feesValue : 0;
    }

    function _unlocked(VaultRecord storage _record) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_record);
        uint256 locked_ = _record.locked;
        return totalValue_ > locked_ ? totalValue_ - locked_ : 0;
    }

    function _updateVaultFees(
        address _vault,
        VaultConnection storage _connection,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) internal {
        _requireLessThanBP(_infraFeeBP, MAX_FEE_BP);
        _requireLessThanBP(_liquidityFeeBP, MAX_FEE_BP);
        _requireLessThanBP(_reservationFeeBP, MAX_FEE_BP);

        uint16 preInfraFeeBP = _connection.infraFeeBP;
        uint16 preLiquidityFeeBP = _connection.liquidityFeeBP;
        uint16 preReservationFeeBP = _connection.reservationFeeBP;

        _connection.infraFeeBP = uint16(_infraFeeBP);
        _connection.liquidityFeeBP = uint16(_liquidityFeeBP);
        _connection.reservationFeeBP = uint16(_reservationFeeBP);

        emit VaultFeesUpdated({
            vault: _vault,
            preInfraFeeBP: preInfraFeeBP,
            preLiquidityFeeBP: preLiquidityFeeBP,
            preReservationFeeBP: preReservationFeeBP,
            infraFeeBP: _infraFeeBP,
            liquidityFeeBP: _liquidityFeeBP,
            reservationFeeBP: _reservationFeeBP
        });
    }

    function _unsettledLidoFeesValue(VaultRecord storage _record) internal view returns (uint256) {
        return _record.cumulativeLidoFees - _record.settledLidoFees;
    }

    function _sharesToRebalance(
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        return Math256.max(_rebalanceShortfallShares(_connection, _record), _record.redemptionShares);
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

    function _rebalanceExternalEtherToInternal(uint256 _ether) internal {
        LIDO.rebalanceExternalEtherToInternal{value: _ether}();
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

    function _requireNotZero(uint256 _value) internal pure {
        if (_value == 0) revert ZeroArgument();
    }

    function _requireNotZero(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }

    function _requireSender(address _sender) internal view {
        if (msg.sender != _sender) revert NotAuthorized();
    }

    function _requireLessThanBP(uint256 _valueBP, uint256 _maxValueBP) internal pure {
        if (_valueBP > _maxValueBP) revert InvalidBasisPoints(_valueBP, _maxValueBP);
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

    event AllowedCodehashUpdated(bytes32 indexed codehash, bool allowed);

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
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP
    );
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
        uint256 reportSlashingReserve
    );

    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares, uint256 lockedAmount);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned, uint256 etherWithdrawn);
    event VaultInOutDeltaUpdated(address indexed vault, int256 inOutDelta);
    event ForcedValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);

    /**
     * @notice Emitted when the manager is set
     * @param vault The address of the vault
     * @param newOwner The address of the new owner
     * @param oldOwner The address of the old owner
     */
    event VaultOwnershipTransferred(address indexed vault, address indexed newOwner, address indexed oldOwner);

    event LidoFeesSettled(address indexed vault, uint256 transferred, uint256 cumulativeLidoFees, uint256 settledLidoFees);
    event VaultRedemptionSharesUpdated(address indexed vault, uint256 redemptionShares);

    event BeaconChainDepositsPausedByOwner(address indexed vault);
    event BeaconChainDepositsResumedByOwner(address indexed vault);

    event BadDebtSocialized(address indexed vaultDonor, address indexed vaultAcceptor, uint256 badDebtShares);
    event BadDebtWrittenOffToBeInternalized(address indexed vault, uint256 badDebtShares);

    // -----------------------------
    //           ERRORS
    // -----------------------------

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
    error NotConnectedToHub(address vault);
    error NotAuthorized();
    error ZeroAddress();
    error ZeroArgument();
    error InvalidBasisPoints(uint256 valueBP, uint256 maxValueBP);
    error ShareLimitTooHigh(uint256 shareLimit, uint256 maxShareLimit);
    error InsufficientValue(address vault, uint256 etherToLock, uint256 maxLockableValue);
    error NoLiabilitySharesShouldBeLeft(address vault, uint256 liabilityShares);
    error NoUnsettledLidoFeesShouldBeLeft(address vault, uint256 unsettledLidoFees);
    error CodehashNotAllowed(address vault, bytes32 codehash);
    error VaultOssified(address vault);
    error VaultInsufficientBalance(address vault, uint256 currentBalance, uint256 expectedBalance);
    error VaultReportStale(address vault);
    error PDGNotDepositor(address vault);
    error ZeroCodehash();
    error VaultHubNotPendingOwner(address vault);
    error HasRedemptionsCannotDeposit(address vault);
    error FeesTooHighCannotDeposit(address vault);
    error UnhealthyVaultCannotDeposit(address vault);
    error VaultIsDisconnecting(address vault);
    error PartialValidatorWithdrawalNotAllowed();
    error ForcedValidatorExitNotAllowed();
    error BadDebtSocializationNotAllowed();
}
