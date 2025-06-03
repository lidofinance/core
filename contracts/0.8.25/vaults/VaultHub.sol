// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Math256} from "contracts/common/lib/Math256.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {ILido} from "../interfaces/ILido.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "./interfaces/IPredepositGuarantee.sol";
import {LazyOracle} from "./LazyOracle.sol";
import {OperatorGrid} from "./OperatorGrid.sol";

import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";

/// @notice VaultHub is a contract that manages StakingVaults connected to the Lido protocol
/// It allows to connect and disconnect vaults, mint and burn stETH using vaults as collateral
/// Also, it facilitates the individual per-vault reports from the lazy oracle to the vaults and charges Lido fees
/// @author folkyatina
contract VaultHub is PausableUntilWithRoles {

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
        /// @notice obligation values for each vault
        mapping(address vault => VaultObligations) obligations;
        /// @notice 1-based array of vaults connected to the hub. index 0 is reserved for not connected vaults
        address[] vaults;
        /// @notice amount of bad debt that was internalized from the vault to become the protocol loss
        uint256 badDebtToInternalize;
    }

    struct VaultConnection {
        // ### 1st slot
        /// @notice address of the vault owner
        address owner;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        // ### 2th slot
        /// @notice index of the vault in the list of vaults. Indexes is guaranteed to be stable only if there was no deletions.
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
        bool manuallyPausedBeaconChainDeposits;
    }

    struct VaultRecord {
        // ### 1st slot
        /// @notice latest report for the vault
        Report report;
        // ### 2nd slot
        /// @notice amount of ether that is locked from withdrawal on the vault
        uint128 locked;
        /// @notice liability shares of the vault
        uint96 liabilityShares;
        // ### 3rd slot
        /// @notice timestamp of the latest report
        uint64 reportTimestamp;
        /// @notice current inOutDelta of the vault (all deposits - all withdrawals)
        int128 inOutDelta;
        // 64 bits of gap
        // ### 4th slot
    }

    struct Report {
        /// @notice total value of the vault
        uint128 totalValue;
        /// @notice inOutDelta of the report
        int128 inOutDelta;
    }

    struct VaultObligations {
        /// @notice accumulated value for treasury fees that were settled on the vault
        uint128 totalSettledTreasuryFees;
        /// @notice unsettled treasury fees amount
        uint64 treasuryFees;
        /// @notice unsettled redemptions amount
        uint64 redemptions;
    }

    // -----------------------------
    //           CONSTANTS
    // -----------------------------

    // keccak256(abi.encode(uint256(keccak256("VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xb158a1a9015c52036ff69e7937a7bb424e82a8c4cbec5c5309994af06d825300;

    /// @notice role that allows to connect vaults to the hub
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("vaults.VaultHub.VaultMasterRole");
    /// @notice role that allows to set allowed codehashes
    bytes32 public constant VAULT_CODEHASH_SET_ROLE = keccak256("vaults.VaultHub.VaultCodehashSetRole");
    /// @notice role that allows to accrue Lido Core redemptions on the vault
    bytes32 public constant REDEMPTION_MASTER_ROLE = keccak256("vaults.VaultHub.RedemptionMasterRole");
    /// @notice role that allows to trigger validator exits under extreme conditions
    bytes32 public constant VALIDATOR_EXIT_ROLE = keccak256("vaults.VaultHub.ValidatorExitRole");
    /// @notice role that allows to bail out vaults with bad debt
    bytes32 public constant SOCIALIZE_BAD_DEBT_ROLE = keccak256("vaults.VaultHub.SocializeBadDebtRole");
    /// @notice amount of ETH that is locked on the vault on connect and can be withdrawn on disconnect only
    uint256 public constant CONNECT_DEPOSIT = 1 ether;
    /// @notice amount of the unsettled obligations that will pause the beacon chain deposits
    uint256 public constant OBLIGATIONS_THRESHOLD = 1 ether;
    /// @notice The time delta for report freshness check
    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;

    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    /// @notice length of the validator pubkey in bytes
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    /// @notice codehash of the account with no code
    bytes32 private constant EMPTY_CODEHASH = keccak256("");

    /// @notice max allowed unsettled obligations
    uint256 internal constant MAX_UINT256 = type(uint256).max;

    // -----------------------------
    //           IMMUTABLES
    // -----------------------------

    /// @notice limit for a single vault share limit relative to Lido TVL in basis points
    uint256 public immutable MAX_RELATIVE_SHARE_LIMIT_BP;

    ILido public immutable LIDO;
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @param _locator Lido Locator contract
    /// @param _lido Lido stETH contract
    /// @param _maxRelativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(ILidoLocator _locator, ILido _lido, uint256 _maxRelativeShareLimitBP) {
        _requireNotZero(_maxRelativeShareLimitBP);
        _requireLessThanBP(_maxRelativeShareLimitBP, TOTAL_BASIS_POINTS);

        MAX_RELATIVE_SHARE_LIMIT_BP = _maxRelativeShareLimitBP;

        LIDO_LOCATOR = _locator;
        LIDO = _lido;

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
    /// @dev Indexes is guaranteed to be stable only in one transaction.
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

    /// @notice obligations for the vault
    /// @return obligations obligations for the vault
    function vaultObligations(address _vault) external view returns (VaultObligations memory) {
        return _vaultObligations(_vault);
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

    /// @return amount of ether that is available for the vault to withdraw
    /// @dev returns 0 if the vault is not connected
    function availableBalance(address _vault) external view returns (uint256) {
        return _availableBalance(_vault);
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

    /// @return amount of ether that is part of the vault's total value and is not locked as a collateral
    /// @dev returns 0 if the vault is not connected
    function unlocked(address _vault) external view returns (uint256) {
        return _unlocked(_vaultRecord(_vault));
    }

    /// @return latest report for the vault
    /// @dev returns empty struct if the vault is not connected
    function latestReport(address _vault) external view returns (Report memory) {
        return _vaultRecord(_vault).report;
    }

    /// @return latest report timestamp for the vault
    /// @dev returns 0 if the vault is not connected
    function latestVaultReportTimestamp(address _vault) external view returns (uint64) {
        return _storage().records[_vault].reportTimestamp;
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

    /// @notice calculate ether amount to make the vault healthy using rebalance
    /// @param _vault vault address
    /// @return amount to rebalance or UINT256_MAX if it's impossible to make the vault healthy using rebalance
    /// @dev returns 0 if the vault is not connected
    function rebalanceShortfall(address _vault) external view returns (uint256) {
        return _rebalanceShortfall(_vaultConnection(_vault), _vaultRecord(_vault));
    }

    /// @notice amount of bad debt to be internalized to become the protocol loss
    function badDebtToInternalize() external view returns (uint256) {
        return _storage().badDebtToInternalize;
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
        if (vault_.isOssified()) revert VaultOssified(_vault);
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

    /// @notice updates share limit for the vault
    /// Setting share limit to zero actually pause the vault's ability to mint
    /// @param _vault vault address
    /// @param _shareLimit new share limit
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function updateShareLimit(address _vault, uint256 _shareLimit) external onlyRole(VAULT_MASTER_ROLE) {
        _requireNotZero(_vault);
        _requireSaneShareLimit(_shareLimit);

        VaultConnection storage connection = _checkConnection(_vault);
        connection.shareLimit = uint96(_shareLimit);

        emit VaultShareLimitUpdated(_vault, _shareLimit);
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
        _requireNotZero(_vault);
        _requireLessThanBP(_infraFeeBP, TOTAL_BASIS_POINTS);
        _requireLessThanBP(_liquidityFeeBP, TOTAL_BASIS_POINTS);
        _requireLessThanBP(_reservationFeeBP, TOTAL_BASIS_POINTS);

        VaultConnection storage connection = _checkConnection(_vault);
        connection.infraFeeBP = uint16(_infraFeeBP);
        connection.liquidityFeeBP = uint16(_liquidityFeeBP);
        connection.reservationFeeBP = uint16(_reservationFeeBP);

        emit VaultFeesUpdated(_vault, _infraFeeBP, _liquidityFeeBP, _reservationFeeBP);
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
        connection.infraFeeBP = uint16(_infraFeeBP);
        connection.liquidityFeeBP = uint16(_liquidityFeeBP);
        connection.reservationFeeBP = uint16(_reservationFeeBP);

        emit VaultConnectionUpdated({
            vault: _vault,
            shareLimit: _shareLimit,
            reserveRatioBP: _reserveRatioBP,
            forcedRebalanceThresholdBP: _forcedRebalanceThresholdBP,
            infraFeeBP: _infraFeeBP,
            liquidityFeeBP: _liquidityFeeBP,
            reservationFeeBP: _reservationFeeBP
        });
    }

    /// @notice disconnect a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    /// @dev vault's `liabilityShares` should be zero
    function disconnect(address _vault) external onlyRole(VAULT_MASTER_ROLE) {
        _initiateDisconnection(_vault, _checkConnection(_vault), _vaultRecord(_vault));

        emit VaultDisconnectInitiated(_vault);
    }

    /// @notice update of the vault data by the lazy oracle report
    /// @param _vault the address of the vault
    /// @param _reportTimestamp the timestamp of the report
    /// @param _reportTotalValue the total value of the vault
    /// @param _reportInOutDelta the inOutDelta of the vault
    /// @param _reportAccumulatedTreasuryFees the accumulated treasury fees of the vault
    /// @param _reportLiabilityShares the liabilityShares of the vault
    function applyVaultReport(
        address _vault,
        uint64 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportAccumulatedTreasuryFees,
        uint256 _reportLiabilityShares,
        uint256 _reportSlashingReserve
    ) external whenResumed {
        _requireSender(address(_lazyOracle()));

        VaultConnection storage connection = _vaultConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        VaultObligations storage obligations = _vaultObligations(_vault);
        uint256 accumulatedTreasuryFees = obligations.totalSettledTreasuryFees + obligations.treasuryFees;
        if (_reportAccumulatedTreasuryFees < accumulatedTreasuryFees) {
            revert InvalidFees(_vault, _reportAccumulatedTreasuryFees, accumulatedTreasuryFees);
        }

        // only the new fees are accrued, and not counted before
        uint256 accruedTreasuryFees = _reportAccumulatedTreasuryFees - accumulatedTreasuryFees;

        // here we don't check the reported values but rely on the oracle to preserve vault indexes
        if (connection.pendingDisconnect) {
            if (_reportSlashingReserve == 0) {
                _completeDisconnection(_vault, connection, record, accruedTreasuryFees);
                return;
            } else {
                // we revert the disconnect as there is a slashing conflict yet to be resolved
                connection.pendingDisconnect = false;
                emit VaultDisconnectAborted(_vault, _reportSlashingReserve);
            }
        }
        uint256 liabilityShares_ = Math256.max(record.liabilityShares, _reportLiabilityShares);
        // locked ether can only be increased asynchronously once the oracle settled the new floor value
        // as of reference slot to prevent slashing upsides in between the report gathering and delivering
        uint256 lockedEther = Math256.max(
            _getPooledEthBySharesRoundUp(liabilityShares_) * TOTAL_BASIS_POINTS
                / (TOTAL_BASIS_POINTS - connection.reserveRatioBP),
            Math256.max(CONNECT_DEPOSIT, _reportSlashingReserve)
        );

        record.locked = uint128(lockedEther);
        record.reportTimestamp = _reportTimestamp;
        record.report = Report({
            totalValue: uint128(_reportTotalValue),
            inOutDelta: int128(_reportInOutDelta)
        });

        _settleObligations(_vault, record, accruedTreasuryFees, MAX_UINT256);

        IStakingVault vault_ = IStakingVault(_vault);
        if (!_isVaultHealthy(connection, record) && !vault_.beaconChainDepositsPaused()) {
            vault_.pauseBeaconChainDeposits();
        }

        emit VaultReportApplied({
            vault: _vault,
            reportTimestamp: _reportTimestamp,
            reportTotalValue: _reportTotalValue,
            reportInOutDelta: _reportInOutDelta,
            reportAccumulatedTreasuryFees: _reportAccumulatedTreasuryFees,
            reportLiabilityShares: _reportLiabilityShares,
            reportSlashingReserve: _reportSlashingReserve
        });
    }

    /// @notice Transfer the bad debt from the donor vault to the acceptor vault
    /// @param _vault address of the vault that has the bad debt
    /// @param _vaultAcceptor address of the vault that will accept the bad debt or 0 if the bad debt is socialized to the protocol
    /// @param _maxSharesToSocialize maximum amount of shares to socialize
    /// @dev msg.sender must have SOCIALIZE_BAD_DEBT_ROLE
    function socializeBadDebt(
        address _vault,
        address _vaultAcceptor,
        uint256 _maxSharesToSocialize
    ) external onlyRole(SOCIALIZE_BAD_DEBT_ROLE) {
        _requireNotZero(_vault);
        _requireNotZero(_maxSharesToSocialize);

        VaultConnection storage connection = _vaultConnection(_vault);
        _requireConnected(connection, _vault); // require connected but may be pending

        VaultRecord storage record = _vaultRecord(_vault);
        uint256 liabilityShares_ = record.liabilityShares;
        uint256 totalValueShares = _getSharesByPooledEth(_totalValue(record));
        if (totalValueShares > liabilityShares_) {
            revert NoBadDebtToSocialize(_vault, totalValueShares, liabilityShares_);
        }

        uint256 badDebtToSocialize = Math256.min(liabilityShares_ - totalValueShares, _maxSharesToSocialize);

        _decreaseLiability(_vault, record, badDebtToSocialize);

        if (_vaultAcceptor == address(0)) {
            // internalize the bad debt to the protocol
            _storage().badDebtToInternalize += badDebtToSocialize;

            // disconnect the vault from the hub ?? or ban it ?? or change the owner ??
        } else {
            if (_nodeOperator(_vaultAcceptor) != _nodeOperator(_vault)) revert BadDebtSocializationNotAllowed();

            VaultConnection storage connectionAcceptor = _vaultConnection(_vaultAcceptor);
            _requireConnected(connectionAcceptor, _vaultAcceptor);

            VaultRecord storage recordAcceptor = _vaultRecord(_vaultAcceptor);
            _increaseLiability(
                _vaultAcceptor,
                recordAcceptor,
                badDebtToSocialize,
                connectionAcceptor.reserveRatioBP,
                TOTAL_BASIS_POINTS, // maxMintableRatio up to 100% of total value
                _getSharesByPooledEth(recordAcceptor.locked) // we can occupy all the locked amount
            );
        }

        emit BadDebtSocialized(_vault, _vaultAcceptor, badDebtToSocialize);
    }

    /// @notice Reset the internalized bad debt to zero
    /// @dev msg.sender must be the accounting contract
    function decreaseInternalizedBadDebt(uint256 _amountOfShares) external {
        _requireSender(LIDO_LOCATOR.accounting());

        _storage().badDebtToInternalize -= _amountOfShares;
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

        _initiateDisconnection(_vault, connection, _vaultRecord(_vault));

        emit VaultDisconnectInitiated(_vault);
    }

    /// @notice funds the vault passing ether as msg.value
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    function fund(address _vault) external payable whenResumed {
        _checkConnectionAndOwner(_vault);

        VaultRecord storage record = _vaultRecord(_vault);

        int128 inOutDelta_ = record.inOutDelta + int128(int256(msg.value));
        record.inOutDelta = inOutDelta_;

        emit VaultInOutDeltaUpdated(_vault, inOutDelta_);

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
        if (!_isReportFresh(record)) revert VaultReportStale(_vault);

        uint256 unlocked_ = _unlocked(record);
        if (_ether > unlocked_) revert InsufficientUnlocked(unlocked_, _ether);

        _checkAvailableBalance(_vault, _ether);
        _withdraw(_vault, record, _recipient, _ether);

        if (_totalValue(record) < record.locked) revert TotalValueBelowLockedAmount();
    }

    /// @notice Rebalances StakingVault by withdrawing ether to VaultHub
    /// @param _vault vault address
    /// @param _ether amount of ether to rebalance
    /// @dev msg.sender should be vault's owner
    function rebalance(address _vault, uint256 _ether) external whenResumed {
        _requireNotZero(_ether);
        if (_ether > _vault.balance) revert InsufficientBalance(_vault.balance, _ether);
        _checkConnectionAndOwner(_vault);

        _rebalance(_vault, _vaultRecord(_vault), _ether);
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

        if (!_isReportFresh(record)) revert VaultReportStale(_vault);

        uint256 reserveRatioBP = connection.reserveRatioBP;
        _increaseLiability(
            _vault,
            record,
            _amountOfShares,
            reserveRatioBP,
            TOTAL_BASIS_POINTS - reserveRatioBP,
            connection.shareLimit
        );

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

        emit BurnedSharesOnVault(_vault, _amountOfShares);
    }

    /// @notice separate burn function for EOA vault owners; requires vaultHub to be approved to transfer stETH
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

        connection.manuallyPausedBeaconChainDeposits = true;
        IStakingVault(_vault).pauseBeaconChainDeposits();
    }

    /// @notice resumes beacon chain deposits for the vault
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    function resumeBeaconChainDeposits(address _vault) external {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);

        VaultRecord storage record = _vaultRecord(_vault);
        if (!_isVaultHealthy(connection, record)) revert UnhealthyVaultCannotDeposit(_vault);

        // try to settle using existing unsettled fees, and don't revert if unsettled under the threshold
        _settleObligationsIfNeeded(_vault, record, OBLIGATIONS_THRESHOLD);

        connection.manuallyPausedBeaconChainDeposits = false;
        IStakingVault(_vault).resumeBeaconChainDeposits();
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
    /// @param _pubkeys array of public keys of the validators to exit
    /// @dev msg.sender should be vault's owner
    /// @dev partial withdrawals are not allowed when the vault is unhealthy
    function triggerValidatorWithdrawals(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        // disallow partial validator withdrawals when the vault is unhealthy,
        // in order to prevent the vault owner from clogging the consensus layer withdrawal queue
        // front-running and delaying the forceful validator exits required for rebalancing the vault
        if (!_isVaultHealthy(connection, record)) {
            for (uint256 i = 0; i < _amounts.length; i++) {
                if (_amounts[i] > 0) revert PartialValidatorWithdrawalNotAllowed();
            }
        }

        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    /// @notice Triggers validator full withdrawals for the vault using EIP-7002 permissionlessly if the vault is unhealthy
    /// @param _vault address of the vault to exit validators from
    /// @param _refundRecipient address that will receive the refund for transaction costs
    /// @dev    When the vault becomes unhealthy, trusted actor with the role can force its validators to exit the beacon chain
    ///         This returns the vault's deposited ETH back to vault's balance and allows to rebalance the vault
    function forceValidatorExit(
        address _vault,
        bytes calldata _pubkeys,
        address _refundRecipient
    ) external payable onlyRole(VALIDATOR_EXIT_ROLE) {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 redemptions = _vaultObligations(_vault).redemptions;
        if (_isVaultHealthy(connection, record) && redemptions < Math256.max(OBLIGATIONS_THRESHOLD, _vault.balance)) {
            revert ForceValidatorExitNotAllowed();
        }

        uint64[] memory amounts = new uint64[](0);
        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, amounts, _refundRecipient);
    }

    /// @notice Permissionless rebalance for unhealthy vaults
    /// @param _vault vault address
    /// @dev rebalance all available amount of ether until the vault is healthy
    function forceRebalance(address _vault) external {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 fullRebalanceAmount = _rebalanceShortfall(connection, record);
        if (fullRebalanceAmount == 0) revert AlreadyHealthy(_vault);

        // TODO: add some gas compensation here
        _rebalance(_vault, record, Math256.min(fullRebalanceAmount, _vault.balance));
    }

    /// @notice Accrues a redemption obligation on the vault under extreme conditions
    /// @param _vault The address of the vault
    /// @param _value The value of the redemptions obligation
    function setVaultRedemptions(address _vault, uint256 _value) external onlyRole(REDEMPTION_MASTER_ROLE) {
        uint256 liabilityShares_ = _vaultRecord(_vault).liabilityShares;
        if (liabilityShares_ > 0) {
            uint256 liability = _getPooledEthBySharesRoundUp(liabilityShares_);
            uint256 redemptions = Math256.min(_value, liability);

            VaultObligations storage obligations = _vaultObligations(_vault);
            obligations.redemptions = uint64(redemptions);

            // current unsettled treasury fees are used here, because no new fees provided
            _settleObligations(_vault, _vaultRecord(_vault), 0, MAX_UINT256);
        }
    }

    /// @notice Allows a vault owner to fully or partially repay outstanding obligations on the vault
    /// @param _vault The address of the vault
    /// @dev msg.sender should be vault's owner
    function settleVaultObligations(address _vault) external {
        if (_vault.balance == 0) revert ZeroBalance();

        // settle using existing unsettled fees, and don't revert if some obligations remain
        _settleObligations(_vault, _vaultRecord(_vault), 0, MAX_UINT256);
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

    /// @notice Compensates disproven predeposit from PDG to the recipient
    /// @param _vault vault address
    /// @param _pubkey pubkey of the validator
    /// @param _recipient address to compensate the disproven validator predeposit to
    function compensateDisprovenPredepositFromPDG(
        address _vault,
        bytes calldata _pubkey,
        address _recipient
    ) external returns (uint256) {
        _checkConnectionAndOwner(_vault);

        return _predepositGuarantee().compensateDisprovenPredeposit(_pubkey, _recipient);
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
        _requireNotZero(_reserveRatioBP);
        _requireLessThanBP(_reserveRatioBP, TOTAL_BASIS_POINTS);
        _requireNotZero(_forcedRebalanceThresholdBP);
        _requireLessThanBP(_forcedRebalanceThresholdBP, _reserveRatioBP);

        _requireLessThanBP(_infraFeeBP, TOTAL_BASIS_POINTS);
        _requireLessThanBP(_liquidityFeeBP, TOTAL_BASIS_POINTS);
        _requireLessThanBP(_reservationFeeBP, TOTAL_BASIS_POINTS);

        VaultConnection memory connection = _vaultConnection(_vault);
        if (connection.pendingDisconnect) revert VaultIsDisconnecting(_vault);
        if (connection.vaultIndex != 0) revert AlreadyConnected(_vault, connection.vaultIndex);

        bytes32 codehash = address(_vault).codehash;
        if (!_storage().codehashes[codehash]) revert CodehashNotAllowed(_vault, codehash);

        uint256 vaultBalance = _vault.balance;
        if (vaultBalance < CONNECT_DEPOSIT) revert VaultInsufficientBalance(_vault, vaultBalance, CONNECT_DEPOSIT);

        // Connecting a new vault with totalValue == balance
        Report memory report = Report({
            totalValue: uint128(vaultBalance),
            inOutDelta: int128(int256(vaultBalance))
        });

        VaultRecord memory record = VaultRecord({
            report: report,
            locked: uint128(CONNECT_DEPOSIT),
            liabilityShares: 0,
            reportTimestamp: _lazyOracle().latestReportTimestamp(),
            inOutDelta: report.inOutDelta
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
            manuallyPausedBeaconChainDeposits: false
        });

        _addVault(_vault, connection, record);
    }

    function _initiateDisconnection(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal {
        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ > 0) {
            revert NoLiabilitySharesShouldBeLeft(_vault, liabilityShares_);
        }

        // try to settle using existing unsettled fees, and revert if some obligations remain
        _settleObligationsIfNeeded(_vault, _record, 0);

        // make sure the vault has enough balance to cover the deposit
        if (_vault.balance < CONNECT_DEPOSIT) {
            revert VaultInsufficientBalance(_vault, _vault.balance, CONNECT_DEPOSIT);
        }

        _connection.pendingDisconnect = true;
    }

    function _completeDisconnection(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record,
        uint256 _accruedTreasuryFees
    ) internal {
        // settle all the fees, but not more than we have in the vault and revert if some obligations remain
        _settleObligations(_vault, _record, Math256.min(_accruedTreasuryFees, _vault.balance), 0);

        IStakingVault(_vault).transferOwnership(_connection.owner);
        // we rely on the oracle to preserve vault index
        _deleteVault(_vault, _connection);

        emit VaultDisconnectCompleted(_vault);
    }

    function _rebalanceEther(
        address _vault,
        VaultRecord storage _record,
        uint256 _ether
    ) internal {
        _withdraw(_vault, _record, address(this), _ether);
        LIDO.rebalanceExternalEtherToInternal{value: _ether}();
    }

    function _rebalance(address _vault, VaultRecord storage _record, uint256 _ether) internal {
        uint256 totalValue_ = _totalValue(_record);
        if (_ether > totalValue_) revert RebalanceAmountExceedsTotalValue(totalValue_, _ether);

        uint256 sharesToBurn = _getSharesByPooledEth(_ether);
        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ < sharesToBurn) revert InsufficientSharesToBurn(_vault, liabilityShares_);

        _decreaseLiability(_vault, _record, sharesToBurn);

        _rebalanceEther(_vault, _record, _ether);

        emit VaultRebalanced(_vault, sharesToBurn, _ether);
    }

    function _withdraw(
        address _vault,
        VaultRecord storage _record,
        address _recipient,
        uint256 _amount
    ) internal {
        int128 inOutDelta_ = _record.inOutDelta - int128(int256(_amount));
        _record.inOutDelta = inOutDelta_;

        IStakingVault(_vault).withdraw(_recipient, _amount);

        emit VaultInOutDeltaUpdated(_vault, inOutDelta_);
    }

    function _increaseLiability(
        address _vault,
        VaultRecord storage _record,
        uint256 _amountOfShares,
        uint256 _reserveRatioBP,
        uint256 _maxMintableRatioBP,
        uint256 _shareLimit
    ) internal {
        uint256 totalValue_ = _totalValue(_record);
        uint256 treasuryFees = _vaultObligations(_vault).treasuryFees;
        uint256 sharesAfterMint = _record.liabilityShares + _amountOfShares;

        if (sharesAfterMint > _shareLimit) revert ShareLimitExceeded(_vault, sharesAfterMint, _shareLimit);

        uint256 maxMintableEther = ((totalValue_ - treasuryFees) * _maxMintableRatioBP) / TOTAL_BASIS_POINTS;
        uint256 stETHAfterMint = _getPooledEthBySharesRoundUp(sharesAfterMint);
        if (stETHAfterMint > maxMintableEther) {
            revert InsufficientTotalValueToMint(_vault, totalValue_, treasuryFees);
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 etherToLock = (stETHAfterMint * TOTAL_BASIS_POINTS) / _reserveRatioBP;
        if (etherToLock > _record.locked) {
            _record.locked = uint128(etherToLock);
        }

        _record.liabilityShares = uint96(sharesAfterMint);

        _operatorGrid().onMintedShares(_vault, _amountOfShares);
    }

    function _decreaseLiability(address _vault, VaultRecord storage _record, uint256 _amountOfShares) internal {
        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ < _amountOfShares) revert InsufficientSharesToBurn(_vault, liabilityShares_);

        _record.liabilityShares = uint96(liabilityShares_ - _amountOfShares);

        _operatorGrid().onBurnedShares(_vault, _amountOfShares);
        _decreaseRedemptions(_vault, _amountOfShares);
    }

    function _rebalanceShortfall(
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

        uint256 liabilityStETH = _getPooledEthBySharesRoundUp(liabilityShares_);
        uint256 reserveRatioBP = _connection.reserveRatioBP;
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);

        // Impossible to rebalance a vault with deficit
        if (liabilityStETH >= totalValue_) {
            // return MAX_UINT_256
            return type(uint256).max;
        }

        // Solve the equation for X:

        // LS - liabilityStETH, TV - totalValue, MR - maxMintableRatio, 100 - TOTAL_BASIS_POINTS, RR - reserveRatio

        // X - amount of ETH that should be withdrawn (TV - X) and used to repay the debt (LS - X)
        // to reduce the LS/TV ratio back to MR

        // (LS - X) / (TV - X) = MR / 100
        // (LS - X) * 100 = (TV - X) * MR
        // LS * 100 - X * 100 = TV * MR - X * MR
        // X * MR - X * 100 = TV * MR - LS * 100
        // X * (MR - 100) = TV * MR - LS * 100
        // X = (TV * MR - LS * 100) / (MR - 100)
        // X = (LS * 100 - TV * MR) / (100 - MR)
        // RR = 100 - MR
        // X = (LS * 100 - TV * MR) / RR

        return (liabilityStETH * TOTAL_BASIS_POINTS - totalValue_ * maxMintableRatio) / reserveRatioBP;
    }

    function _unlocked(VaultRecord storage _record) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_record);
        uint256 locked_ = _record.locked;

        if (locked_ > totalValue_) return 0;

        return totalValue_ - locked_;
    }

    function _totalValue(VaultRecord storage _record) internal view returns (uint256) {
        Report memory report = _record.report;
        return uint256(int256(uint256(report.totalValue)) + _record.inOutDelta - report.inOutDelta);
    }

    function _isReportFresh(VaultRecord storage _record) internal view returns (bool) {
        uint256 latestReportTimestamp = _lazyOracle().latestReportTimestamp();
        return
            // check if AccountingOracle brought fresh report
            latestReportTimestamp == _record.reportTimestamp &&
            // if Accounting Oracle stop bringing the report, last report is fresh for 2 days
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

    function _addVault(
        address _vault,
        VaultConnection memory _connection,
        VaultRecord memory _record
    ) internal {
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
        delete $.obligations[_vault];
    }

    function _checkConnection(address _vault) internal view returns (VaultConnection storage) {
        _requireNotZero(_vault);

        VaultConnection storage connection = _vaultConnection(_vault);
        _requireConnected(connection, _vault);
        if (connection.pendingDisconnect) revert VaultIsDisconnecting(_vault);

        return connection;
    }

    function _checkConnectionAndOwner(address _vault) internal view returns (VaultConnection storage connection) {
        connection = _checkConnection(_vault);
        _requireSender(connection.owner);
    }

    /// @notice Decreases the redemptions obligation by the amount of shares burned
    /// @param _vault vault address
    /// @param _sharesBurned amount of shares to burn
    function _decreaseRedemptions(address _vault, uint256 _sharesBurned) internal {
        VaultObligations storage obligations = _vaultObligations(_vault);
        if (obligations.redemptions > 0) {
            uint256 decrease = Math256.min(obligations.redemptions, _getPooledEthBySharesRoundUp(_sharesBurned));
            obligations.redemptions = uint64(obligations.redemptions - decrease);
            emit RedemptionsObligationUpdated(_vault, obligations.redemptions, decrease);
        }
    }

    function _settleObligationsIfNeeded(
        address _vault,
        VaultRecord storage _record,
        uint256 _maxAllowedUnsettled
    ) internal {
        VaultObligations storage obligations = _vaultObligations(_vault);
        if (obligations.treasuryFees > 0 || obligations.redemptions > 0) {
            // settle using existing unsettled fees
            _settleObligations(_vault, _record, 0, _maxAllowedUnsettled);
        }
    }

    /**
     * @notice Calculates a settlement plan based on vault balance and obligations
     * @param _vaultBalance The current balance of the vault
     * @param _redemptions The amount of redemptions to be settled
     * @param _existingTreasuryFees The existing treasury fees to be settled
     * @param _newTreasuryFees The new treasury fees to be settled
     * @return valueToRebalance The ETH amount to be rebalanced for redemptions
     * @return valueToTransferToTreasury The ETH amount to be sent to the treasury
     * @return totalUnsettled The total ETH value of obligations remaining after the planned settlement
     * @dev This is a pure calculation function with no side effects
     */
    function _calculateSettlementPlan(
        uint256 _vaultBalance,
        uint256 _redemptions,
        uint256 _existingTreasuryFees,
        uint256 _newTreasuryFees
    ) internal pure returns (
        uint256 valueToRebalance,
        uint256 valueToTransferToTreasury,
        uint256 totalUnsettled
    ) {
        uint256 totalTreasuryFeesToSettle = _existingTreasuryFees + _newTreasuryFees;

        valueToRebalance = Math256.min(_redemptions, _vaultBalance);
        valueToTransferToTreasury = Math256.min(totalTreasuryFeesToSettle, _vaultBalance - valueToRebalance);

        uint256 unsettledRedemptions = _redemptions - valueToRebalance;
        uint256 unsettledTreasuryFees = totalTreasuryFeesToSettle - valueToTransferToTreasury;
        totalUnsettled = unsettledRedemptions + unsettledTreasuryFees;
    }

    /**
     * @notice Settles redemptions and treasury fee obligations for a vault.
     *         It calculates amounts to pay from the vault's balance, performs the necessary withdrawals/rebalances, and updates obligation state.
     * @param _vault The address of the vault to settle obligations for
     * @param _record The record of the vault to settle obligations for
     * @param _newTreasuryFees The new treasury fees to be settled, can be 0 if no new fees should be accounted for
     * @param _maxAllowedUnsettled The maximum allowable unsettled obligations post-settlement (triggers reverts)
     * @dev    It also updates the vault deposit pause status based on the remaining obligations
     */
    function _settleObligations(
        address _vault,
        VaultRecord storage _record,
        uint256 _newTreasuryFees,
        uint256 _maxAllowedUnsettled
    ) internal {
        VaultObligations storage obligations = _vaultObligations(_vault);

        (
            uint256 valueToRebalance,
            uint256 valueToTransferToTreasury,
            uint256 totalUnsettled
        ) = _calculateSettlementPlan(
            _vault.balance,
            obligations.redemptions,
            obligations.treasuryFees,
            _newTreasuryFees
        );

        // Enforce requirement for settlement completeness
        if (totalUnsettled > _maxAllowedUnsettled) {
            revert VaultHasUnsettledObligations(_vault, totalUnsettled);
        }

        if (valueToRebalance > 0) {
            uint256 sharesToBurn = _getSharesByPooledEth(valueToRebalance);
            uint256 unsettledRedemptions = obligations.redemptions - valueToRebalance;

            _decreaseLiability(_vault, _record, sharesToBurn);

            _rebalanceEther(_vault, _record, valueToRebalance);

            obligations.redemptions = uint64(unsettledRedemptions);
            emit RedemptionsObligationUpdated(_vault, unsettledRedemptions, valueToRebalance);
        }

        if (valueToTransferToTreasury > 0 || _newTreasuryFees > 0) {
            if (valueToTransferToTreasury > 0) {
                 _withdraw(_vault, _record, LIDO_LOCATOR.treasury(), valueToTransferToTreasury);
                 obligations.totalSettledTreasuryFees += uint128(valueToTransferToTreasury);
            }
            uint256 unsettledTreasuryFees = (obligations.treasuryFees + _newTreasuryFees) - valueToTransferToTreasury;
            obligations.treasuryFees = uint64(unsettledTreasuryFees);
            emit TreasuryFeesObligationUpdated(_vault, unsettledTreasuryFees, valueToTransferToTreasury);
        }

        // Update vault deposit pause status based on remaining obligations.
        IStakingVault vault_ = IStakingVault(_vault);
        bool isBeaconChainDepositsPaused = vault_.beaconChainDepositsPaused();

        if (!isBeaconChainDepositsPaused && totalUnsettled >= OBLIGATIONS_THRESHOLD) {
            vault_.pauseBeaconChainDeposits();
        } else if (isBeaconChainDepositsPaused && totalUnsettled < OBLIGATIONS_THRESHOLD) {
            if (!_vaultConnection(_vault).manuallyPausedBeaconChainDeposits) {
                vault_.resumeBeaconChainDeposits();
            }
        }
    }

    function _availableBalance(address _vault) internal view returns (uint256) {
        if (_vaultConnection(_vault).vaultIndex == 0) return 0;

        uint256 vaultBalance = _vault.balance;
        VaultObligations storage obligations = _vaultObligations(_vault);
        uint256 unsettledObligations_ = obligations.treasuryFees + obligations.redemptions;
        return unsettledObligations_ > vaultBalance ? 0 : vaultBalance - unsettledObligations_;
    }

    function _checkAvailableBalance(address _vault, uint256 _requiredBalance) internal view {
        uint256 available = _availableBalance(_vault);
        if (_requiredBalance > available) {
            revert VaultInsufficientBalance(_vault, available, _requiredBalance);
        }
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

    function _vaultObligations(address _vault) internal view returns (VaultObligations storage) {
        return _storage().obligations[_vault];
    }

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
        uint256 forcedRebalanceThresholdBP,
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );
    event VaultShareLimitUpdated(address indexed vault, uint256 newShareLimit);
    event VaultFeesUpdated(address indexed vault, uint256 infraFeeBP, uint256 liquidityFeeBP, uint256 reservationFeeBP);
    event VaultDisconnectInitiated(address indexed vault);
    event VaultDisconnectCompleted(address indexed vault);
    event VaultDisconnectAborted(address indexed vault, uint256 slashingReserve);
    event VaultReportApplied(
        address indexed vault,
        uint256 reportTimestamp,
        uint256 reportTotalValue,
        int256 reportInOutDelta,
        uint256 reportAccumulatedTreasuryFees,
        uint256 reportLiabilityShares,
        uint256 reportSlashingReserve
    );

    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares, uint256 lockedAmount);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned, uint256 etherWithdrawn);
    event VaultInOutDeltaUpdated(address indexed vault, int128 inOutDelta);

    /**
     * @notice Emitted when the manager is set
     * @param vault The address of the vault
     * @param newOwner The address of the new owner
     * @param oldOwner The address of the old owner
     */
    event VaultOwnershipTransferred(address indexed vault, address indexed newOwner, address indexed oldOwner);

    event TreasuryFeesObligationUpdated(address indexed vault, uint256 unsettled, uint256 settled);
    event RedemptionsObligationUpdated(address indexed vault, uint256 unsettled, uint256 settled);

    event BadDebtSocialized(address indexed vaultDonor, address indexed vaultAcceptor, uint256 badDebtShares);

    error ZeroBalance();

    /**
     * @notice Thrown when trying to withdraw more ether than the balance of `StakingVault`
     * @param balance Current balance
     */
    error InsufficientBalance(uint256 balance, uint256 expectedBalance);

    /**
     * @notice Thrown when trying to withdraw more than the unlocked amount
     * @param unlocked Current unlocked amount
     */
    error InsufficientUnlocked(uint256 unlocked, uint256 expectedUnlocked);

    error TotalValueBelowLockedAmount();

    /**
     * @notice Thrown when attempting to rebalance more ether than the current total value of the vault
     * @param totalValue Current total value of the vault
     * @param rebalanceAmount Amount attempting to rebalance
     */
    error RebalanceAmountExceedsTotalValue(uint256 totalValue, uint256 rebalanceAmount);
    error AlreadyHealthy(address vault);
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
    error InsufficientTotalValueToMint(address vault, uint256 totalValue, uint256 treasuryFees);
    error NoLiabilitySharesShouldBeLeft(address vault, uint256 liabilityShares);
    error CodehashNotAllowed(address vault, bytes32 codehash);
    error InvalidFees(address vault, uint256 newFees, uint256 oldFees);
    error VaultOssified(address vault);
    error VaultInsufficientBalance(address vault, uint256 currentBalance, uint256 expectedBalance);
    error VaultReportStale(address vault);
    error PDGNotDepositor(address vault);
    error ZeroCodehash();
    error VaultHubNotPendingOwner(address vault);
    error UnhealthyVaultCannotDeposit(address vault);
    error VaultIsDisconnecting(address vault);
    error VaultHasUnsettledObligations(address vault, uint256 unsettledObligations);
    error PartialValidatorWithdrawalNotAllowed();
    error ForceValidatorExitNotAllowed();
    error NoBadDebtToSocialize(address vault, uint256 totalValueShares, uint256 liabilityShares);
    error NoBadDebtToInternalize(address vault, uint256 totalValueShares, uint256 liabilityShares);
    error SocializeIsLimitedByReserve(address vault, uint256 reserveShares, uint256 amountOfSharesToSocialize);
    error BadDebtSocializationNotAllowed();
}
