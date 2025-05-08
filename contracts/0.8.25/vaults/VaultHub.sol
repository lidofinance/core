// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Ownable2StepUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/Ownable2StepUpgradeable.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {LazyOracle} from "./LazyOracle.sol";
import {OperatorGrid} from "./OperatorGrid.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILido} from "../interfaces/ILido.sol";
import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";


/// @notice VaultHub is a contract that manages StakingVaults connected to the Lido protocol
/// It allows to connect and disconnect vaults, mint and burn stETH using vaults as collateral
/// Also, it passes the report from the accounting oracle to the vaults and charges fees
/// @author folkyatina
contract VaultHub is PausableUntilWithRoles {
    /// @custom:storage-location erc7201:VaultHub
    struct VaultHubStorage {
        /// @notice vault sockets with vaults connected to the hub
        /// @dev    first socket is always zero. stone in the elevator
        VaultSocket[] sockets;
        /// @notice mapping from vault address to its node operator
        mapping(address => address) nodeOperators;
        /// @notice mapping from vault address to its socket
        /// @dev    if vault is not connected to the hub, its index is zero
        mapping(address => uint256) vaultIndex;
        /// @notice allowed beacon addresses
        mapping(bytes32 => bool) vaultProxyCodehash;
    }

    /**
     * @notice Latest reported totalValue and inOutDelta
     * @custom:totalValue Aggregated validator balances plus the balance of `StakingVault`
     * @custom:inOutDelta Net difference between ether funded and withdrawn from `StakingVault`
     */
    struct Report {
        uint128 totalValue;
        int128 inOutDelta;
        uint64 timestamp;
    }

    struct Obligations {
        uint96 withdrawals;
        uint96 treasuryFees;
    }

    // todo: optimize storage layout
    struct VaultSocket {
        // ### 1st slot
        /// @notice vault address
        address vault;
        /// @notice vault manager address
        address manager;
        /// @notice latest report
        Report report;
        /// @notice amount of ETH that is locked on the vault and cannot be withdrawn by manager
        uint128 locked;
        /// @notice net difference between ether funded and withdrawn from the vault
        int128 inOutDelta;
        /// @notice total number of stETH shares that the vault owes to Lido
        uint96 liabilityShares;
        // ### 2nd slot
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        /// @notice share of ether that is locked on the vault as an additional reserve
        /// e.g RR=30% means that for 1stETH minted 1/(1-0.3)=1.428571428571428571 ETH is locked on the vault
        uint16 reserveRatioBP;
        /// @notice if vault's reserve decreases to this threshold, it should be force rebalanced
        uint16 forcedRebalanceThresholdBP;
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
        /// @notice if true, vault is disconnected and fee is not accrued
        bool pendingDisconnect;
        /// @notice cumulative amount of treasury fees settled on the vault
        uint96 settledTreasuryFees;
        /// @notice outstanding obligations accumulated on the vault
        Obligations obligations;
    }

    // keccak256(abi.encode(uint256(keccak256("VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_HUB_STORAGE_LOCATION =
        0xb158a1a9015c52036ff69e7937a7bb424e82a8c4cbec5c5309994af06d825300;

    /// @notice codehash of the account with no code
    bytes32 private constant EMPTY_CODEHASH = keccak256("");

    /// @notice role that allows to connect vaults to the hub
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("Vaults.VaultHub.VaultMasterRole");
    /// @notice role that allows to add factories and vault implementations to hub
    bytes32 public constant VAULT_REGISTRY_ROLE = keccak256("Vaults.VaultHub.VaultRegistryRole");
    /// @notice role that allows to set withdrawals obligation
    bytes32 public constant SET_WITHDRAWALS_OBLIGATION_ROLE = keccak256("Vaults.VaultHub.SetWithdrawalsObligationRole");
    /// @notice role that allows to trigger withdrawals obligation fulfillment via validator exits
    bytes32 public constant FULFILL_WITHDRAWALS_OBLIGATION_ROLE = keccak256("Vaults.VaultHub.FulfillWithdrawalsObligationRole");
    /// @dev basis points base
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    /// @notice length of the validator pubkey in bytes
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    /// @notice amount of ETH that is locked on the vault on connect and can be withdrawn on disconnect only
    uint256 public constant CONNECT_DEPOSIT = 1 ether;
    /// @notice The time delta for report freshness check
    uint256 public constant REPORT_FRESHNESS_DELTA = 1 days;

    /// @notice limit for a single vault share limit relative to Lido TVL in basis points
    uint256 private immutable RELATIVE_SHARE_LIMIT_BP;

    /// @notice Lido stETH contract
    ILido public immutable LIDO;
    /// @notice Lido Locator contract
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

    receive() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
    }

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");
        __VaultHub_init(_admin);
    }

    /// @param _admin admin address to manage the roles
    function __VaultHub_init(address _admin) internal onlyInitializing {
        __AccessControlEnumerable_init();

        // the stone in the elevator
        _getVaultHubStorage().sockets.push(
            VaultSocket(address(0), address(0), Report(0, 0, 0), 0, 0, 0, 0, 0, 0, 0, false, 0, Obligations(0, 0))
        );

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    function operatorGrid() public view returns (address) {
        return LIDO_LOCATOR.operatorGrid();
    }

    /// @notice Add vault proxy codehash to allow list.
    /// @param _codehash vault proxy codehash
    function addVaultProxyCodehash(bytes32 _codehash) public onlyRole(VAULT_REGISTRY_ROLE) {
        if (_codehash == bytes32(0)) revert ZeroArgument("codehash");
        if (_codehash == EMPTY_CODEHASH) revert VaultProxyZeroCodehash();

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultProxyCodehash[_codehash]) revert AlreadyExists(_codehash);
        $.vaultProxyCodehash[_codehash] = true;

        emit VaultProxyCodehashAdded(_codehash);
    }

    function removeVaultProxyCodehash(bytes32 _codehash) public onlyRole(VAULT_REGISTRY_ROLE) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        if (!$.vaultProxyCodehash[_codehash]) revert NotFound(_codehash);
        delete $.vaultProxyCodehash[_codehash];

        emit VaultProxyCodehashRemoved(_codehash);
    }

    /// @notice returns the number of vaults connected to the hub
    function vaultsCount() public view returns (uint256) {
        return _getVaultHubStorage().sockets.length - 1;
    }

    /// @param _index index of the vault
    /// @return vault address
    function vault(uint256 _index) public view returns (address) {
        return _getVaultHubStorage().sockets[_index + 1].vault;
    }

    /// @param _index index of the vault
    /// @return vault socket
    function vaultSocket(uint256 _index) external view returns (VaultSocket memory) {
        return _getVaultHubStorage().sockets[_index + 1];
    }

    /// @param _vault vault address
    /// @return vault socket
    function vaultSocket(address _vault) external view returns (VaultSocket memory) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        return $.sockets[$.vaultIndex[_vault]];
    }

    function totalValue(address _vault) public view returns (uint256) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        VaultSocket storage socket = $.sockets[$.vaultIndex[_vault]];
        return uint256(int256(int128(socket.report.totalValue) + socket.inOutDelta - socket.report.inOutDelta));
    }

    function obligations(address _vault) public view returns (Obligations memory) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        return $.sockets[$.vaultIndex[_vault]].obligations;
    }

    function isReportFresh(address _vault) public view returns (bool) {
        VaultSocket storage socket = _connectedSocket(_vault);
        return block.timestamp - socket.report.timestamp < REPORT_FRESHNESS_DELTA;
    }

    /// @notice checks if the vault is healthy by comparing its total value after applying rebalance threshold
    ///         against current liability shares
    /// @param _vault vault address
    /// @return true if vault is healthy, false otherwise
    function isVaultHealthyAsOfLatestReport(address _vault) public view returns (bool) {
        VaultSocket storage socket = _connectedSocket(_vault);
        return
            _isVaultHealthyByThreshold(totalValue(_vault), socket.liabilityShares, socket.forcedRebalanceThresholdBP);
    }

    function _isVaultHealthyByThreshold(
        uint256 _totalValue,
        uint256 _liabilityShares,
        uint256 _checkThreshold
    ) internal view returns (bool) {
        if (_liabilityShares == 0) return true;

        return
            ((_totalValue * (TOTAL_BASIS_POINTS - _checkThreshold)) / TOTAL_BASIS_POINTS) >=
            LIDO.getPooledEthBySharesRoundUp(_liabilityShares);
    }

    /// @notice estimate ether amount to make the vault healthy using rebalance
    /// @param _vault vault address
    /// @return amount to rebalance  or UINT256_MAX if it's impossible to make the vault healthy using rebalance
    function rebalanceShortfall(address _vault) public view returns (uint256) {
        if (_vault == address(0)) revert VaultZeroAddress();
        bool isHealthy = isVaultHealthyAsOfLatestReport(_vault);

        // Health vault do not need to rebalance
        if (isHealthy) {
            return 0;
        }

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 liabilityStETH = LIDO.getPooledEthBySharesRoundUp(socket.liabilityShares);
        uint256 reserveRatioBP = socket.reserveRatioBP;
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);
        uint256 totalValue_ = totalValue(_vault);

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

    /// @notice disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    /// @dev vault's `liabilityShares` should be zero
    function voluntaryDisconnect(address _vault) external whenResumed {
        if (_vault == address(0)) revert VaultZeroAddress();
        if (!_isManager(msg.sender, _vault)) revert NotAuthorized();

        _disconnect(_vault);
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    function connectVault(address _vault, address _manager) external {
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

        _connectVault(_vault, _manager, shareLimit, reserveRatioBP, forcedRebalanceThresholdBP, treasuryFeeBP);
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _reserveRatioBP minimum reserve ratio in basis points
    /// @param _forcedRebalanceThresholdBP threshold to force rebalance on the vault in basis points
    /// @param _treasuryFeeBP treasury fee in basis points
    function _connectVault(
        address _vault,
        address _manager,
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

        _checkShareLimitUpperBound(_vault, _shareLimit);

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultIndex[_vault] != 0) revert AlreadyConnected(_vault, $.vaultIndex[_vault]);

        bytes32 vaultProxyCodehash = address(_vault).codehash;
        if (!$.vaultProxyCodehash[vaultProxyCodehash]) revert VaultProxyNotAllowed(_vault, vaultProxyCodehash);

        if (_vault.balance < CONNECT_DEPOSIT) revert VaultInsufficientBalance(_vault, _vault.balance, CONNECT_DEPOSIT);

        Report memory report = Report(
            uint128(_vault.balance), // totalValue
            int128(int256(_vault.balance)), // inOutDelta
            uint64(block.timestamp) // timestamp
        );

        VaultSocket memory vsocket = VaultSocket(
            _vault,
            _manager,
            report,
            uint128(CONNECT_DEPOSIT), // locked
            int128(int256(_vault.balance)), // inOutDelta
            0, // liabilityShares
            uint96(_shareLimit),
            uint16(_reserveRatioBP),
            uint16(_forcedRebalanceThresholdBP),
            uint16(_treasuryFeeBP),
            false, // pendingDisconnect
            0, // settledTreasuryFees
            Obligations(0, 0) // obligations
        );
        $.vaultIndex[_vault] = $.sockets.length;
        $.sockets.push(vsocket);

        Ownable2StepUpgradeable(_vault).acceptOwnership();

        emit VaultConnectionSet(_vault, _shareLimit, _reserveRatioBP, _forcedRebalanceThresholdBP, _treasuryFeeBP);
    }

    /// @notice updates share limit for the vault
    /// Setting share limit to zero actually pause the vault's ability to mint
    /// and stops charging fees from the vault
    /// @param _vault vault address
    /// @param _shareLimit new share limit
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function updateShareLimit(address _vault, uint256 _shareLimit) external onlyRole(VAULT_MASTER_ROLE) {
        if (_vault == address(0)) revert VaultZeroAddress();
        _checkShareLimitUpperBound(_vault, _shareLimit);

        VaultSocket storage socket = _connectedSocket(_vault);

        socket.shareLimit = uint96(_shareLimit);

        emit ShareLimitUpdated(_vault, _shareLimit);
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
        if (_vault == address(0)) revert VaultZeroAddress();
        _checkShareLimitUpperBound(_vault, _shareLimit);
        if (msg.sender != LIDO_LOCATOR.operatorGrid()) revert NotAuthorized();

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 totalValue_ = totalValue(_vault);
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
        if (_vault == address(0)) revert VaultZeroAddress();

        _disconnect(_vault);
    }

    function _disconnect(address _vault) internal withObligationsFulfilled(_vault) {
        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 liabilityShares = socket.liabilityShares;
        if (liabilityShares > 0) {
            revert NoLiabilitySharesShouldBeLeft(_vault, liabilityShares);
        }

        socket.pendingDisconnect = true;

        emit VaultDisconnected(_vault);
    }

    /// @notice Permissionless update of the vault data
    /// @param _vault the address of the vault
    /// @param _totalValue the total value of the vault
    /// @param _inOutDelta the inOutDelta of the vault
    /// @param _feeCharged the feeCharged of the vault
    /// @param _liabilityShares the liabilityShares of the vault
    function updateSocket(
        address _vault,
        uint64 _timestamp,
        uint256 _totalValue,
        int256 _inOutDelta,
        uint256 _feeCharged,
        uint256 _liabilityShares
    ) external {
        if (msg.sender != LIDO_LOCATOR.lazyOracle()) revert NotAuthorized();

        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 vaultIndex = $.vaultIndex[_vault];
        if (vaultIndex == 0) revert NotConnectedToHub(_vault);

        VaultSocket storage socket = $.sockets[vaultIndex];
        if (_feeCharged < socket.settledTreasuryFees) {
            revert InvalidFees(_vault, _feeCharged, socket.settledTreasuryFees);
        }

        uint256 newLiabilityShares = Math256.max(socket.liabilityShares, _liabilityShares);
        // locked ether can only be increased asynchronously once the oracle settled the new floor value
        // as of reference slot to prevent slashing upsides in between the report gathering and delivering
        uint256 lockedEther = Math256.max(
            LIDO.getPooledEthBySharesRoundUp(newLiabilityShares) * TOTAL_BASIS_POINTS / (TOTAL_BASIS_POINTS - socket.reserveRatioBP),
            socket.pendingDisconnect ? 0 : CONNECT_DEPOSIT
        );

        socket.report.totalValue = uint128(_totalValue);
        socket.report.inOutDelta = int128(_inOutDelta);
        socket.report.timestamp = _timestamp;
        socket.locked = uint128(lockedEther);
        socket.liabilityShares = uint96(newLiabilityShares);
        socket.obligations.treasuryFees = uint96(_feeCharged - socket.settledTreasuryFees);

        // TODO: emit event

        if (socket.pendingDisconnect) {
            _releaseVault(vaultIndex);
        }
    }

    function setWithdrawalsObligation(address _vault, uint256 _amount) external onlyRole(SET_WITHDRAWALS_OBLIGATION_ROLE) {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (_amount > socket.locked) {
            revert InsufficientLockForWithdrawals(_vault, _amount, socket.locked);
        }

        socket.obligations.withdrawals = uint96(_amount);
        emit WithdrawalsObligationSet(_vault, _amount);
    }

    function mintVaultsTreasuryFeeShares(uint256 _amountOfShares) external {
        if (msg.sender != LIDO_LOCATOR.accounting()) revert NotAuthorized();
        LIDO.mintExternalShares(LIDO_LOCATOR.treasury(), _amountOfShares);
    }

    function _connectedSocket(address _vault) internal view returns (VaultSocket storage) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 index = $.vaultIndex[_vault];
        if (index == 0 || $.sockets[index].pendingDisconnect) revert NotConnectedToHub(_vault);
        return $.sockets[index];
    }

    function _getVaultHubStorage() internal pure returns (VaultHubStorage storage $) {
        assembly {
            $.slot := VAULT_HUB_STORAGE_LOCATION
        }
    }

    function _isManager(address _account, address _vault) internal view returns (bool) {
        return _account == _connectedSocket(_vault).manager;
    }

    /// @dev check if the share limit is within the upper bound set by RELATIVE_SHARE_LIMIT_BP
    function _checkShareLimitUpperBound(address _vault, uint256 _shareLimit) internal view {
        uint256 relativeMaxShareLimitPerVault = (LIDO.getTotalShares() * RELATIVE_SHARE_LIMIT_BP) / TOTAL_BASIS_POINTS;
        if (_shareLimit > relativeMaxShareLimitPerVault) {
            revert ShareLimitTooHigh(_vault, _shareLimit, relativeMaxShareLimitPerVault);
        }
    }

    modifier withObligationsFulfilled(address _vault) {
        VaultSocket storage socket = _connectedSocket(_vault);
        Obligations memory obligations_ = socket.obligations;

        uint256 valutBalance = address(socket.vault).balance;
        uint256 valutObligations = uint256(int256(int96(obligations_.treasuryFees) + int96(obligations_.withdrawals)));
        if (valutBalance < valutObligations) {
            revert ObligationsNotFulfilled(socket.vault, valutObligations, valutBalance);
        }
        _;
    }

    function _releaseVault(uint256 _vaultIndex) internal {
        VaultHubStorage storage $ = _getVaultHubStorage();
        VaultSocket storage socket = $.sockets[_vaultIndex];
        address vaultAddress = socket.vault;

        VaultSocket memory lastSocket = $.sockets[$.sockets.length - 1];
        $.sockets[_vaultIndex] = lastSocket;
        $.vaultIndex[lastSocket.vault] = _vaultIndex;
        $.sockets.pop();

        delete $.vaultIndex[vaultAddress];

        Ownable2StepUpgradeable(vaultAddress).transferOwnership(socket.manager);
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
    event ForcedValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);
    event WithdrawalsObligationSet(address indexed vault, uint256 amount);

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
    error InvalidPubkeysLength();
    error RelativeShareLimitBPTooHigh(uint256 relativeShareLimitBP, uint256 totalBasisPoints);
    error VaultDepositorNotAllowed(address depositor);
    error InvalidProof();
    error InvalidFees(address vault, uint256 newFees, uint256 oldFees);
    error VaultInsufficientLocked(address vault, uint256 currentLocked, uint256 expectedLocked);
    error VaultOssified(address vault);
    error VaultInsufficientBalance(address vault, uint256 currentBalance, uint256 expectedBalance);
    error VaultReportStaled(address vault);
    error VaultHubMustBeOwner(address vault);
    error VaultHubMustBeDepositor(address vault);
    error VaultProxyZeroCodehash();
    error InvalidOperator();
    error VaultHubNotPendingOwner(address vault);

    error InsufficientLockForWithdrawals(address vault, uint256 amountToWithdraw, uint256 locked);
    error ObligationsNotFulfilled(address vault, uint256 obligations, uint256 balance);
}
