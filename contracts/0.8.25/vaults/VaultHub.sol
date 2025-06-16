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

import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";
import {OperatorGrid} from "./OperatorGrid.sol";
import {LazyOracle} from "./LazyOracle.sol";

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
        bool isBeaconDepositsManuallyPaused;
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
        /// @notice inOutDelta of the vault (all deposits - all withdrawals)
        Int112WithRefSlotCache inOutDelta;
        // ### 4th slot
        /// @notice timestamp of the latest report
        uint64 reportTimestamp;
        // 192 bits of gap
    }

    struct Report {
        /// @notice total value of the vault
        uint128 totalValue;
        /// @notice inOutDelta of the report
        int112 inOutDelta;
    }

    struct Int112WithRefSlotCache {
        /// @notice current value
        int112 value;
        /// @notice cached value of the latest refSlot
        int112 refSlotValue;
        /// @notice cached refSlot number
        uint32 refSlot;
    }

    /**
     *  Obligations of the vaults towards the Lido protocol.
     *  While any part of those obligations remains unsettled, VaultHub may want to limit what the vault can do.
     *
     *  Obligations have two types:
     *  1. Redemptions. Under extreme conditions Lido protocol may rebalance the part of the vault's liability to serve
     *     the Lido Core withdrawal queue requests to guarantee that every stETH is redeemable. Calculated in ether.
     *  2. Lido fees. Record of infra, liquidity and reservation fees charged to the vault. Charged in ether on every
     *     oracle report.
     *
     *  Obligations settlement:
     *  - Lido fees are settled by transferring ether to the Lido protocol treasury
     *  - Redemptions are settled by rebalancing the vault or by burning stETH on the vault
     *  - Obligations may be settled manually using the `settleVaultObligations` function
     *  - Obligations try to automatically settle:
     *    - every time oracle report is applied to the vault
     *    - on resume of the beacon chain deposits
     *    - on disconnect initiation
     *  - Lido fees are automatically settled on the final report that completes the disconnection process
     *
     *  Constraints until obligations settled:
     *  - Beacon chain deposits are paused while unsettled obligations ≥ OBLIGATIONS_THRESHOLD (1 ETH)
     *  - Unsettled obligations can't be withdrawn
     *  - Minting new stETH is limited by unsettled Lido fees (NB: redemptions do not affect minting capacity)
     *  - Vault disconnect is refused until both unsettled redemptions and Lido fees obligations hit zero
     *
     * @dev NB: Under extreme conditions, Lido protocol may trigger validator exits to withdraw ether to the vault and
     *          rebalance it to settle redemptions.
     */
    struct VaultObligations {
        /// @notice cumulative value for Lido fees that were settled on the vault
        uint128 settledLidoFees;
        /// @notice current unsettled Lido fees amount
        uint128 unsettledLidoFees;
        /// @notice current unsettled redemptions amount
        uint128 redemptions;
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
    /// @notice amount of ETH that is locked on the vault on connect and can be withdrawn on disconnect only
    uint256 public constant CONNECT_DEPOSIT = 1 ether;

    /// @notice The time delta for report freshness check
    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;

    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    /// @notice length of the validator pubkey in bytes
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    /// @dev max value for fees in basis points - it's about 650%
    uint256 internal constant MAX_FEE_BP = type(uint16).max;

    /// @notice codehash of the account with no code
    bytes32 private constant EMPTY_CODEHASH = keccak256("");

    /// @notice no limit for the unsettled obligations on settlement
    uint256 internal constant MAX_UNSETTLED_ALLOWED = type(uint256).max;
    /// @notice threshold for the unsettled obligations that will activate the beacon chain deposits pause
    uint256 internal constant UNSETTLED_THRESHOLD = 1 ether;
    /// @notice no unsettled obligations allowed on settlement
    uint256 internal constant NO_UNSETTLED_ALLOWED = 0;

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
        if (_maxRelativeShareLimitBP == 0) revert ZeroArgument();
        if (_maxRelativeShareLimitBP > TOTAL_BASIS_POINTS) {
            revert MaxRelativeShareLimitBPTooHigh(_maxRelativeShareLimitBP, TOTAL_BASIS_POINTS);
        }

        MAX_RELATIVE_SHARE_LIMIT_BP = _maxRelativeShareLimitBP;

        LIDO_LOCATOR = _locator;
        LIDO = _lido;
        CONSENSUS_CONTRACT = _consensusContract;

        _disableInitializers();
    }

    /// @dev used to perform rebalance operations
    receive() external payable {}

    /// @notice Initialize the contract with admin role
    /// @param _admin address to grant admin role to
    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument();

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
        if (_index == 0) revert ZeroIndex();
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

    /// @return the obligations struct for the given vault
    /// @dev returns empty struct if the vault is not connected to the hub
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
        return _maxLockableValue(_vaultRecord(_vault), _vaultObligations(_vault));
    }

    /// @return the amount of ether that can be instantly withdrawn from the staking vault
    /// @dev returns 0 if the vault is not connected
    /// @dev check for `pendingDisconnect = false` before using this function to avoid reverts
    function withdrawableValue(address _vault) external view returns (uint256) {
        return _withdrawableValue(_vault, _vaultRecord(_vault));
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

    /// @notice Set if a vault proxy codehash is allowed to be connected to the hub
    /// @param _codehash vault proxy codehash
    /// @param _allowed true to add, false to remove
    function setAllowedCodehash(bytes32 _codehash, bool _allowed) external onlyRole(VAULT_CODEHASH_SET_ROLE) {
        if (_codehash == bytes32(0)) revert ZeroArgument();
        if (_codehash == EMPTY_CODEHASH) revert ZeroCodehash();

        _storage().codehashes[_codehash] = _allowed;

        emit AllowedCodehashUpdated(_codehash, _allowed);
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    /// @dev vault should have transferred ownership to the VaultHub contract
    function connectVault(address _vault) external whenResumed {
        if (_vault == address(0)) revert VaultZeroAddress();

        IStakingVault vault_ = IStakingVault(_vault);
        if (vault_.pendingOwner() != address(this)) revert VaultHubNotPendingOwner(_vault);
        if (vault_.isOssified()) revert VaultOssified(_vault);
        if (vault_.depositor() != LIDO_LOCATOR.predepositGuarantee()) revert PDGNotDepositor(_vault);

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
        if (_vault == address(0)) revert ZeroArgument();
        if (_shareLimit > _maxSaneShareLimit()) revert ShareLimitTooHigh(_vault, _shareLimit, _maxSaneShareLimit());

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
        if (_vault == address(0)) revert ZeroArgument();
        if (_infraFeeBP > MAX_FEE_BP) revert InfraFeeTooHigh(_vault, _infraFeeBP, MAX_FEE_BP);
        if (_liquidityFeeBP > MAX_FEE_BP) revert LiquidityFeeTooHigh(_vault, _liquidityFeeBP, MAX_FEE_BP);
        if (_reservationFeeBP > MAX_FEE_BP) revert ReservationFeeTooHigh(_vault, _reservationFeeBP, MAX_FEE_BP);

        VaultConnection storage connection = _checkConnection(_vault);
        uint16 preInfraFeeBP = connection.infraFeeBP;
        uint16 preLiquidityFeeBP = connection.liquidityFeeBP;
        uint16 preReservationFeeBP = connection.reservationFeeBP;

        connection.infraFeeBP = uint16(_infraFeeBP);
        connection.liquidityFeeBP = uint16(_liquidityFeeBP);
        connection.reservationFeeBP = uint16(_reservationFeeBP);

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
        if (msg.sender != address(_operatorGrid())) revert NotAuthorized();
        if (_shareLimit > _maxSaneShareLimit()) revert ShareLimitTooHigh(_vault, _shareLimit, _maxSaneShareLimit());

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
    /// @param _reportCumulativeLidoFees the cumulative Lido fees of the vault
    /// @param _reportLiabilityShares the liabilityShares of the vault
    function applyVaultReport(
        address _vault,
        uint64 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares
    ) external whenResumed {
        if (msg.sender != address(_lazyOracle())) revert NotAuthorized();

        VaultConnection storage connection = _vaultConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        VaultObligations storage obligations = _vaultObligations(_vault);

        _checkAndUpdateLidoFeesObligations(_vault, obligations, _reportCumulativeLidoFees);

        if (connection.pendingDisconnect) {
            _settleObligations(_vault, record, obligations, NO_UNSETTLED_ALLOWED);

            IStakingVault(_vault).transferOwnership(connection.owner);
            _deleteVault(_vault, connection);

            emit VaultDisconnectCompleted(_vault);
            return;
        }

        _applyVaultReport(
            record,
            connection,
            _reportTimestamp,
            _reportTotalValue,
            _reportLiabilityShares,
            _reportInOutDelta
        );

        emit VaultReportApplied({
            vault: _vault,
            reportTimestamp: _reportTimestamp,
            reportTotalValue: _reportTotalValue,
            reportInOutDelta: _reportInOutDelta,
            reportCumulativeLidoFees: _reportCumulativeLidoFees,
            reportLiabilityShares: _reportLiabilityShares
        });

        _settleObligations(_vault, record, obligations, MAX_UNSETTLED_ALLOWED);
        _checkAndUpdateBeaconChainDepositsPause(_vault, connection, record);
    }

    /// @notice transfer the ownership of the vault to a new owner without disconnecting it from the hub
    /// @param _vault vault address
    /// @param _newOwner new owner address
    /// @dev msg.sender should be vault's owner
    function transferVaultOwnership(address _vault, address _newOwner) external {
        if (_newOwner == address(0)) revert ZeroArgument();
        VaultConnection storage connection = _checkConnection(_vault);
        address oldOwner = connection.owner;

        if (oldOwner != msg.sender) revert NotAuthorized();

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
        if (_vault == address(0)) revert VaultZeroAddress();

        VaultConnection storage connection = _vaultConnection(_vault);
        if (connection.vaultIndex == 0) revert NotConnectedToHub(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        _updateInOutDelta(_vault, _vaultRecord(_vault), int112(int256(msg.value)));

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

        uint256 withdrawable = _withdrawableValue(_vault, record);
        if (_ether > withdrawable) revert VaultInsufficientWithdrawableValue(_vault, withdrawable, _ether);

        _withdraw(_vault, record, _recipient, _ether);
    }

    /// @notice Rebalances StakingVault by withdrawing ether to VaultHub
    /// @param _vault vault address
    /// @param _ether amount of ether to rebalance
    /// @dev msg.sender should be vault's owner
    function rebalance(address _vault, uint256 _ether) external whenResumed {
        if (_ether == 0) revert ZeroArgument();
        if (_ether > _vault.balance) revert InsufficientBalance(_vault.balance, _ether);
        _checkConnectionAndOwner(_vault);

        _rebalance(_vault, _vaultRecord(_vault), _ether);
    }

    /// @notice mint StETH shares backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _amountOfShares amount of stETH shares to mint
    function mintShares(address _vault, address _recipient, uint256 _amountOfShares) external whenResumed {
        if (_recipient == address(0)) revert ZeroArgument();
        if (_amountOfShares == 0) revert ZeroArgument();

        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 vaultSharesAfterMint = record.liabilityShares + _amountOfShares;
        if (vaultSharesAfterMint > connection.shareLimit) revert ShareLimitExceeded(_vault, connection.shareLimit);

        if (!_isReportFresh(record)) revert VaultReportStale(_vault);

        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - connection.reserveRatioBP;
        uint256 maxLockableValue_ = _maxLockableValue(record, _vaultObligations(_vault));
        uint256 maxMintableEther = (maxLockableValue_ * maxMintableRatioBP) / TOTAL_BASIS_POINTS;

        uint256 stETHAfterMint = _getPooledEthBySharesRoundUp(vaultSharesAfterMint);
        if (stETHAfterMint > maxMintableEther) {
            revert InsufficientValueToMint(_vault, maxLockableValue_);
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 etherToLock = (stETHAfterMint * TOTAL_BASIS_POINTS) / maxMintableRatioBP;
        if (etherToLock > record.locked) {
            record.locked = uint128(etherToLock);
        }

        record.liabilityShares = uint96(vaultSharesAfterMint);
        _operatorGrid().onMintedShares(_vault, _amountOfShares);
        LIDO.mintExternalShares(_recipient, _amountOfShares);

        emit MintedSharesOnVault(_vault, _amountOfShares, record.locked);
    }

    /// @notice burn steth shares from the balance of the VaultHub contract
    /// @param _vault vault address
    /// @param _amountOfShares amount of shares to burn
    /// @dev msg.sender should be vault's owner
    /// @dev this function is designed to be used by the smart contract, for EOA see `transferAndBurnShares`
    function burnShares(address _vault, uint256 _amountOfShares) public whenResumed {
        if (_amountOfShares == 0) revert ZeroArgument();
        _checkConnectionAndOwner(_vault);

        VaultRecord storage record = _vaultRecord(_vault);

        uint256 liabilityShares_ = record.liabilityShares;
        if (liabilityShares_ < _amountOfShares) revert InsufficientSharesToBurn(_vault, liabilityShares_);

        record.liabilityShares = uint96(liabilityShares_ - _amountOfShares);

        LIDO.burnExternalShares(_amountOfShares);
        _operatorGrid().onBurnedShares(_vault, _amountOfShares);
        _decreaseRedemptions(_vault, _getPooledEthBySharesRoundUp(_amountOfShares));

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

        connection.isBeaconDepositsManuallyPaused = true;
        IStakingVault(_vault).pauseBeaconChainDeposits();
    }

    /// @notice resumes beacon chain deposits for the vault
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    function resumeBeaconChainDeposits(address _vault) external {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        if (!_isVaultHealthy(connection, record)) revert UnhealthyVaultCannotDeposit(_vault);

        _settleObligations(_vault, record, _vaultObligations(_vault), UNSETTLED_THRESHOLD);

        connection.isBeaconDepositsManuallyPaused = false;
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
    /// @param _pubkeys array of public keys of the validators to withdraw from
    /// @param _amounts array of amounts to withdraw from each validator (0 for full withdrawal)
    /// @param _refundRecipient address that will receive the refund for transaction costs
    /// @dev msg.sender should be vault's owner
    function triggerValidatorWithdrawals(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);
        VaultObligations storage obligations = _vaultObligations(_vault);

        /// @dev NB: Disallow partial withdrawals when the vault is unhealthy or has redemptions over the threshold
        ///          in order to prevent the vault owner from clogging the consensus layer withdrawal queue
        ///          front-running and delaying the forceful validator exits required for rebalancing the vault,
        ///          unless the requested amount of withdrawals is enough to recover the vault to healthy state and
        ///          settle the unsettled obligations
        if (!_isVaultHealthy(connection, record) || obligations.redemptions >= UNSETTLED_THRESHOLD) {
            uint256 minPartialAmount = type(uint256).max;
            for (uint256 i = 0; i < _amounts.length; i++) {
                if (_amounts[i] > 0 && _amounts[i] < minPartialAmount) minPartialAmount = _amounts[i];
            }

            if (minPartialAmount < type(uint256).max) {
                uint256 currentVaultBalance = _vault.balance;
                uint256 required = _totalUnsettledObligations(obligations) + _rebalanceShortfall(connection, record);
                uint256 amountToCover = required > currentVaultBalance ? required - currentVaultBalance : 0;

                if (minPartialAmount < amountToCover) revert PartialValidatorWithdrawalNotAllowed();
            }
        }

        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    /// @notice Triggers validator full withdrawals for the vault using EIP-7002 permissionlessly if the vault is
    ///         unhealthy or has redemptions obligation over the threshold
    /// @param _vault address of the vault to exit validators from
    /// @param _pubkeys array of public keys of the validators to exit
    /// @param _refundRecipient address that will receive the refund for transaction costs
    /// @dev    When the vault becomes unhealthy, trusted actor with the role can force its validators to exit the beacon chain
    ///         This returns the vault's deposited ETH back to vault's balance and allows to rebalance the vault
    function forceValidatorExit(
        address _vault,
        bytes calldata _pubkeys,
        address _refundRecipient
    ) external payable onlyRole(VALIDATOR_EXIT_ROLE) {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        if (
            _isVaultHealthy(connection, record) &&
            // Check if the vault has redemptions under the threshold, or enough balance to cover the redemptions fully
            _vaultObligations(_vault).redemptions < Math256.max(UNSETTLED_THRESHOLD, _vault.balance)
        ) {
            revert ForcedValidatorExitNotAllowed();
        }

        uint64[] memory amounts = new uint64[](0);
        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, amounts, _refundRecipient);

        emit ForcedValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
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
    /// @param _redemptionsValue The value of the redemptions obligation
    function setVaultRedemptions(address _vault, uint256 _redemptionsValue) external onlyRole(REDEMPTION_MASTER_ROLE) {
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 liabilityShares_ = record.liabilityShares;

        // This function may intentionally perform no action in some cases, as these are EasyTrack motions
        if (liabilityShares_ > 0) {
            uint256 newRedemptions = Math256.min(_redemptionsValue, _getPooledEthBySharesRoundUp(liabilityShares_));
            _vaultObligations(_vault).redemptions = uint128(newRedemptions);
            emit RedemptionsUpdated(_vault, newRedemptions);

            _checkAndUpdateBeaconChainDepositsPause(_vault, _vaultConnection(_vault), record);
        } else {
            emit RedemptionsNotSet(_vault, _redemptionsValue);
        }
    }

    /// @notice Allows permissionless full or partial settlement of unsettled obligations on the vault
    /// @param _vault The address of the vault
    function settleVaultObligations(address _vault) external whenResumed {
        if (_vault.balance == 0) revert ZeroBalance();

        VaultRecord storage record = _vaultRecord(_vault);
        _settleObligations(_vault, record, _vaultObligations(_vault), MAX_UNSETTLED_ALLOWED);

        _checkAndUpdateBeaconChainDepositsPause(_vault, _vaultConnection(_vault), record);
    }

    /// @notice Proves that validators unknown to PDG have correct WC to participate in the vault
    /// @param _vault vault address
    /// @param _witness ValidatorWitness struct proving validator WC belonging to staking vault
    function proveUnknownValidatorToPDG(
        address _vault,
        IPredepositGuarantee.ValidatorWitness calldata _witness
    ) external {
        _checkConnectionAndOwner(_vault);

        IPredepositGuarantee(LIDO_LOCATOR.predepositGuarantee()).proveUnknownValidator(_witness, IStakingVault(_vault));
    }

    /// @notice Compensates disproven predeposit from PDG to the recipient
    /// @param _vault vault address
    /// @param _pubkey pubkey of the validator
    /// @param _recipient address to compensate the disproven validator predeposit to
    /// @return amount of compensated ether
    function compensateDisprovenPredepositFromPDG(
        address _vault,
        bytes calldata _pubkey,
        address _recipient
    ) external returns (uint256) {
        _checkConnectionAndOwner(_vault);

        return IPredepositGuarantee(LIDO_LOCATOR.predepositGuarantee()).compensateDisprovenPredeposit(_pubkey, _recipient);
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
        if (_shareLimit > _maxSaneShareLimit()) revert ShareLimitTooHigh(_vault, _shareLimit, _maxSaneShareLimit());
        if (_reserveRatioBP == 0) revert ZeroArgument();
        if (_reserveRatioBP > TOTAL_BASIS_POINTS) revert ReserveRatioTooHigh(_vault, _reserveRatioBP, TOTAL_BASIS_POINTS);
        if (_forcedRebalanceThresholdBP == 0) revert ZeroArgument();
        if (_forcedRebalanceThresholdBP > _reserveRatioBP) {
            revert ForcedRebalanceThresholdTooHigh(_vault, _forcedRebalanceThresholdBP, _reserveRatioBP);
        }
        if (_infraFeeBP > MAX_FEE_BP) revert InfraFeeTooHigh(_vault, _infraFeeBP, MAX_FEE_BP);
        if (_liquidityFeeBP > MAX_FEE_BP) revert LiquidityFeeTooHigh(_vault, _liquidityFeeBP, MAX_FEE_BP);
        if (_reservationFeeBP > MAX_FEE_BP) revert ReservationFeeTooHigh(_vault, _reservationFeeBP, MAX_FEE_BP);

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
            inOutDelta: int112(int256(vaultBalance))
        });

        VaultRecord memory record = VaultRecord({
            report: report,
            locked: uint128(CONNECT_DEPOSIT),
            liabilityShares: 0,
            reportTimestamp: _lazyOracle().latestReportTimestamp(),
            inOutDelta: Int112WithRefSlotCache({
                value: report.inOutDelta,
                refSlotValue: 0,
                refSlot: 0
            })
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
        VaultRecord storage _record
    ) internal {
        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ > 0) {
            revert NoLiabilitySharesShouldBeLeft(_vault, liabilityShares_);
        }

        _record.locked = 0; // unlock the connection deposit to allow fees settlement
        _settleObligations(_vault, _record, _vaultObligations(_vault), NO_UNSETTLED_ALLOWED);

        _connection.pendingDisconnect = true;

        _operatorGrid().resetVaultTier(_vault);
    }

    function _applyVaultReport(
        VaultRecord storage _record,
        VaultConnection storage _connection,
        uint64 _reportTimestamp,
        uint256 _reportTotalValue,
        uint256 _reportLiabilityShares,
        int256 _reportInOutDelta
    ) internal {
        uint256 liabilityShares_ = Math256.max(_record.liabilityShares, _reportLiabilityShares);
        uint256 liability = _getPooledEthBySharesRoundUp(liabilityShares_);

        uint256 lockedEther = Math256.max(
            liability * TOTAL_BASIS_POINTS / (TOTAL_BASIS_POINTS - _connection.reserveRatioBP),
            CONNECT_DEPOSIT
        );

        _record.locked = uint128(lockedEther);
        _record.reportTimestamp = _reportTimestamp;
        _record.report = Report({
            totalValue: uint128(_reportTotalValue),
            inOutDelta: int112(_reportInOutDelta)
        });
    }

    function _rebalanceEther(
        address _vault,
        VaultRecord storage _record,
        uint256 _ether,
        uint256 _sharesToBurn
    ) internal {
        _record.liabilityShares = uint96(_record.liabilityShares - _sharesToBurn);
        _withdraw(_vault, _record, address(this), _ether);
        LIDO.rebalanceExternalEtherToInternal{value: _ether}();
    }

    function _rebalance(address _vault, VaultRecord storage _record, uint256 _ether) internal {
        uint256 totalValue_ = _totalValue(_record);
        if (_ether > totalValue_) revert RebalanceAmountExceedsTotalValue(totalValue_, _ether);

        uint256 sharesToBurn = _getSharesByPooledEth(_ether);
        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ < sharesToBurn) revert InsufficientSharesToBurn(_vault, liabilityShares_);

        _rebalanceEther(_vault, _record, _ether, sharesToBurn);
        _decreaseRedemptions(_vault, _ether);
        _operatorGrid().onBurnedShares(_vault, sharesToBurn);

        emit VaultRebalanced(_vault, sharesToBurn, _ether);
    }

    function _withdraw(
        address _vault,
        VaultRecord storage _record,
        address _recipient,
        uint256 _amount
    ) internal {
        _updateInOutDelta(_vault, _record, -int112(int256(_amount)));

        IStakingVault(_vault).withdraw(_recipient, _amount);
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

    /// @dev check if the share limit is within the upper bound set by MAX_RELATIVE_SHARE_LIMIT_BP
    function _maxSaneShareLimit() internal view returns (uint256) {
        return (LIDO.getTotalShares() * MAX_RELATIVE_SHARE_LIMIT_BP) / TOTAL_BASIS_POINTS;
    }

    function _totalValue(VaultRecord storage _record) internal view returns (uint256) {
        Report memory report = _record.report;
        return uint256(int256(uint256(report.totalValue)) + _record.inOutDelta.value - report.inOutDelta);
    }

    function _maxLockableValue(VaultRecord storage _record, VaultObligations storage _obligations) internal view returns (uint256) {
        return _totalValue(_record) - _obligations.unsettledLidoFees;
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
        delete $.obligations[_vault];
    }

    function _checkConnectionAndOwner(address _vault) internal view returns (VaultConnection storage connection) {
        connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();
    }

    function _checkConnection(address _vault) internal view returns (VaultConnection storage) {
        if (_vault == address(0)) revert VaultZeroAddress();

        VaultConnection storage connection = _vaultConnection(_vault);

        if (connection.vaultIndex == 0) revert NotConnectedToHub(_vault);
        if (connection.pendingDisconnect) revert VaultIsDisconnecting(_vault);

        return connection;
    }

    /// @dev Caches the inOutDelta of the latest refSlot and updates the value
    function _updateInOutDelta(address _vault, VaultRecord storage record_, int112 increment_) internal {
        Int112WithRefSlotCache memory inOutDelta_ = record_.inOutDelta;

        // cache inOutDelta if the refSlot is different from the cached refSlot
        (uint256 refSlot, ) = CONSENSUS_CONTRACT.getCurrentFrame();
        if (inOutDelta_.refSlot != refSlot) {
            inOutDelta_.refSlotValue =  inOutDelta_.value;
            inOutDelta_.refSlot = uint32(refSlot);
        }

        inOutDelta_.value += increment_;
        record_.inOutDelta = inOutDelta_;

        emit VaultInOutDeltaUpdated(_vault, inOutDelta_.value);
    }

    /**
     * @notice Updates the unsettled Lido fees obligations based on the report cumulative Lido fees
     * @param _vault The address of the vault
     * @param _reportCumulativeLidoFees The cumulative Lido fees reported in the report
     */
    function _checkAndUpdateLidoFeesObligations(
        address _vault,
        VaultObligations storage _obligations,
        uint256 _reportCumulativeLidoFees
    ) internal {
        uint256 cumulativeSettledLidoFees = _obligations.settledLidoFees;
        uint256 cumulativeLidoFees = cumulativeSettledLidoFees + _obligations.unsettledLidoFees;
        if (_reportCumulativeLidoFees < cumulativeLidoFees) {
            revert InvalidFees(_vault, _reportCumulativeLidoFees, cumulativeLidoFees);
        }

        // update unsettled lido fees
        uint256 unsettledLidoFees = _reportCumulativeLidoFees - cumulativeSettledLidoFees;
        if (unsettledLidoFees != _obligations.unsettledLidoFees) {
            _obligations.unsettledLidoFees = uint128(unsettledLidoFees);
            emit LidoFeesUpdated(_vault, unsettledLidoFees, cumulativeSettledLidoFees);
        }
    }

    /**
     * @notice Calculates a settlement plan based on vault balance and obligations
     * @param _vault The address of the vault
     * @param _record The record of the vault
     * @param _obligations The obligations of the vault to be settled
     * @return valueToRebalance The ETH amount to be rebalanced for redemptions
     * @return sharesToRebalance The shares to be rebalanced for redemptions
     * @return valueToTransferToLido The ETH amount to be sent to the Lido
     * @return unsettledRedemptions The remaining redemptions after the planned settlement
     * @return unsettledLidoFees The remaining Lido fees after the planned settlement
     * @return totalUnsettled The total ETH value of obligations remaining after the planned settlement
     */
    function _planSettlement(
        address _vault,
        VaultRecord storage _record,
        VaultObligations storage _obligations
    ) internal view returns (
        uint256 valueToRebalance,
        uint256 sharesToRebalance,
        uint256 valueToTransferToLido,
        uint256 unsettledRedemptions,
        uint256 unsettledLidoFees,
        uint256 totalUnsettled
    ) {
        (valueToRebalance, sharesToRebalance, unsettledRedemptions) = _planRebalance(_vault, _record, _obligations);
        (valueToTransferToLido, unsettledLidoFees) = _planLidoTransfer(_vault, _record, _obligations, valueToRebalance);
        totalUnsettled = unsettledRedemptions + unsettledLidoFees;
    }

    /**
     * @notice Plans the amounts and shares to rebalance for redemptions
     * @param _vault The address of the vault
     * @param _record The record of the vault
     * @param _obligations The obligations of the vault
     * @return valueToRebalance The ETH amount to be rebalanced for redemptions
     * @return sharesToRebalance The shares to be rebalanced for redemptions
     * @return unsettledRedemptions The remaining redemptions after the planned settlement
     */
    function _planRebalance(
        address _vault,
        VaultRecord storage _record,
        VaultObligations storage _obligations
    ) internal view returns (uint256 valueToRebalance, uint256 sharesToRebalance, uint256 unsettledRedemptions) {
        uint256 redemptionShares = _getSharesByPooledEth(_obligations.redemptions);
        uint256 maxRedemptionsValue = _getPooledEthBySharesRoundUp(redemptionShares);
        // if the max redemptions value is less than the redemptions, we need to round up the redemptions shares
        if (maxRedemptionsValue < _obligations.redemptions) redemptionShares += 1;

        uint256 cappedRedemptionsShares = Math256.min(_record.liabilityShares, redemptionShares);
        sharesToRebalance = Math256.min(cappedRedemptionsShares, _getSharesByPooledEth(_vault.balance));
        valueToRebalance = _getPooledEthBySharesRoundUp(sharesToRebalance);
        unsettledRedemptions = _getPooledEthBySharesRoundUp(redemptionShares - sharesToRebalance);
    }

    /**
     * @notice Plans the amount to transfer to Lido for fees
     * @param _vault The address of the vault
     * @param _record The record of the vault
     * @param _obligations The obligations of the vault
     * @param _valueToRebalance The ETH amount already allocated for rebalancing
     * @return valueToTransferToLido The ETH amount to be sent to the Lido
     * @return unsettledLidoFees The remaining Lido fees after the planned settlement
     */
    function _planLidoTransfer(
        address _vault,
        VaultRecord storage _record,
        VaultObligations storage _obligations,
        uint256 _valueToRebalance
    ) internal view returns (uint256 valueToTransferToLido, uint256 unsettledLidoFees) {
        uint256 vaultBalance = _vault.balance;
        uint256 remainingBalance = vaultBalance - _valueToRebalance;

        if (_vaultConnection(_vault).pendingDisconnect) {
            /// @dev connection deposit is unlocked, so it's available for fees
            valueToTransferToLido = Math256.min(_obligations.unsettledLidoFees, remainingBalance);
        } else {
            /// @dev connection deposit is permanently locked, so it's not available for fees
            /// @dev NB: Fees are deducted from the vault's current balance, which reduces the total value, so the
            ///          current locked value must be considered to prevent the vault from entering an unhealthy state
            uint256 lockedValue = _record.locked;
            uint256 totalValue_ = _totalValue(_record);
            uint256 unlockedValue = totalValue_ > lockedValue ? totalValue_ - lockedValue : 0;
            uint256 availableForFees = Math256.min(
                unlockedValue > _valueToRebalance ? unlockedValue - _valueToRebalance : 0,
                remainingBalance
            );
            valueToTransferToLido = Math256.min(_obligations.unsettledLidoFees, availableForFees);
        }

        unsettledLidoFees = _obligations.unsettledLidoFees - valueToTransferToLido;
    }

    /**
     * @notice Settles redemptions and Lido fee obligations for a vault
     * @param _vault The address of the vault to settle obligations for
     * @param _record The record of the vault to settle obligations for
     * @param _obligations The obligations of the vault to be settled
     * @param _allowedUnsettled The maximum allowable unsettled obligations post-settlement (triggers reverts)
     */
    function _settleObligations(
        address _vault,
        VaultRecord storage _record,
        VaultObligations storage _obligations,
        uint256 _allowedUnsettled
    ) internal {
        (
            uint256 valueToRebalance,
            uint256 sharesToRebalance,
            uint256 valueToTransferToLido,
            uint256 unsettledRedemptions,
            uint256 unsettledLidoFees,
            uint256 totalUnsettled
        ) = _planSettlement(_vault, _record, _obligations);

        // Enforce requirement for settlement completeness
        if (totalUnsettled > _allowedUnsettled) {
            revert VaultHasUnsettledObligations(_vault, totalUnsettled, _allowedUnsettled);
        }

        // Skip if no changes to obligations
        if (valueToTransferToLido == 0 && valueToRebalance == 0) {
            return;
        }

        if (valueToRebalance > 0) {
            _rebalanceEther(_vault, _record, valueToRebalance, sharesToRebalance);
        }

        if (valueToTransferToLido > 0) {
            _withdraw(_vault, _record, LIDO_LOCATOR.treasury(), valueToTransferToLido);
            _obligations.settledLidoFees += uint128(valueToTransferToLido);
        }

        _obligations.redemptions = uint128(unsettledRedemptions);
        _obligations.unsettledLidoFees = uint128(unsettledLidoFees);

        emit VaultObligationsSettled({
            vault: _vault,
            rebalanced: valueToRebalance,
            transferredToLido: valueToTransferToLido,
            unsettledRedemptions: unsettledRedemptions,
            unsettledLidoFees: unsettledLidoFees,
            settledLidoFees: _obligations.settledLidoFees
        });
    }

    function _decreaseRedemptions(address _vault, uint256 _ether) internal {
        VaultObligations storage obligations = _vaultObligations(_vault);

        if (obligations.redemptions > 0) {
            uint256 decrease = Math256.min(obligations.redemptions, _ether);
            if (decrease > 0) {
                obligations.redemptions -= uint128(decrease);
                emit RedemptionsUpdated(_vault, obligations.redemptions);
            }
        }
    }

    function _totalUnsettledObligations(VaultObligations storage _obligations) internal view returns (uint256) {
        return _obligations.unsettledLidoFees + _obligations.redemptions;
    }

    function _checkAndUpdateBeaconChainDepositsPause(
        address _vault,
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal {
        IStakingVault vault_ = IStakingVault(_vault);
        bool isHealthy = _isVaultHealthy(_connection, _record);
        bool isBeaconDepositsPaused = vault_.beaconChainDepositsPaused();

        if (_totalUnsettledObligations(_vaultObligations(_vault)) >= UNSETTLED_THRESHOLD || !isHealthy) {
            if (!isBeaconDepositsPaused) vault_.pauseBeaconChainDeposits();
        } else if (!_connection.isBeaconDepositsManuallyPaused) {
            if (isBeaconDepositsPaused) vault_.resumeBeaconChainDeposits();
        }
    }

    /// @return the amount of ether that can be instantly withdrawn from the staking vault
    /// @dev this amount already accounts locked value and unsettled obligations
    function _withdrawableValue(
        address _vault,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_record);
        uint256 lockedPlusUnsettled = _record.locked + _totalUnsettledObligations(_vaultObligations(_vault));

        return Math256.min(
            _vault.balance,
            totalValue_ > lockedPlusUnsettled ? totalValue_ - lockedPlusUnsettled : 0
        );
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

    function _getSharesByPooledEth(uint256 _ether) internal view returns (uint256) {
        return LIDO.getSharesByPooledEth(_ether);
    }

    function _getPooledEthByShares(uint256 _ether) internal view returns (uint256) {
        return LIDO.getPooledEthByShares(_ether);
    }

    function _getPooledEthBySharesRoundUp(uint256 _shares) internal view returns (uint256) {
        return LIDO.getPooledEthBySharesRoundUp(_shares);
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
        uint256 forcedRebalanceThresholdBP,
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );
    event VaultShareLimitUpdated(address indexed vault, uint256 newShareLimit);
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
    event VaultReportApplied(
        address indexed vault,
        uint256 reportTimestamp,
        uint256 reportTotalValue,
        int256 reportInOutDelta,
        uint256 reportCumulativeLidoFees,
        uint256 reportLiabilityShares
    );

    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares, uint256 lockedAmount);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned, uint256 etherWithdrawn);
    event VaultInOutDeltaUpdated(address indexed vault, int112 inOutDelta);
    event ForcedValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);

    /**
     * @notice Emitted when the manager is set
     * @param vault The address of the vault
     * @param newOwner The address of the new owner
     * @param oldOwner The address of the old owner
     */
    event VaultOwnershipTransferred(address indexed vault, address indexed newOwner, address indexed oldOwner);

    event LidoFeesUpdated(address indexed vault, uint256 unsettledLidoFees, uint256 settledLidoFees);
    event RedemptionsUpdated(address indexed vault, uint256 unsettledRedemptions);
    event RedemptionsNotSet(address indexed vault, uint256 redemptionsValue);
    event VaultObligationsSettled(
        address indexed vault,
        uint256 rebalanced,
        uint256 transferredToLido,
        uint256 unsettledRedemptions,
        uint256 unsettledLidoFees,
        uint256 settledLidoFees
    );

    // -----------------------------
    //           ERRORS
    // -----------------------------

    error ZeroIndex();
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
    error ShareLimitExceeded(address vault, uint256 shareLimit);
    error AlreadyConnected(address vault, uint256 index);
    error NotConnectedToHub(address vault);
    error NotAuthorized();
    error VaultZeroAddress();
    error ZeroArgument();
    error ShareLimitTooHigh(address vault, uint256 shareLimit, uint256 maxShareLimit);
    error ReserveRatioTooHigh(address vault, uint256 reserveRatioBP, uint256 maxReserveRatioBP);
    error ForcedRebalanceThresholdTooHigh(
        address vault,
        uint256 forcedRebalanceThresholdBP,
        uint256 maxForcedRebalanceThresholdBP
    );
    error InfraFeeTooHigh(address vault, uint256 infraFeeBP, uint256 maxInfraFeeBP);
    error LiquidityFeeTooHigh(address vault, uint256 liquidityFeeBP, uint256 maxLiquidityFeeBP);
    error ReservationFeeTooHigh(address vault, uint256 reservationFeeBP, uint256 maxReservationFeeBP);
    error InsufficientValueToMint(address vault, uint256 maxLockableValue);
    error NoLiabilitySharesShouldBeLeft(address vault, uint256 liabilityShares);
    error CodehashNotAllowed(address vault, bytes32 codehash);
    error MaxRelativeShareLimitBPTooHigh(uint256 maxRelativeShareLimitBP, uint256 totalBasisPoints);
    error InvalidFees(address vault, uint256 newFees, uint256 oldFees);
    error VaultOssified(address vault);
    error VaultInsufficientBalance(address vault, uint256 currentBalance, uint256 expectedBalance);
    error VaultInsufficientWithdrawableValue(address vault, uint256 withdrawable, uint256 requested);
    error VaultReportStale(address vault);
    error PDGNotDepositor(address vault);
    error ZeroCodehash();
    error VaultHubNotPendingOwner(address vault);
    error UnhealthyVaultCannotDeposit(address vault);
    error VaultIsDisconnecting(address vault);
    error VaultHasUnsettledObligations(address vault, uint256 unsettledObligations, uint256 allowedUnsettled);
    error PartialValidatorWithdrawalNotAllowed();
    error ForcedValidatorExitNotAllowed();
}
