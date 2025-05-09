// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Ownable2StepUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/Ownable2StepUpgradeable.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {OperatorGrid} from "./OperatorGrid.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILido} from "../interfaces/ILido.sol";
import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";

import {StakingVaultDeposit} from "./interfaces/IStakingVault.sol";
import {IVaultControl} from "./interfaces/IVaultControl.sol";

/// @notice VaultHub is a contract that manages StakingVaults connected to the Lido protocol
/// It allows to connect and disconnect vaults, mint and burn stETH using vaults as collateral
/// Also, it passes the report from the accounting oracle to the vaults and charges fees
/// @author folkyatina
contract VaultHub is PausableUntilWithRoles, IVaultControl {
        /// @notice Obligations categories
    enum ObligationCategory {
        Withdrawal,
        TreasuryFees,
        NodeOperatorFees
    }

    struct VaultObligations {
        /// @notice obligations accrued on the vault
        mapping(ObligationCategory => uint256) outstanding;
        /// @notice already settled obligations
        mapping(ObligationCategory => uint256) settled;
    }

    /// @custom:storage-location erc7201:Vaults
    struct Storage {
        /// @notice vault proxy contract codehashes allowed for connecting
        mapping(bytes32 codehash => bool allowed) vaultProxyCodehash;
        /// @notice mapping from vault address to the index of the socket in the `sockets` array
        /// @dev    if vault is not connected to the hub, its index is zero
        mapping(address vault => uint256 index) socketIndex;
        /// @notice array of sockets with vaults connected to the hub
        /// @dev    first socket is always zero. A stone in the elevator
        VaultSocket[] sockets;
        /// @notice array of obligations with vaults connected to the hub
        mapping(address vault => VaultObligations obligations) obligations;
    }

    // keccak256(abi.encode(uint256(keccak256("VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xb158a1a9015c52036ff69e7937a7bb424e82a8c4cbec5c5309994af06d825300;

    /// @notice role that allows to connect vaults to the hub
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("vaults.VaultHub.VaultMasterRole");
    /// @notice role that allows to add factories and vault implementations to hub
    bytes32 public constant VAULT_REGISTRY_ROLE = keccak256("vaults.VaultHub.VaultRegistryRole");
    /// @notice role that allows to increase a withdrawals obligation
    bytes32 public constant WITHDRAWAL_OBLIGATION_INCREASER_ROLE = keccak256("vaults.VaultHub.WithdrawalObligationIncreaserRole");
    /// @notice role that allows to trigger validator exit to fulfill withdrawals obligation
    bytes32 public constant WITHDRAWAL_OBLIGATION_FULFILLER_ROLE = keccak256("vaults.VaultHub.WithdrawalObligationFulfillerRole");

    /// @notice amount of ETH that is locked on the vault on connect and can be withdrawn on disconnect only
    uint256 public constant CONNECT_DEPOSIT = 1 ether;
    /// @notice The time delta for report freshness check
    uint256 public constant REPORT_FRESHNESS_DELTA = 1 days;

    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    /// @notice length of the validator pubkey in bytes
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    /// @notice codehash of the account with no code
    bytes32 private constant EMPTY_CODEHASH = keccak256("");

    /// @notice limit for a single vault share limit relative to Lido TVL in basis points
    uint256 public immutable RELATIVE_SHARE_LIMIT_BP;

    ILido public immutable LIDO;
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @param _locator Lido Locator contract
    /// @param _lido Lido stETH contract
    /// @param _relativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(ILidoLocator _locator, ILido _lido, uint256 _relativeShareLimitBP) {
        if (_relativeShareLimitBP == 0) revert ZeroArgument("_relativeShareLimitBP");
        if (_relativeShareLimitBP > TOTAL_BASIS_POINTS)
            revert RelativeShareLimitBPTooHigh(_relativeShareLimitBP, TOTAL_BASIS_POINTS);

        LIDO_LOCATOR = _locator;
        LIDO = _lido;
        RELATIVE_SHARE_LIMIT_BP = _relativeShareLimitBP;

        _disableInitializers();
    }

    /// @dev used to perform rebalance operations
    receive() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
    }

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

         __AccessControlEnumerable_init();

        // the stone in the elevator
        _storage().sockets.push(
            VaultSocket(address(0), 0, address(0), 0, 0, 0, Report(0, 0), 0, 0, 0, 0, false)
        );

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    function operatorGrid() public view returns (address) {
        return LIDO_LOCATOR.operatorGrid();
    }

    /// @notice Add vault proxy codehash to allow list.
    /// @param _codehash vault proxy codehash
    function addVaultProxyCodehash(bytes32 _codehash) external onlyRole(VAULT_REGISTRY_ROLE) {
        if (_codehash == bytes32(0)) revert ZeroArgument("codehash");
        if (_codehash == EMPTY_CODEHASH) revert VaultProxyZeroCodehash();

        Storage storage $ = _storage();
        if ($.vaultProxyCodehash[_codehash]) revert AlreadyExists(_codehash);
        $.vaultProxyCodehash[_codehash] = true;

        emit VaultProxyCodehashAdded(_codehash);
    }

    function removeVaultProxyCodehash(bytes32 _codehash) external onlyRole(VAULT_REGISTRY_ROLE) {
        Storage storage $ = _storage();
        if (!$.vaultProxyCodehash[_codehash]) revert NotFound(_codehash);
        delete $.vaultProxyCodehash[_codehash];

        emit VaultProxyCodehashRemoved(_codehash);
    }

    /// @notice returns the number of vaults connected to the hub
    function vaultsCount() external view returns (uint256) {
        return _storage().sockets.length - 1;
    }

    /// @return vault socket for the given index of the vault
    function vaultSocket(uint256 _index) external view returns (VaultSocket memory) {
        return _storage().sockets[_index + 1];
    }

    /// @return vault socket for the given vault
    /// @dev it returns zero socket if the vault is not connected to the hub
    /// @dev it may return socket if it's pending to be disconnected
    function vaultSocket(address _vault) external view returns (VaultSocket memory) {
        Storage storage $ = _storage();
        return $.sockets[$.socketIndex[_vault]];
    }

    /// @return total value of the vault (as of the latest report received)
    function totalValue(address _vault) external view returns (uint256) {
        VaultSocket storage socket = _connectedSocket(_vault);
        return _totalValue(socket);
    }

    /// @return amount of ether that is part of the vault's total value and is not locked as a collateral
    function unlocked(address _vault) external view returns (uint256) {
        VaultSocket storage socket = _connectedSocket(_vault);
        return _unlocked(socket);
    }

    /// @return true if the report for the vault is fresh, false otherwise
    function isReportFresh(address _vault) external view returns (bool) {
        VaultSocket storage socket = _connectedSocket(_vault);
        return _isReportFresh(socket);
    }

    /// @notice checks if the vault is healthy by comparing its total value after applying rebalance threshold
    ///         against current liability shares
    /// @param _vault vault address
    /// @return true if vault is healthy, false otherwise
    function isVaultHealthyAsOfLatestReport(address _vault) external view returns (bool) {
        VaultSocket storage socket = _connectedSocket(_vault);
        return
            _isVaultHealthyByThreshold(_totalValue(socket), socket.liabilityShares, socket.forcedRebalanceThresholdBP);
    }

    /// @notice calculate ether amount to make the vault healthy using rebalance
    /// @param _vault vault address
    /// @return amount to rebalance  or UINT256_MAX if it's impossible to make the vault healthy using rebalance
    function rebalanceShortfall(address _vault) external view returns (uint256) {
        VaultSocket storage socket = _connectedSocket(_vault);
        return _rebalanceShortfall(socket);
    }

    /// @notice returns the total obligations accrued on the vault for the given category
    /// @param _vault vault address
    /// @param _category obligation category
    /// @return obligations accrued on the vault for the given category
    function vaultObligationsForCategory(address _vault, ObligationCategory _category) public view returns (uint256) {
        return _vaultObligationsForCategory(_vault, _category);
    }

    /// @notice returns the total obligations accrued on the vault
    /// @param _vault vault address
    /// @return total obligations accrued on the vault
    function vaultTotalObligations(address _vault) public view returns (uint256) {
        return _vaultTotalObligations(_vault);
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    function connectVault(address _vault) external whenResumed {
        if (_vault == address(0)) revert VaultZeroAddress();
        if (address(this) != Ownable2StepUpgradeable(_vault).pendingOwner()) revert VaultHubNotPendingOwner(_vault);
        IStakingVault vault_ = IStakingVault(_vault);
        if (vault_.isOssified()) revert VaultOssified(_vault);
        if (vault_.depositor() != address(this)) revert VaultHubMustBeDepositor(_vault);

        OperatorGrid operatorGrid_ = OperatorGrid(operatorGrid());
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
            Ownable2StepUpgradeable(_vault).owner(),
            shareLimit,
            reserveRatioBP,
            forcedRebalanceThresholdBP,
            treasuryFeeBP
        );
    }

    /// @notice updates share limit for the vault
    /// Setting share limit to zero actually pause the vault's ability to mint
    /// and stops charging fees from the vault
    /// @param _vault vault address
    /// @param _shareLimit new share limit
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function updateShareLimit(address _vault, uint256 _shareLimit) external onlyRole(VAULT_MASTER_ROLE) {
        if (_shareLimit > _maxSaneShareLimit()) revert ShareLimitTooHigh(_vault, _shareLimit, _maxSaneShareLimit());

        VaultSocket storage socket = _connectedSocket(_vault);

        socket.shareLimit = uint96(_shareLimit);

        emit ShareLimitUpdated(_vault, _shareLimit);
    }

    function updateWithdrawalObligation(address _vault, uint256 _amountToWithdraw) external onlyRole(WITHDRAWAL_OBLIGATION_INCREASER_ROLE) {
        VaultSocket storage socket = _connectedSocket(_vault);
        uint128 locked = socket.locked;
        if (_amountToWithdraw > locked) {
            revert LockedAmountTooLow(_vault, _amountToWithdraw, locked);
        }

        _increaseObligation(_vault, ObligationCategory.Withdrawal, _amountToWithdraw);
        emit ObligationAccrued(_vault, "Withdrawal", _amountToWithdraw, _vaultObligationsForCategory(_vault, ObligationCategory.Withdrawal));
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

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 totalValue_ = _totalValue(socket);
        uint256 liabilityShares = socket.liabilityShares;

        // check healthy with new rebalance threshold
        if (!_isVaultHealthyByThreshold(totalValue_, liabilityShares, _reserveRatioBP))
            revert VaultMintingCapacityExceeded(_vault, totalValue_, liabilityShares, _reserveRatioBP);

        socket.shareLimit = uint96(_shareLimit);
        socket.reserveRatioBP = uint16(_reserveRatioBP);
        socket.forcedRebalanceThresholdBP = uint16(_forcedRebalanceThresholdBP);
        socket.treasuryFeeBP = uint16(_treasuryFeeBP);

        emit VaultConnectionSet(_vault, _shareLimit, _reserveRatioBP, _forcedRebalanceThresholdBP, _treasuryFeeBP);
    }

    /// @notice force disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    /// @dev vault's `liabilityShares` should be zero
    function disconnect(address _vault) external onlyRole(VAULT_MASTER_ROLE) {
        _disconnect(_connectedSocket(_vault));
    }

    /// @notice Permissionless update of the vault data
    /// @param _vault the address of the vault
    /// @param _reportTimestamp the timestamp of the report
    /// @param _reportTotalValue the total value of the vault
    /// @param _reportInOutDelta the inOutDelta of the vault
    /// @param _reportChargedFees the fees charged to the vault
    /// @param _reportLiabilityShares the liabilityShares of the vault
    function updateSocket(
        address _vault,
        uint64 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportChargedFees,
        uint256 _reportLiabilityShares
    ) external {
        if (msg.sender != LIDO_LOCATOR.lazyOracle()) revert NotAuthorized();

        Storage storage $ = _storage();
        // we don't use _connectedSocket(_vault) here because it does not include sockets with the pendingDisconnect flag
        uint256 socketIndex = $.socketIndex[_vault];
        if (socketIndex == 0) revert NotConnectedToHub(_vault);
        VaultSocket storage socket = $.sockets[socketIndex];

        if (socket.pendingDisconnect) {
            Ownable2StepUpgradeable(socket.vault).transferOwnership(socket.owner);
            _deleteVaultSocket($, socket, socketIndex);
            return;
        }

        uint256 newLiabilityShares = Math256.max(socket.liabilityShares, _reportLiabilityShares);
        // locked ether can only be increased asynchronously once the oracle settled the new floor value
        // as of reference slot to prevent slashing upsides in between the report gathering and delivering
        uint256 lockedEther = Math256.max(
            LIDO.getPooledEthBySharesRoundUp(newLiabilityShares) * TOTAL_BASIS_POINTS / (TOTAL_BASIS_POINTS - socket.reserveRatioBP),
            socket.pendingDisconnect ? 0 : CONNECT_DEPOSIT
        );

        socket.report.totalValue = uint128(_reportTotalValue);
        socket.report.inOutDelta = int128(_reportInOutDelta);
        socket.reportTimestamp = _reportTimestamp;
        socket.liabilityShares = uint96(newLiabilityShares);
        socket.locked = uint128(lockedEther);

        _processWithdrawalsObligation(socket);
        _processTreasuryFeesObligation(socket, _reportChargedFees);
    }

    function setVaultOwner(address _vault, address _owner) external {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (!_isVaultOwner(msg.sender, socket)) revert NotAuthorized();

        socket.owner = _owner;

        emit VaultOwnerSet(_vault, _owner);
    }

    /// @notice disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    /// @dev vault's `liabilityShares` should be zero
    function voluntaryDisconnect(address _vault) external whenResumed {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (!_isVaultOwner(msg.sender, socket)) revert NotAuthorized();

        _disconnect(socket);
    }

    function fund(address _vault) external payable {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (!_isVaultOwner(msg.sender, socket)) revert NotAuthorized();

        socket.inOutDelta += int128(int256(msg.value));

        (bool success, ) = _vault.call{value: msg.value}("");
        if (!success) revert TransferFailed(_vault, msg.value);

        emit VaultFunded(_vault, msg.value);
    }

    function withdraw(address _vault, address _recipient, uint256 _ether) external {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (!_isVaultOwner(msg.sender, socket)) revert NotAuthorized();
        if (!_isReportFresh(socket)) revert VaultReportStaled(_vault);

        uint256 unlocked_ = _unlocked(socket);
        if (_ether > unlocked_) revert InsufficientUnlocked(unlocked_, _ether);

        _ensuresAllObligationsSettled(socket.vault);

        _withdrawFromVault(socket, _recipient, _ether);

        if (_totalValue(socket) < socket.locked) revert TotalValueBelowLockedAmount();

        emit VaultWithdrawn(_vault, _recipient, _ether);
    }

    /**
     * @notice Rebalances StakingVault by withdrawing ether to VaultHub
     * @param _vault vault address
     * @param _ether amount of ether to rebalance
     */
    function rebalance(address _vault, uint256 _ether) external {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (!_isVaultOwner(msg.sender, socket)) revert NotAuthorized();

        _rebalance(socket, _ether);
    }

    /// @notice mint StETH shares backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _amountOfShares amount of stETH shares to mint
    function mintShares(address _vault, address _recipient, uint256 _amountOfShares) external whenResumed {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");

        VaultSocket storage socket = _connectedSocket(_vault);

        if (!_isVaultOwner(msg.sender, socket)) revert NotAuthorized();

        uint256 vaultSharesAfterMint = socket.liabilityShares + _amountOfShares;
        if (vaultSharesAfterMint > socket.shareLimit) revert ShareLimitExceeded(_vault, socket.shareLimit);

        if (!_isReportFresh(socket)) revert VaultReportStaled(_vault);

        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - socket.reserveRatioBP;
        uint256 maxMintableEther = (_totalValue(socket) * maxMintableRatioBP) / TOTAL_BASIS_POINTS;
        uint256 stETHAfterMint = LIDO.getPooledEthBySharesRoundUp(vaultSharesAfterMint);
        if (stETHAfterMint > maxMintableEther) {
            revert InsufficientTotalValueToMint(_vault, _totalValue(socket));
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 etherToLock = (stETHAfterMint * TOTAL_BASIS_POINTS) / maxMintableRatioBP;

        if (etherToLock > socket.locked) {
            socket.locked = uint128(etherToLock);
        }

        socket.liabilityShares = uint96(vaultSharesAfterMint);
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
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");
        VaultSocket storage socket = _connectedSocket(_vault);
        if (!_isVaultOwner(msg.sender, socket)) revert NotAuthorized();

        uint256 liabilityShares = socket.liabilityShares;
        if (liabilityShares < _amountOfShares) revert InsufficientSharesToBurn(_vault, liabilityShares);

        socket.liabilityShares = uint96(liabilityShares - _amountOfShares);

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

    function pauseBeaconChainDeposits(address _vault) external {
        if (!_isVaultOwner(msg.sender, _connectedSocket(_vault))) revert NotAuthorized();

        IStakingVault(_vault).pauseBeaconChainDeposits();
    }

    function resumeBeaconChainDeposits(address _vault) external {
        if (!_isVaultOwner(msg.sender, _connectedSocket(_vault))) revert NotAuthorized();

        IStakingVault(_vault).resumeBeaconChainDeposits();
    }

    function depositToBeaconChain(address _vault, StakingVaultDeposit[] calldata _deposits) external {
        if (msg.sender != LIDO_LOCATOR.predepositGuarantee()) revert NotAuthorized();

        VaultSocket storage socket = _connectedSocket(_vault);

        if (!_isVaultHealthyByThreshold(
            _totalValue(socket),
            socket.liabilityShares,
            socket.forcedRebalanceThresholdBP
        )) revert UnhealthyVaultCannotDeposit(_vault);

        _ensuresAllObligationsSettled(socket.vault);

        IStakingVault(_vault).depositToBeaconChain(_deposits);
    }

    function requestValidatorExit(address _vault, bytes calldata _pubkeys) external {
        if (!_isVaultOwner(msg.sender, _connectedSocket(_vault))) revert NotAuthorized();

        IStakingVault(_vault).requestValidatorExit(_pubkeys);
    }

    function triggerValidatorWithdrawal(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        VaultSocket storage socket = _connectedSocket(_vault);
        // todo: separate logic for partial and full withdrawals
        if (_totalValue(socket) < socket.locked) revert TotalValueBelowLockedAmount();

        IStakingVault(_vault).triggerValidatorWithdrawals{value: msg.value}(_pubkeys, _amounts, _refundRecipient);
    }

    function triggerValidatorExit(
        address _vault,
        bytes calldata _pubkeys,
        address _refundRecipient
    ) external payable onlyRole(WITHDRAWAL_OBLIGATION_FULFILLER_ROLE) {
        VaultSocket storage socket = _connectedSocket(_vault);

        if (_vaultObligationsForCategory(socket.vault, ObligationCategory.Withdrawal) == 0) {
            revert VaultHasNoWithdrawalObligation(socket.vault);
        }

        IStakingVault(_vault).triggerValidatorExits{value: msg.value}(_pubkeys, _refundRecipient);

        emit ValidatorExitTriggered(socket.vault, _pubkeys, _refundRecipient);
    }

    /// @notice Forces validator exit from the beacon chain when vault is unhealthy
    /// @param _vault The address of the vault to exit validators from
    /// @param _pubkeys The public keys of the validators to exit
    /// @param _refundRecipient The address that will receive the refund for transaction costs
    /// @dev    When the vault becomes unhealthy, anyone can force its validators to exit the beacon chain
    ///         This returns the vault's deposited ETH back to vault's balance and allows to rebalance the vault
    function forceValidatorExit(address _vault, bytes calldata _pubkeys, address _refundRecipient) external payable {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (_isVaultHealthyByThreshold(
            _totalValue(socket),
            socket.liabilityShares,
            socket.forcedRebalanceThresholdBP
        )) revert AlreadyHealthy(_vault);

        IStakingVault(_vault).triggerValidatorExits{value: msg.value}(_pubkeys, _refundRecipient);

        emit ForcedValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
    }

    /// @notice permissionless rebalance for unhealthy vaults
    /// @param _vault vault address
    /// @dev rebalance all available amount of ether until the vault is healthy
    function forceRebalance(address _vault) external {
        VaultSocket storage socket = _connectedSocket(_vault);
        uint256 fullRebalanceAmount = _rebalanceShortfall(socket);
        if (fullRebalanceAmount == 0) revert AlreadyHealthy(_vault);

        // TODO: add some gas compensation here
        _rebalance(socket, Math256.min(fullRebalanceAmount, _vault.balance));
    }

    function _connectVault(
        address _vault,
        address _owner,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _treasuryFeeBP
    ) internal {
        if (_reserveRatioBP == 0) revert ZeroArgument("_reserveRatioBP");
        if (_reserveRatioBP > TOTAL_BASIS_POINTS)
            revert ReserveRatioTooHigh(_vault, _reserveRatioBP, TOTAL_BASIS_POINTS);
        if (_forcedRebalanceThresholdBP == 0) revert ZeroArgument("_forcedRebalanceThresholdBP");
        if (_forcedRebalanceThresholdBP > _reserveRatioBP)
            revert ForcedRebalanceThresholdTooHigh(_vault, _forcedRebalanceThresholdBP, _reserveRatioBP);
        if (_treasuryFeeBP > TOTAL_BASIS_POINTS) revert TreasuryFeeTooHigh(_vault, _treasuryFeeBP, TOTAL_BASIS_POINTS);

        if (_shareLimit > _maxSaneShareLimit()) revert ShareLimitTooHigh(_vault, _shareLimit, _maxSaneShareLimit());

        Storage storage $ = _storage();
        if ($.socketIndex[_vault] != 0) revert AlreadyConnected(_vault, $.socketIndex[_vault]);

        bytes32 vaultProxyCodehash = address(_vault).codehash;
        if (!$.vaultProxyCodehash[vaultProxyCodehash]) revert VaultProxyNotAllowed(_vault, vaultProxyCodehash);

        if (_vault.balance < CONNECT_DEPOSIT) revert VaultInsufficientBalance(_vault, _vault.balance, CONNECT_DEPOSIT);

        Report memory report = Report(
            uint128(_vault.balance), // totalValue
            int128(int256(_vault.balance)) // inOutDelta
        );

        VaultSocket memory vsocket = VaultSocket(
            _vault,
            uint96(_shareLimit),
            _owner,
            uint96(0), // liabilityShares
            uint128(CONNECT_DEPOSIT), // locked
            int128(int256(_vault.balance)), // inOutDelta
            report,
            uint64(block.timestamp), // reportTimestamp
            uint16(_reserveRatioBP),
            uint16(_forcedRebalanceThresholdBP),
            uint16(_treasuryFeeBP),
            false // pendingDisconnect
        );
        $.socketIndex[_vault] = $.sockets.length;
        $.sockets.push(vsocket);

        Ownable2StepUpgradeable(_vault).acceptOwnership();

        emit VaultConnectionSet(_vault, _shareLimit, _reserveRatioBP, _forcedRebalanceThresholdBP, _treasuryFeeBP);
    }

    function _disconnect(VaultSocket storage socket) internal {
        uint256 liabilityShares = socket.liabilityShares;
        if (liabilityShares > 0) {
            revert NoLiabilitySharesShouldBeLeft(socket.vault, liabilityShares);
        }

        socket.pendingDisconnect = true;

        emit VaultDisconnected(socket.vault);
    }

    function _withdrawFromVault(VaultSocket storage _socket, address _recipient, uint256 _amount) internal {
        _socket.inOutDelta -= int128(int256(_amount));
        address vaultAddress = _socket.vault;
        IStakingVault(vaultAddress).withdraw(_recipient, _amount);
    }

    function _rebalance(VaultSocket storage _socket, uint256 _ether) internal {
        if (_ether == 0) revert ZeroArgument("_ether");
        address vaultAddress = _socket.vault;

        if (_ether > vaultAddress.balance) revert InsufficientBalance(vaultAddress.balance, _ether);

        uint256 totalValue_ = _totalValue(_socket);
        if (_ether > totalValue_) revert RebalanceAmountExceedsTotalValue(totalValue_, _ether);

        uint256 sharesToBurn = LIDO.getSharesByPooledEth(_ether);
        uint256 liabilityShares = _socket.liabilityShares;
        if (liabilityShares < sharesToBurn) revert InsufficientSharesToBurn(msg.sender, liabilityShares);

        _socket.liabilityShares = uint96(liabilityShares - sharesToBurn);
        _withdrawFromVault(_socket, address(this), _ether);
        LIDO.rebalanceExternalEtherToInternal{value: _ether}();

        emit VaultRebalanced(vaultAddress, sharesToBurn);
    }

    function _rebalanceShortfall(VaultSocket storage _socket) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_socket);
        bool isHealthy = _isVaultHealthyByThreshold(
            totalValue_,
            _socket.liabilityShares,
            _socket.forcedRebalanceThresholdBP
        );

        // Health vault do not need to rebalance
        if (isHealthy) {
            return 0;
        }

        uint256 liabilityStETH = LIDO.getPooledEthBySharesRoundUp(_socket.liabilityShares);
        uint256 reserveRatioBP = _socket.reserveRatioBP;
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

    function _deleteVaultSocket(Storage storage $, VaultSocket storage socket, uint256 _socketIndex) internal {
        address vault = socket.vault;

        VaultSocket memory lastSocket = $.sockets[$.sockets.length - 1];
        $.sockets[_socketIndex] = lastSocket;
        $.socketIndex[lastSocket.vault] = _socketIndex;
        $.sockets.pop();

        delete $.socketIndex[vault];
    }

    function _unlocked(VaultSocket storage _socket) internal view returns (uint256) {
        uint256 totalValue_ = _totalValue(_socket);
        uint256 locked_ = _socket.locked;

        if (locked_ > totalValue_) return 0;

        return totalValue_ - locked_;
    }

    function _totalValue(VaultSocket storage socket) internal view returns (uint256) {
        Report memory report = socket.report;
        return uint256(int256(int128(report.totalValue) + report.inOutDelta - report.inOutDelta));
    }

    function _isReportFresh(VaultSocket storage socket) internal view returns (bool) {
        return block.timestamp - socket.reportTimestamp < REPORT_FRESHNESS_DELTA;
    }

    function _isVaultHealthyByThreshold(
        uint256 _vaultTotalValue,
        uint256 _vaultLiabilityShares,
        uint256 _checkThreshold
    ) internal view returns (bool) {
        if (_vaultLiabilityShares == 0) return true;

        return
            ((_vaultTotalValue * (TOTAL_BASIS_POINTS - _checkThreshold)) / TOTAL_BASIS_POINTS) >=
            LIDO.getPooledEthBySharesRoundUp(_vaultLiabilityShares);
    }

    function _isVaultOwner(address _account, VaultSocket storage socket) internal view returns (bool) {
        return _account == socket.owner;
    }

    function _connectedSocket(address _vault) internal view returns (VaultSocket storage) {
        if (_vault == address(0)) revert VaultZeroAddress();
        Storage storage $ = _storage();
        uint256 index = $.socketIndex[_vault];
        if (index == 0 || $.sockets[index].pendingDisconnect) revert NotConnectedToHub(_vault);
        return $.sockets[index];
    }

    function _vaultObligationsForCategory(address _vault,ObligationCategory _category) internal view returns (uint256) {
        VaultObligations storage obligations = _storage().obligations[_vault];
        return obligations.outstanding[_category] - obligations.settled[_category];
    }

    function _vaultTotalObligations(address _vault) internal view returns (uint256 total) {
        VaultObligations storage obligations = _storage().obligations[_vault];
        uint8 totalCategories = uint8(type(ObligationCategory).max) + 1;
        for (uint8 i = 0; i < totalCategories; i++) {
            ObligationCategory category = ObligationCategory(i);
            total += obligations.outstanding[category] - obligations.settled[category];
        }
    }

    function _increaseObligation(address _vault, ObligationCategory _category, uint256 _amount) internal {
        _storage().obligations[_vault].outstanding[_category] += _amount;
    }

    function _decreaseObligation(address _vault, ObligationCategory _category, uint256 _amount) internal {
        _storage().obligations[_vault].settled[_category] += _amount;
    }

    function _ensuresAllObligationsSettled(address _vault) internal view {
        uint256 vaultBalance = address(_vault).balance;
        uint256 obligations = _vaultTotalObligations(_vault);
        if (vaultBalance < obligations) {
            revert NotAllObligationsSettled(_vault, obligations, vaultBalance);
        }
    }

    function _processWithdrawalsObligation(VaultSocket storage socket) internal {
        // TODO: if locked decreses, we need to reset the obligation somehow
        ObligationCategory category = ObligationCategory.Withdrawal;
        uint256 withdrawalsToSettle = _vaultObligationsForCategory(socket.vault, category);
        if (withdrawalsToSettle == 0) return;

        uint256 vaultBalance = address(socket.vault).balance;
        if (vaultBalance == 0) return;

        uint256 valueToRebalance = Math256.min(withdrawalsToSettle, vaultBalance);
        _rebalance(socket, valueToRebalance);
        _decreaseObligation(socket.vault, category, valueToRebalance);

        emit ObligationSettled(socket.vault, "Withdrawal", valueToRebalance, _vaultObligationsForCategory(socket.vault, category));
    }

    function _processTreasuryFeesObligation(VaultSocket storage socket, uint256 _chargedFees) internal {
        ObligationCategory category = ObligationCategory.TreasuryFees;
        uint256 feesSettled = _storage().obligations[socket.vault].settled[category];
        if (_chargedFees < feesSettled) revert InvalidFees(socket.vault, _chargedFees, feesSettled);

        // explicitly set the outstanding obligation to the charged fees because it's already cummulative amount
        _storage().obligations[socket.vault].outstanding[category] = _chargedFees;
        uint256 feesToSettle = _chargedFees - feesSettled;
        if (feesToSettle == 0) return;

        emit ObligationAccrued(socket.vault, "TreasuryFees", feesToSettle, _vaultObligationsForCategory(socket.vault, category));

        uint256 vaultBalance = address(socket.vault).balance;
        uint256 valueToTransfer = feesToSettle < vaultBalance ? feesToSettle : vaultBalance;

        if (valueToTransfer > 0) {
            address treasury = LIDO_LOCATOR.treasury();
            _withdrawFromVault(socket, treasury, valueToTransfer);

            uint256 newSettledAmount = feesSettled + valueToTransfer;
            _storage().obligations[socket.vault].settled[category] = newSettledAmount;
            emit ObligationSettled(socket.vault, "TreasuryFees", newSettledAmount, _vaultObligationsForCategory(socket.vault, category));
        }
    }

    function _storage() internal pure returns (Storage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    event VaultConnectionSet(
        address indexed vault,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 treasuryFeeBP
    );

    event VaultsReportDataUpdated(uint64 indexed timestamp, bytes32 root, string cid);
    event ShareLimitUpdated(address indexed vault, uint256 newShareLimit);
    event VaultDisconnected(address indexed vault);
    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned);
    event VaultProxyCodehashAdded(bytes32 indexed codehash);
    event VaultProxyCodehashRemoved(bytes32 indexed codehash);
    event ValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);
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
     * @notice Emitted when the locked amount is increased
     * @param locked New amount of locked ether
     */
    event LockedIncreased(uint256 locked);

    /**
     * @notice Emitted when deposits are paused
     */
    event DepositedToBeaconChain(address indexed sender, uint256 numberOfDeposits, uint256 totalAmount);

    /**
     * @notice Emitted when the manager is set
     * @param vault The address of the vault
     * @param owner The address of the owner
     */
    event VaultOwnerSet(address indexed vault, address indexed owner);

    /**
     * @notice Emitted when an obligation is settled on a vault
     * @param vault The address of the vault
     * @param obligationCategory The category of the obligation
     * @param amount The cumulative amount of the obligation of the category that has been settled on the vault
     * @param left The amount of the obligation of the category that is left to be settled on the vault
     */
    event ObligationSettled(address indexed vault, string obligationCategory, uint256 amount, uint256 left);

    /**
     * @notice Emitted when an obligation is accrued on a vault
     * @param vault The address of the vault
     * @param obligationCategory The category of the obligation
     * @param amount The cumulative amount of the obligation of the category ever accrued on the vault
     * @param left The amount of the obligation of the category that is left to be settled on the vault
     */
    event ObligationAccrued(address indexed vault, string obligationCategory, uint256 amount, uint256 left);

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
    error ZeroArgument(string argument);
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
    error LockedAmountTooLow(address vault, uint256 withdrawalAmount, uint256 lockedAmount);
    error VaultHasNoWithdrawalObligation(address vault);
    error NotAllObligationsSettled(address vault, uint256 obligations, uint256 vaultBalance);
}
