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

/// @notice VaultHub is a contract that manages StakingVaults connected to the Lido protocol
/// It allows to connect and disconnect vaults, mint and burn stETH using vaults as collateral
/// Also, it passes the report from the accounting oracle to the vaults and charges fees
/// @author folkyatina
contract VaultHub is PausableUntilWithRoles {

    // -----------------------------
    //           STORAGE STRUCTS
    // -----------------------------
    /// @custom:storage-location erc7201:Vaults
    struct Storage {
        /// @notice vault proxy contract codehashes allowed for connecting
        mapping(bytes32 codehash => bool allowed) vaultProxyCodehash;
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
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
    }

    struct VaultRecord {
        // ### 1st slot
        /// @notice latest report for the vault
        Report report;
        // ### 2nd slot
        /// @notice locked amount of ether for the vault
        uint128 locked;
        /// @notice liability shares of the vault
        uint96 liabilityShares;
        // ### 3rd slot
        /// @notice timestamp of the latest report
        uint64 reportTimestamp;
        /// @notice inOutDelta of the latest report
        int128 inOutDelta;
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
    /// @notice role that allows to add factories and vault implementations to hub
    bytes32 public constant VAULT_REGISTRY_ROLE = keccak256("vaults.VaultHub.VaultRegistryRole");
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

    // -----------------------------
    //           IMMUTABLES
    // -----------------------------

    /// @notice limit for a single vault share limit relative to Lido TVL in basis points
    uint256 public immutable RELATIVE_SHARE_LIMIT_BP;

    ILido public immutable LIDO;
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @param _locator Lido Locator contract
    /// @param _lido Lido stETH contract
    /// @param _relativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(ILidoLocator _locator, ILido _lido, uint256 _relativeShareLimitBP) {
        if (_relativeShareLimitBP == 0) revert ZeroArgument();
        if (_relativeShareLimitBP > TOTAL_BASIS_POINTS)
            revert RelativeShareLimitBPTooHigh(_relativeShareLimitBP, TOTAL_BASIS_POINTS);

        LIDO_LOCATOR = _locator;
        LIDO = _lido;
        RELATIVE_SHARE_LIMIT_BP = _relativeShareLimitBP;

        _disableInitializers();
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

    /// @notice Set if a vault proxy codehash is allowed to be connected to the hub
    /// @param _codehash vault proxy codehash
    /// @param _allow true to add, false to remove
    function setVaultProxyCodehashAllowance(bytes32 _codehash, bool _allow) external onlyRole(VAULT_REGISTRY_ROLE) {
        if (_codehash == bytes32(0)) revert ZeroArgument();
        if (_codehash == EMPTY_CODEHASH) revert VaultProxyZeroCodehash();

        Storage storage $ = _storage();
        $.vaultProxyCodehash[_codehash] = _allow;

        emit VaultProxyCodehashUpdated(_codehash, _allow);
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
        return _storage().connections[_vault];
    }

    /// @return the accounting record for the given vault
    /// @dev it returns empty struct if the vault is not connected to the hub
    function vaultRecord(address _vault) external view returns (VaultRecord memory) {
        return _storage().records[_vault];
    }

    /// @return total value of the vault (as of the latest report received)
    /// @dev returns 0 if the vault is not connected
    function totalValue(address _vault) external view returns (uint256) {
        return _totalValue(_storage().records[_vault]);
    }

    /// @return liability shares of the vault
    /// @dev returns 0 if the vault is not connected
    function liabilityShares(address _vault) external view returns (uint256) {
        return _storage().records[_vault].liabilityShares;
    }

    /// @return locked amount of ether for the vault
    /// @dev returns 0 if the vault is not connected
    function locked(address _vault) external view returns (uint256) {
        return _storage().records[_vault].locked;
    }

    /// @return amount of ether that is part of the vault's total value and is not locked as a collateral
    /// @dev returns 0 if the vault is not connected
    function unlocked(address _vault) external view returns (uint256) {
        return _unlocked(_storage().records[_vault]);
    }

    /// @return the latest report for the vault
    /// @dev returns empty struct if the vault is not connected
    function latestReport(address _vault) external view returns (Report memory) {
        return _storage().records[_vault].report;
    }

    /// @return true if the report for the vault is fresh, false otherwise
    /// @dev returns false if the vault is not connected
    function isReportFresh(address _vault) external view returns (bool) {
        return _isReportFresh(_storage().records[_vault]);
    }

    /// @notice checks if the vault is healthy by comparing its total value after applying rebalance threshold
    ///         against current liability shares
    /// @param _vault vault address
    /// @return true if vault is healthy, false otherwise
    /// @dev returns true if the vault is not connected
    function isVaultHealthy(address _vault) external view returns (bool) {
        return _isVaultHealthy(_storage().connections[_vault], _storage().records[_vault]);
    }

    /// @notice calculate ether amount to make the vault healthy using rebalance
    /// @param _vault vault address
    /// @return amount to rebalance  or UINT256_MAX if it's impossible to make the vault healthy using rebalance
    /// @dev returns 0 if the vault is not connected
    function rebalanceShortfall(address _vault) external view returns (uint256) {
        Storage storage $ = _storage();
        return _rebalanceShortfall(
            $.connections[_vault],
            $.records[_vault]
        );
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    /// @dev vault should have transferred ownership to the VaultHub contract
    function connectVault(address _vault) external whenResumed {
        if (_vault == address(0)) revert VaultZeroAddress();

        IStakingVault vault_ = IStakingVault(_vault);
        if (vault_.pendingOwner() != address(this)) revert VaultHubNotPendingOwner(_vault);
        if (vault_.isOssified()) revert VaultOssified(_vault);
        if (vault_.depositor() != address(this)) revert VaultHubMustBeDepositor(_vault);

        OperatorGrid operatorGrid_ = OperatorGrid(LIDO_LOCATOR.operatorGrid());
        (
            address nodeOperatorFixedInGrid, // tierId
            ,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 treasuryFeeBP
        ) = operatorGrid_.vaultInfo(_vault);

        address nodeOperatorFixedInVault = IStakingVault(_vault).nodeOperator();
        if (
            nodeOperatorFixedInVault != operatorGrid_.DEFAULT_TIER_OPERATOR() &&
            nodeOperatorFixedInVault != nodeOperatorFixedInGrid
        ) revert InvalidOperator();

        _connectVault(_vault,
            shareLimit,
            reserveRatioBP,
            forcedRebalanceThresholdBP,
            treasuryFeeBP
        );

        IStakingVault(_vault).acceptOwnership();

        emit VaultConnected(_vault, shareLimit, reserveRatioBP, forcedRebalanceThresholdBP, treasuryFeeBP);
    }

    /// @notice updates share limit for the vault
    /// Setting share limit to zero actually pause the vault's ability to mint
    /// @param _vault vault address
    /// @param _shareLimit new share limit
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function updateShareLimit(address _vault, uint256 _shareLimit) external onlyRole(VAULT_MASTER_ROLE) {
        if (_shareLimit > _maxSaneShareLimit()) revert ShareLimitTooHigh(_vault, _shareLimit, _maxSaneShareLimit());

        VaultConnection storage connection = _checkConnection(_vault);

        connection.shareLimit = uint96(_shareLimit);

        emit VaultShareLimitUpdated(_vault, _shareLimit);
    }

    /// @notice updates the vault's connection parameters
    /// @dev Reverts if the vault is not healthy as of latest report
    /// @param _vault vault address
    /// @param _shareLimit new share limit
    /// @param _reserveRatioBP new reserve ratio
    /// @param _forcedRebalanceThresholdBP new forced rebalance threshold
    /// @param _treasuryFeeBP new treasury fee
    function updateConnection(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _treasuryFeeBP
    ) external {
        if (msg.sender != LIDO_LOCATOR.operatorGrid()) revert NotAuthorized();
        if (_shareLimit > _maxSaneShareLimit()) revert ShareLimitTooHigh(_vault, _shareLimit, _maxSaneShareLimit());

        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _storage().records[_vault];

        uint256 totalValue_ = _totalValue(record);
        uint256 liabilityShares_ = record.liabilityShares;

        // check healthy with new rebalance threshold
        if (_isThresholdBreached(totalValue_, liabilityShares_, _reserveRatioBP))
            revert VaultMintingCapacityExceeded(_vault, totalValue_, liabilityShares_, _reserveRatioBP);

        connection.shareLimit = uint96(_shareLimit);
        connection.reserveRatioBP = uint16(_reserveRatioBP);
        connection.forcedRebalanceThresholdBP = uint16(_forcedRebalanceThresholdBP);
        connection.treasuryFeeBP = uint16(_treasuryFeeBP);

        emit VaultConnectionUpdated(_vault, _shareLimit, _reserveRatioBP, _forcedRebalanceThresholdBP, _treasuryFeeBP);
    }

    /// @notice force disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    /// @dev vault's `liabilityShares` should be zero
    function disconnect(address _vault) external onlyRole(VAULT_MASTER_ROLE) {
        _initiateDisconnection(_vault, _checkConnection(_vault), _storage().records[_vault]);

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
    ) external {
        if (msg.sender != LIDO_LOCATOR.lazyOracle()) revert NotAuthorized();

        Storage storage $ = _storage();

        VaultConnection storage connection = $.connections[_vault];
        VaultRecord storage record = $.records[_vault];

        if (connection.pendingDisconnect) {
            IStakingVault(_vault).transferOwnership(connection.owner);
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
                LIDO.getPooledEthBySharesRoundUp(newLiabilityShares) * TOTAL_BASIS_POINTS / (TOTAL_BASIS_POINTS - connection.reserveRatioBP),
                connection.pendingDisconnect ? 0 : CONNECT_DEPOSIT
            );

            record.report = Report(
                uint128(_reportTotalValue),
                int128(_reportInOutDelta)
            );
            record.reportTimestamp = _reportTimestamp;
            record.locked = uint128(lockedEther);

            IStakingVault vault_ = IStakingVault(_vault);
            if (!_isVaultHealthy(connection, record) && !vault_.beaconChainDepositsPaused()) vault_.pauseBeaconChainDeposits();

            emit VaultReportApplied(_vault, _reportTimestamp, _reportTotalValue, _reportInOutDelta, _reportFeeSharesCharged, _reportLiabilityShares);
        }

    }

    function mintVaultsTreasuryFeeShares(uint256 _amountOfShares) external {
        if (msg.sender != LIDO_LOCATOR.accounting()) revert NotAuthorized();

        LIDO.mintExternalShares(LIDO_LOCATOR.treasury(), _amountOfShares);
    }

    function setVaultOwner(address _vault, address _owner) external {
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        connection.owner = _owner;

        emit VaultOwnerSet(_vault, _owner);
    }

    /// @notice disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    /// @dev vault's `liabilityShares` should be zero
    function voluntaryDisconnect(address _vault) external whenResumed {
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        _initiateDisconnection(_vault, connection, _storage().records[_vault]);

        emit VaultDisconnectInitiated(_vault);
    }

    function fund(address _vault) external payable {
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        VaultRecord storage record = _storage().records[_vault];
        record.inOutDelta += int128(int256(msg.value));

        (bool success, ) = _vault.call{value: msg.value}("");
        if (!success) revert TransferFailed(_vault, msg.value);

        emit VaultFunded(_vault, msg.value);
    }

    function withdraw(address _vault, address _recipient, uint256 _ether) external {
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        VaultRecord storage record = _storage().records[_vault];
        if (!_isReportFresh(record)) revert VaultReportStaled(_vault);

        uint256 unlocked_ = _unlocked(record);
        if (_ether > unlocked_) revert InsufficientUnlocked(unlocked_, _ether);

        _withdrawFromVault(_vault, record, _recipient, _ether);

        if (_totalValue(record) < record.locked) revert TotalValueBelowLockedAmount();

        emit VaultWithdrawn(_vault, _recipient, _ether);
    }

    /**
     * @notice Rebalances StakingVault by withdrawing ether to VaultHub
     * @param _vault vault address
     * @param _ether amount of ether to rebalance
     */
    function rebalance(address _vault, uint256 _ether) external {
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        VaultRecord storage record = _storage().records[_vault];

        _rebalance(_vault, record, _ether);
    }

    /// @notice mint StETH shares backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _amountOfShares amount of stETH shares to mint
    function mintShares(address _vault, address _recipient, uint256 _amountOfShares) external whenResumed {
        if (_recipient == address(0)) revert ZeroArgument();
        if (_amountOfShares == 0) revert ZeroArgument();

        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        VaultRecord storage record = _storage().records[_vault];

        uint256 vaultSharesAfterMint = record.liabilityShares + _amountOfShares;
        if (vaultSharesAfterMint > connection.shareLimit) revert ShareLimitExceeded(_vault, connection.shareLimit);

        if (!_isReportFresh(record)) revert VaultReportStaled(_vault);

        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - connection.reserveRatioBP;
        uint256 maxMintableEther = (_totalValue(record) * maxMintableRatioBP) / TOTAL_BASIS_POINTS;
        uint256 stETHAfterMint = LIDO.getPooledEthBySharesRoundUp(vaultSharesAfterMint);
        if (stETHAfterMint > maxMintableEther) {
            revert InsufficientTotalValueToMint(_vault, _totalValue(record));
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 etherToLock = (stETHAfterMint * TOTAL_BASIS_POINTS) / maxMintableRatioBP;

        if (etherToLock > record.locked) {
            record.locked = uint128(etherToLock);
        }

        record.liabilityShares = uint96(vaultSharesAfterMint);
        LIDO.mintExternalShares(_recipient, _amountOfShares);
        OperatorGrid(LIDO_LOCATOR.operatorGrid()).onMintedShares(_vault, _amountOfShares);

        emit MintedSharesOnVault(_vault, _amountOfShares);
    }

    /// @notice burn steth shares from the balance of the VaultHub contract
    /// @param _vault vault address
    /// @param _amountOfShares amount of shares to burn
    /// @dev msg.sender should be vault's owner
    /// @dev this function is designed to be used by the smart contract, for EOA see `transferAndBurnShares`
    function burnShares(address _vault, uint256 _amountOfShares) public whenResumed {
        if (_amountOfShares == 0) revert ZeroArgument();
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        VaultRecord storage record = _storage().records[_vault];

        uint256 liabilityShares_ = record.liabilityShares;
        if (liabilityShares_ < _amountOfShares) revert InsufficientSharesToBurn(_vault, liabilityShares_);

        record.liabilityShares = uint96(liabilityShares_ - _amountOfShares);

        LIDO.burnExternalShares(_amountOfShares);
        OperatorGrid(LIDO_LOCATOR.operatorGrid()).onBurnedShares(_vault, _amountOfShares);

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
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        IStakingVault(_vault).pauseBeaconChainDeposits();
    }

    /// @notice resumes beacon chain deposits for the vault
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    function resumeBeaconChainDeposits(address _vault) external {
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();
        if (!_isVaultHealthy(connection, _storage().records[_vault])) revert UnhealthyVaultCannotDeposit(_vault);

        IStakingVault(_vault).resumeBeaconChainDeposits();
    }

    /// @notice deposits to the beacon chain
    /// @param _vault vault address
    /// @param _deposits array of deposits data structures
    /// @dev msg.sender should be predeposit guarantee
    function depositToBeaconChain(address _vault, IStakingVault.Deposit[] calldata _deposits) external {
        if (msg.sender != LIDO_LOCATOR.predepositGuarantee()) revert NotAuthorized();

        IStakingVault(_vault).depositToBeaconChain(_deposits);
    }

    /// @notice Emits a request event for the node operator to perform validator exit
    /// @param _vault vault address
    /// @param _pubkeys array of public keys of the validators to exit
    /// @dev msg.sender should be vault's owner
    function requestValidatorExit(address _vault, bytes calldata _pubkeys) external {
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();

        IStakingVault(_vault).requestValidatorExit(_pubkeys);
    }

    /// @notice Triggers validator exit for the vault using EIP-7002
    /// @param _vault vault address
    /// @param _pubkeys array of public keys of the validators to exit
    /// @dev msg.sender should be vault's owner
    function triggerValidatorWithdrawals(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        VaultConnection storage connection = _checkConnection(_vault);
        if (msg.sender != connection.owner) revert NotAuthorized();
        VaultRecord storage record = _storage().records[_vault];

        // disallow partial validator withdrawals when the vault value does not cover the locked amount,
        // in order to prevent the vault owner from jamming the consensus layer withdrawal queue
        // delaying the forceful validator exits required for rebalancing the vault
        if (!_isVaultHealthy(connection, record)) {
            for (uint256 i = 0; i < _amounts.length; i++) {
                if (_amounts[i] > 0) revert PartialValidatorWithdrawalNotAllowed();
            }
        }

        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    /// @notice Triggers validator exit for the vault using EIP-7002 permissionlessly if the vault is unhealthy
    /// @param _vault address of the vault to exit validators from
    /// @param _pubkeys public keys of the validators to exit
    /// @param _refundRecipient address that will receive the refund for transaction costs
    /// @dev    When the vault becomes unhealthy, anyone can force its validators to exit the beacon chain
    ///         This returns the vault's deposited ETH back to vault's balance and allows to rebalance the vault
    function forceValidatorExit(address _vault, bytes calldata _pubkeys, address _refundRecipient) external payable {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _storage().records[_vault];

        if (_isVaultHealthy(connection, record)) revert AlreadyHealthy(_vault);

        uint64[] memory amounts = new uint64[](_pubkeys.length / PUBLIC_KEY_LENGTH);

        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, amounts, _refundRecipient);

        emit ForcedValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
    }

    /// @notice Permissionless rebalance for unhealthy vaults
    /// @param _vault vault address
    /// @dev rebalance all available amount of ether until the vault is healthy
    function forceRebalance(address _vault) external {
        VaultConnection storage connection = _checkConnection(_vault);
        VaultRecord storage record = _storage().records[_vault];

        uint256 fullRebalanceAmount = _rebalanceShortfall(connection, record);
        if (fullRebalanceAmount == 0) revert AlreadyHealthy(_vault);

        // TODO: add some gas compensation here
        _rebalance(_vault, record, Math256.min(fullRebalanceAmount, _vault.balance));
    }

    function _connectVault(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _treasuryFeeBP
    ) internal {
        if (_reserveRatioBP == 0) revert ZeroArgument();
        if (_reserveRatioBP > TOTAL_BASIS_POINTS)
            revert ReserveRatioTooHigh(_vault, _reserveRatioBP, TOTAL_BASIS_POINTS);
        if (_forcedRebalanceThresholdBP == 0) revert ZeroArgument();
        if (_forcedRebalanceThresholdBP > _reserveRatioBP)
            revert ForcedRebalanceThresholdTooHigh(_vault, _forcedRebalanceThresholdBP, _reserveRatioBP);
        if (_treasuryFeeBP > TOTAL_BASIS_POINTS) revert TreasuryFeeTooHigh(_vault, _treasuryFeeBP, TOTAL_BASIS_POINTS);
        if (_shareLimit > _maxSaneShareLimit()) revert ShareLimitTooHigh(_vault, _shareLimit, _maxSaneShareLimit());

        Storage storage $ = _storage();
        if ($.connections[_vault].vaultIndex != 0) revert AlreadyConnected(_vault, $.connections[_vault].vaultIndex);
        if (!$.vaultProxyCodehash[address(_vault).codehash]) revert VaultProxyNotAllowed(_vault, address(_vault).codehash);
        if (_vault.balance < CONNECT_DEPOSIT) revert VaultInsufficientBalance(_vault, _vault.balance, CONNECT_DEPOSIT);

        Report memory report = Report(
            uint128(_vault.balance), // totalValue
            int128(int256(_vault.balance)) // inOutDelta
        );

        VaultConnection memory connection = VaultConnection(
            IStakingVault(_vault).owner(),
            uint96(_shareLimit),
            0, // vaultIndex
            false, // pendingDisconnect
            uint16(_reserveRatioBP),
            uint16(_forcedRebalanceThresholdBP),
            uint16(_treasuryFeeBP)
        );

        VaultRecord memory record = VaultRecord(
            report,
            uint128(CONNECT_DEPOSIT), // locked
            0, // liabilityShares
            uint64(block.timestamp), // reportTimestamp
            report.inOutDelta, // inOutDelta
            uint96(0) // feeSharesCharged
        );

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
        if (_ether == 0) revert ZeroArgument();
        if (_ether > _vault.balance) revert InsufficientBalance(_vault.balance, _ether);

        uint256 totalValue_ = _totalValue(_record);
        if (_ether > totalValue_) revert RebalanceAmountExceedsTotalValue(totalValue_, _ether);

        uint256 sharesToBurn = LIDO.getSharesByPooledEth(_ether);
        uint256 liabilityShares_ = _record.liabilityShares;
        if (liabilityShares_ < sharesToBurn) revert InsufficientSharesToBurn(msg.sender, liabilityShares_);

        _record.liabilityShares = uint96(liabilityShares_ - sharesToBurn);
        _withdrawFromVault(_vault, _record, address(this), _ether);
        LIDO.rebalanceExternalEtherToInternal{value: _ether}();

        emit VaultRebalanced(_vault, sharesToBurn);
    }

    function _withdrawFromVault(
        address _vault,
        VaultRecord storage _record,
        address _recipient,
        uint256 _amount
    ) internal {
        _record.inOutDelta -= int128(int256(_amount));
        IStakingVault(_vault).withdraw(_recipient, _amount);
    }

    function _rebalanceShortfall(
        VaultConnection storage _connection,
        VaultRecord storage _record
    ) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_record);
        bool isHealthy = _isVaultHealthy(_connection, _record);

        // Health vault do not need to rebalance
        if (isHealthy) {
            return 0;
        }

        uint256 liabilityStETH = LIDO.getPooledEthBySharesRoundUp(_record.liabilityShares);
        uint256 reserveRatioBP = _connection.reserveRatioBP;
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);

        // Impossible to rebalance a vault with deficit
        if (liabilityStETH >= totalValue_) {
            // return MAX_UINT_256
            return type(uint256).max;
        }

        // (liabilityStETH - X) / (vault.totalValue() - X) = maxMintableRatio / TOTAL_BASIS_POINTS
        // (liabilityStETH - X) * TOTAL_BASIS_POINTS = (vault.totalValue() - X) * maxMintableRatio
        // liabilityStETH * TOTAL_BASIS_POINTS - X * TOTAL_BASIS_POINTS = totalValue * maxMintableRatio - X * maxMintableRatio
        // X * maxMintableRatio - X * TOTAL_BASIS_POINTS = totalValue * maxMintableRatio - liabilityStETH * TOTAL_BASIS_POINTS
        // X * (maxMintableRatio - TOTAL_BASIS_POINTS) = vault.totalValue() * maxMintableRatio - liabilityStETH * TOTAL_BASIS_POINTS
        // X = (vault.totalValue() * maxMintableRatio - liabilityStETH * TOTAL_BASIS_POINTS) / (maxMintableRatio - TOTAL_BASIS_POINTS)
        // X = (liabilityStETH * TOTAL_BASIS_POINTS - vault.totalValue() * maxMintableRatio) / (TOTAL_BASIS_POINTS - maxMintableRatio)
        // reserveRatio = TOTAL_BASIS_POINTS - maxMintableRatio
        // X = (liabilityStETH * TOTAL_BASIS_POINTS - totalValue * maxMintableRatio) / reserveRatio

        return (liabilityStETH * TOTAL_BASIS_POINTS - totalValue_ * maxMintableRatio) / reserveRatioBP;
    }

    /// @dev check if the share limit is within the upper bound set by RELATIVE_SHARE_LIMIT_BP
    function _maxSaneShareLimit() internal view returns (uint256) {
        return (LIDO.getTotalShares() * RELATIVE_SHARE_LIMIT_BP) / TOTAL_BASIS_POINTS;
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
        uint256 latestReportTimestamp = LazyOracle(LIDO_LOCATOR.lazyOracle()).latestReportTimestamp();
        return
            latestReportTimestamp == _record.reportTimestamp &&
            block.timestamp - latestReportTimestamp < REPORT_FRESHNESS_DELTA;
    }

    function _isVaultHealthy(VaultConnection storage _connection, VaultRecord storage _record) internal view returns (bool) {
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
        return LIDO.getPooledEthBySharesRoundUp(_vaultLiabilityShares) >
            _vaultTotalValue * (TOTAL_BASIS_POINTS - _thresholdBP) / TOTAL_BASIS_POINTS;
    }

    function _addVault(address _vault, VaultConnection memory _connection, VaultRecord memory _record) internal {
        Storage storage $ = _storage();

        uint256 vaultIndex = $.vaults.length;
        $.vaults.push(_vault);

        _connection.vaultIndex = uint96(vaultIndex);

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

    function _checkConnection(address _vault) internal view returns (VaultConnection storage) {
        if (_vault == address(0)) revert VaultZeroAddress();

        VaultConnection storage connection = _storage().connections[_vault];

        if (connection.vaultIndex == 0) revert NotConnectedToHub(_vault);
        if (connection.pendingDisconnect) revert VaultIsDisconnecting(_vault);

        return connection;
    }

    function _storage() internal pure returns (Storage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    event VaultProxyCodehashUpdated(bytes32 indexed codehash, bool allowed);

    event VaultConnected(
        address indexed vault,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 treasuryFeeBP
    );

    event VaultConnectionUpdated(
        address indexed vault,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 treasuryFeeBP
    );
    event VaultShareLimitUpdated(address indexed vault, uint256 newShareLimit);
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

    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned);
    event ForcedValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);

    /**
     * @notice Emitted when `StakingVault` is funded with ether
     * @dev Event is not emitted upon direct transfers through `receive()`
     * @param amount Amount of ether funded
     */
    event VaultFunded(address indexed vault, uint256 amount);

    /**
     * @notice Emitted when ether is withdrawn from `StakingVault`
     * @dev Also emitted upon rebalancing in favor of `VaultHub`
     * @param recipient Address that received the withdrawn ether
     * @param amount Amount of ether withdrawn
     */
    event VaultWithdrawn(address indexed vault, address indexed recipient, uint256 amount);

    /**
     * @notice Emitted when the manager is set
     * @param vault The address of the vault
     * @param owner The address of the owner
     */
    event VaultOwnerSet(address indexed vault, address indexed owner);

    error ZeroIndex();

    /**
     * @notice Thrown when attempting to decrease the locked amount outside of a report
     */
    error NewLockedNotGreaterThanCurrent();

    /**
     * @notice Thrown when the locked amount exceeds the total value
     */
    error NewLockedExceedsTotalValue();

    /**
     * @notice Thrown when the transfer of ether to a recipient fails
     * @param recipient Address that was supposed to receive the transfer
     * @param amount Amount that failed to transfer
     */
    error TransferFailed(address recipient, uint256 amount);

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
    error TreasuryFeeTooHigh(address vault, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
    error InsufficientTotalValueToMint(address vault, uint256 totalValue);
    error AlreadyExists(bytes32 codehash);
    error NotFound(bytes32 codehash);
    error NoLiabilitySharesShouldBeLeft(address vault, uint256 liabilityShares);
    error VaultProxyNotAllowed(address beacon, bytes32 codehash);
    error RelativeShareLimitBPTooHigh(uint256 relativeShareLimitBP, uint256 totalBasisPoints);
    error InvalidFees(address vault, uint256 newFees, uint256 oldFees);
    error VaultOssified(address vault);
    error VaultInsufficientBalance(address vault, uint256 currentBalance, uint256 expectedBalance);
    error VaultReportStaled(address vault);
    error VaultHubMustBeDepositor(address vault);
    error VaultProxyZeroCodehash();
    error InvalidOperator();
    error VaultHubNotPendingOwner(address vault);
    error UnhealthyVaultCannotDeposit(address vault);
    error VaultIsDisconnecting(address vault);
    error PartialValidatorWithdrawalNotAllowed();
}
