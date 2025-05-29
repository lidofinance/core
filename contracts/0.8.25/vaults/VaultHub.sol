// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Math256} from "contracts/common/lib/Math256.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {OperatorGrid} from "./OperatorGrid.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILido} from "../interfaces/ILido.sol";
import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";
import {LazyOracle} from "./LazyOracle.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "./interfaces/IPredepositGuarantee.sol";
import {IConsensusContract} from "./interfaces/IConsensusContract.sol";

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
        /// @notice cached refSlot number of the latest report
        uint128 cachedRefSlot;
        /// @notice cached inOutDelta of the latest report
        int128 cachedInOutDelta;
        // ### 5th slot
        /// @notice fee shares charged for the vault
        uint96 feeSharesCharged;
    }

    struct Report {
        /// @notice total value of the vault
        uint128 totalValue;
        /// @notice inOutDelta of the report
        int128 inOutDelta;
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
    /// @notice amount of ETH that is locked on the vault on connect and can be withdrawn on disconnect only
    uint256 public constant CONNECT_DEPOSIT = 1 ether;
    /// @notice The time delta for report freshness check
    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;

    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    /// @notice length of the validator pubkey in bytes
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    /// @notice codehash of the account with no code
    bytes32 private constant EMPTY_CODEHASH = keccak256("");

    /// @notice minimum gas overhead required for withdraw/fund/rebalance operations
    uint256 internal constant MIN_GAS = 20_000;

    // -----------------------------
    //           IMMUTABLES
    // -----------------------------

    /// @notice limit for a single vault share limit relative to Lido TVL in basis points
    uint256 public immutable MAX_RELATIVE_SHARE_LIMIT_BP;

    ILido public immutable LIDO;
    ILidoLocator public immutable LIDO_LOCATOR;
    IConsensusContract public immutable CONSENSUS_CONTRACT;

    /// @param _locator Lido Locator contract
    /// @param _lido Lido stETH contract
    /// @param _maxRelativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(ILidoLocator _locator, ILido _lido, IConsensusContract _consensusContract, uint256 _maxRelativeShareLimitBP) {
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

    /// @notice modifier to check if the gas is enough to cache inOutDelta in fund/withdraw/rebalance operations
    modifier requireMinGas() {
        _;
        if (gasleft() < MIN_GAS) revert NeedMoreGas(MIN_GAS, gasleft());
    }

    /// @dev used to perform rebalance operations
    receive() external payable {}

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

    /// @return true if the vault is connected to the hub
    function isVaultConnected(address _vault) external view returns (bool) {
        return _vaultConnection(_vault).vaultIndex != 0;
    }

    /// @return total value of the vault (as of the latest report received)
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
        if (_infraFeeBP > TOTAL_BASIS_POINTS) revert InfraFeeTooHigh(_vault, _infraFeeBP, TOTAL_BASIS_POINTS);
        if (_liquidityFeeBP > TOTAL_BASIS_POINTS) revert LiquidityFeeTooHigh(_vault, _liquidityFeeBP, TOTAL_BASIS_POINTS);
        if (_reservationFeeBP > TOTAL_BASIS_POINTS) revert ReservationFeeTooHigh(_vault, _reservationFeeBP, TOTAL_BASIS_POINTS);

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
    /// @param _reportFeeSharesCharged the feeSharesCharged of the vault
    /// @param _reportLiabilityShares the liabilityShares of the vault
    function applyVaultReport(
        address _vault,
        uint64 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportFeeSharesCharged,
        uint256 _reportLiabilityShares
    ) external whenResumed {
        if (msg.sender != address(_lazyOracle())) revert NotAuthorized();

        VaultConnection storage connection = _vaultConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        // here we don't check the reported values but rely on the oracle to preserve vault indexes
        if (connection.pendingDisconnect) {
            IStakingVault(_vault).transferOwnership(connection.owner);
            // we rely on the oracle to preserve vault index
            _deleteVault(_vault, connection);

            emit VaultDisconnectCompleted(_vault);
        } else {
            uint256 currentFeeSharesCharged = record.feeSharesCharged;
            if (_reportFeeSharesCharged < currentFeeSharesCharged) {
                revert InvalidFees(_vault, _reportFeeSharesCharged, currentFeeSharesCharged);
            }
            record.liabilityShares += uint96(_reportFeeSharesCharged - currentFeeSharesCharged);
            record.feeSharesCharged = uint96(_reportFeeSharesCharged);

            uint256 newLiabilityShares = Math256.max(record.liabilityShares, _reportLiabilityShares);
            // locked ether can only be increased asynchronously once the oracle settled the new floor value
            // as of reference slot to prevent slashing upsides in between the report gathering and delivering
            uint256 lockedEther = Math256.max(
                _getPooledEthBySharesRoundUp(newLiabilityShares) * TOTAL_BASIS_POINTS
                    / (TOTAL_BASIS_POINTS - connection.reserveRatioBP),
                connection.pendingDisconnect ? 0 : CONNECT_DEPOSIT
            );

            record.report = Report(
                uint128(_reportTotalValue),
                int128(_reportInOutDelta)
            );
            record.reportTimestamp = _reportTimestamp;
            record.locked = uint128(lockedEther);

            IStakingVault vault_ = IStakingVault(_vault);
            if (!_isVaultHealthy(connection, record) && !vault_.beaconChainDepositsPaused()) {
                vault_.pauseBeaconChainDeposits();
            }

            emit VaultReportApplied({
                vault: _vault,
                reportTimestamp: _reportTimestamp,
                reportTotalValue: _reportTotalValue,
                reportInOutDelta: _reportInOutDelta,
                reportFeeSharesCharged: _reportFeeSharesCharged,
                reportLiabilityShares: _reportLiabilityShares
            });
        }
    }

    function mintVaultsTreasuryFeeShares(uint256 _amountOfShares) external {
        if (msg.sender != LIDO_LOCATOR.accounting()) revert NotAuthorized();

        LIDO.mintExternalShares(LIDO_LOCATOR.treasury(), _amountOfShares);
    }

    /// @notice transfer the ownership of the vault to a new owner
    /// without disconnecting it from the hub
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
    function fund(address _vault) external payable whenResumed requireMinGas {
        _checkConnectionAndOwner(_vault);

        VaultRecord storage record = _vaultRecord(_vault);
        
        _cacheInOutDelta(record);

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
    function withdraw(address _vault, address _recipient, uint256 _ether) external whenResumed requireMinGas {
        _checkConnectionAndOwner(_vault);

        VaultRecord storage record = _vaultRecord(_vault);
        if (!_isReportFresh(record)) revert VaultReportStale(_vault);

        uint256 unlocked_ = _unlocked(record);
        if (_ether > unlocked_) revert InsufficientUnlocked(unlocked_, _ether);

        _withdraw(_vault, record, _recipient, _ether);

        if (_totalValue(record) < record.locked) revert TotalValueBelowLockedAmount();
    }

    /// @notice Rebalances StakingVault by withdrawing ether to VaultHub
    /// @param _vault vault address
    /// @param _ether amount of ether to rebalance
    /// @dev msg.sender should be vault's owner
    function rebalance(address _vault, uint256 _ether) external whenResumed requireMinGas {
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

        uint256 totalValue_ = _totalValue(record);
        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - connection.reserveRatioBP;
        uint256 maxMintableEther = (totalValue_ * maxMintableRatioBP) / TOTAL_BASIS_POINTS;
        uint256 stETHAfterMint = _getPooledEthBySharesRoundUp(vaultSharesAfterMint);
        if (stETHAfterMint > maxMintableEther) {
            revert InsufficientTotalValueToMint(_vault, totalValue_);
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
        _checkConnectionAndOwner(_vault);

        IStakingVault(_vault).pauseBeaconChainDeposits();
    }

    /// @notice resumes beacon chain deposits for the vault
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    function resumeBeaconChainDeposits(address _vault) external {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        if (!_isVaultHealthy(connection, _vaultRecord(_vault))) revert UnhealthyVaultCannotDeposit(_vault);

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
    /// @param _pubkeys public keys of the validators to exit
    /// @param _refundRecipient address that will receive the refund for transaction costs
    /// @dev    When the vault becomes unhealthy, anyone can force its validators to exit the beacon chain
    ///         This returns the vault's deposited ETH back to vault's balance and allows to rebalance the vault
    function forceValidatorExit(address _vault, bytes calldata _pubkeys, address _refundRecipient) external payable {
        VaultConnection storage connection = _checkConnectionAndOwner(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        if (_isVaultHealthy(connection, record)) revert AlreadyHealthy(_vault);

        uint64[] memory amounts = new uint64[](0);

        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, amounts, _refundRecipient);

        emit ForcedValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
    }

    /// @notice Permissionless rebalance for unhealthy vaults
    /// @param _vault vault address
    /// @dev rebalance all available amount of ether until the vault is healthy
    function forceRebalance(address _vault) external requireMinGas {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _vaultRecord(_vault);

        uint256 fullRebalanceAmount = _rebalanceShortfall(connection, record);
        if (fullRebalanceAmount == 0) revert AlreadyHealthy(_vault);

        // TODO: add some gas compensation here
        _rebalance(_vault, record, Math256.min(fullRebalanceAmount, _vault.balance));
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
        if (_infraFeeBP > TOTAL_BASIS_POINTS) revert InfraFeeTooHigh(_vault, _infraFeeBP, TOTAL_BASIS_POINTS);
        if (_liquidityFeeBP > TOTAL_BASIS_POINTS) revert LiquidityFeeTooHigh(_vault, _liquidityFeeBP, TOTAL_BASIS_POINTS);
        if (_reservationFeeBP > TOTAL_BASIS_POINTS) revert ReservationFeeTooHigh(_vault, _reservationFeeBP, TOTAL_BASIS_POINTS);

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
            inOutDelta: report.inOutDelta,
            cachedInOutDelta: 0,
            cachedRefSlot: 0,
            feeSharesCharged: uint96(0)
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
            reservationFeeBP: uint16(_reservationFeeBP)
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

        _connection.pendingDisconnect = true;
    }

    function _rebalance(address _vault, VaultRecord storage _record, uint256 _ether) internal {
        uint256 totalValue_ = _totalValue(_record);
        if (_ether > totalValue_) revert RebalanceAmountExceedsTotalValue(totalValue_, _ether);

        uint256 sharesToBurn = LIDO.getSharesByPooledEth(_ether);
        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ < sharesToBurn) revert InsufficientSharesToBurn(_vault, liabilityShares_);

        _record.liabilityShares = uint96(liabilityShares_ - sharesToBurn);
        _withdraw(_vault, _record, address(this), _ether);
        LIDO.rebalanceExternalEtherToInternal{value: _ether}();

        emit VaultRebalanced(_vault, sharesToBurn, _ether);
    }

    function _withdraw(
        address _vault,
        VaultRecord storage _record,
        address _recipient,
        uint256 _amount
    ) internal {
        _cacheInOutDelta(_record);

        int128 inOutDelta_ = _record.inOutDelta - int128(int256(_amount));
        _record.inOutDelta = inOutDelta_;

        IStakingVault(_vault).withdraw(_recipient, _amount);

        emit VaultInOutDeltaUpdated(_vault, inOutDelta_);
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
        return _getPooledEthBySharesRoundUp(_vaultLiabilityShares) >
            _vaultTotalValue * (TOTAL_BASIS_POINTS - _thresholdBP) / TOTAL_BASIS_POINTS;
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

    function _cacheInOutDelta(VaultRecord storage _record) internal {
        (uint256 refSlot, ) = CONSENSUS_CONTRACT.getCurrentFrame();
        if (_record.cachedRefSlot != refSlot) {
            _record.cachedInOutDelta = _record.inOutDelta;
            _record.cachedRefSlot = uint128(refSlot);
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

    function _operatorGrid() internal view returns (OperatorGrid) {
        return OperatorGrid(LIDO_LOCATOR.operatorGrid());
    }

    function _lazyOracle() internal view returns (LazyOracle) {
        return LazyOracle(LIDO_LOCATOR.lazyOracle());
    }

    function _getPooledEthBySharesRoundUp(uint256 _shares) internal view returns (uint256) {
        return LIDO.getPooledEthBySharesRoundUp(_shares);
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
    event VaultReportApplied(
        address indexed vault,
        uint256 reportTimestamp,
        uint256 reportTotalValue,
        int256 reportInOutDelta,
        uint256 reportFeeSharesCharged,
        uint256 reportLiabilityShares
    );

    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares, uint256 lockedAmount);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned, uint256 etherWithdrawn);
    event VaultInOutDeltaUpdated(address indexed vault, int128 inOutDelta);
    event ForcedValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);

    /**
     * @notice Emitted when the manager is set
     * @param vault The address of the vault
     * @param newOwner The address of the new owner
     * @param oldOwner The address of the old owner
     */
    event VaultOwnershipTransferred(address indexed vault, address indexed newOwner, address indexed oldOwner);

    error ZeroIndex();

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
    error InsufficientTotalValueToMint(address vault, uint256 totalValue);
    error NoLiabilitySharesShouldBeLeft(address vault, uint256 liabilityShares);
    error CodehashNotAllowed(address vault, bytes32 codehash);
    error MaxRelativeShareLimitBPTooHigh(uint256 maxRelativeShareLimitBP, uint256 totalBasisPoints);
    error InvalidFees(address vault, uint256 newFees, uint256 oldFees);
    error VaultOssified(address vault);
    error VaultInsufficientBalance(address vault, uint256 currentBalance, uint256 expectedBalance);
    error VaultReportStale(address vault);
    error PDGNotDepositor(address vault);
    error ZeroCodehash();
    error VaultHubNotPendingOwner(address vault);
    error UnhealthyVaultCannotDeposit(address vault);
    error VaultIsDisconnecting(address vault);
    error PartialValidatorWithdrawalNotAllowed();
    error NeedMoreGas(uint256 minGas, uint256 gasLeft);
}
