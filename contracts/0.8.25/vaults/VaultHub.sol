// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "../interfaces/ILido.sol";
import {OperatorGrid} from "./OperatorGrid.sol";
import {ReportHelper} from "./ReportHelper.sol";

import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";

import {Math256} from "contracts/common/lib/Math256.sol";

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
        /// @notice root of the vaults data tree
        bytes32 vaultsDataTreeRoot;
        /// @notice CID of the vaults data tree
        string vaultsDataReportCid;
        /// @notice timestamp of the vaults data
        uint64 vaultsDataTimestamp;
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

    // todo: optimize storage layout
    struct VaultSocket {
        // ### 1st slot
        /// @notice vault address
        address vault;
        /// @notice vault manager address
        address manager;
        Report report;
        uint128 locked;
        int128 inOutDelta;
        /// @notice true if connection not confirmed by the report
        bool pendingConnect;
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
        /// @notice cumulative amount of shares charged as fees for the vault
        uint96 feeSharesCharged;
        /// @notice unused gap in the slot 2
        /// uint8 _unused_gap_;
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

    /// @notice ReportHelper contract
    ReportHelper public immutable REPORT_HELPER;

    /// @param _locator Lido Locator contract
    /// @param _lido Lido stETH contract
    /// @param _relativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(ILidoLocator _locator, ILido _lido, uint256 _relativeShareLimitBP, address _reportHelper) {
        if (_relativeShareLimitBP == 0) revert ZeroArgument("_relativeShareLimitBP");
        if (_relativeShareLimitBP > TOTAL_BASIS_POINTS)
            revert RelativeShareLimitBPTooHigh(_relativeShareLimitBP, TOTAL_BASIS_POINTS);

        LIDO_LOCATOR = _locator;
        LIDO = _lido;
        RELATIVE_SHARE_LIMIT_BP = _relativeShareLimitBP;
        REPORT_HELPER = ReportHelper(_reportHelper);

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
        _storage().sockets.push(
            VaultSocket(address(0), address(0), Report(0, 0, 0), 0, 0, false, 0, 0, 0, 0, 0, false, 0)
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

        VaultHubStorage storage $ = _storage();
        if ($.vaultProxyCodehash[_codehash]) revert AlreadyExists(_codehash);
        $.vaultProxyCodehash[_codehash] = true;
        emit VaultProxyCodehashAdded(_codehash);
    }

    /// @notice returns the number of vaults connected to the hub
    function vaultsCount() public view returns (uint256) {
        return _storage().sockets.length - 1;
    }

    /// @param _index index of the vault
    /// @return vault address
    function vault(uint256 _index) public view returns (address) {
        return _storage().sockets[_index + 1].vault;
    }

    /// @param _index index of the vault
    /// @return vault socket
    function vaultSocket(uint256 _index) external view returns (VaultSocket memory) {
        return _storage().sockets[_index + 1];
    }

    /// @param _vault vault address
    /// @return vault socket
    function vaultSocket(address _vault) external view returns (VaultSocket memory) {
        VaultHubStorage storage $ = _storage();
        return $.sockets[$.vaultIndex[_vault]];
    }

    function totalValue(address _vault) public view returns (uint256) {
        VaultHubStorage storage $ = _storage();
        VaultSocket storage socket = $.sockets[$.vaultIndex[_vault]];
        return uint256(int256(int128(socket.report.totalValue) + socket.inOutDelta - socket.report.inOutDelta));
    }

    function isReportFresh(address _vault) public view returns (bool) {
        VaultSocket storage socket = _socket(_vault);
        return block.timestamp - socket.report.timestamp < REPORT_FRESHNESS_DELTA;
    }

    /// @notice checks if the vault is healthy by comparing its total value after applying rebalance threshold
    ///         against current liability shares
    /// @param _vault vault address
    /// @return true if vault is healthy, false otherwise
    function isVaultHealthyAsOfLatestReport(address _vault) public view returns (bool) {
        VaultSocket storage socket = _socket(_vault);
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

        VaultSocket storage socket = _socket(_vault);

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

    function cancelPendingConnect(address _vault) external {
        VaultHubStorage storage $ = _storage();
        VaultSocket storage socket = _socket(_vault);

        if (msg.sender != socket.manager) revert NotAuthorized();

        if (socket.pendingConnect) {
            address vaultAddress = socket.vault;
            uint256 vaultIndex = $.vaultIndex[vaultAddress];
            VaultSocket memory lastSocket = $.sockets[$.sockets.length - 1];
            $.sockets[vaultIndex] = lastSocket;
            $.vaultIndex[lastSocket.vault] = vaultIndex;
            $.sockets.pop();
            delete $.vaultIndex[vaultAddress];
        }
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

    /// @notice returns the latest report data
    /// @return timestamp of the report
    /// @return treeRoot of the report
    /// @return reportCid of the report
    function latestReportData() external view returns (uint64 timestamp, bytes32 treeRoot, string memory reportCid) {
        VaultHubStorage storage $ = _storage();
        return ($.vaultsDataTimestamp, $.vaultsDataTreeRoot, $.vaultsDataReportCid);
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    function connectVault(address _vault, address _manager) external {
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

        IStakingVault vault_ = IStakingVault(_vault);
        if (vault_.isOssified()) revert VaultOssified(_vault);
        if (vault_.owner() != address(this)) revert VaultHubMustBeOwner(_vault);
        _checkShareLimitUpperBound(_vault, _shareLimit);

        VaultHubStorage storage $ = _storage();
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
            true, // pendingConnect
            0, // liabilityShares
            uint96(_shareLimit),
            uint16(_reserveRatioBP),
            uint16(_forcedRebalanceThresholdBP),
            uint16(_treasuryFeeBP),
            false, // pendingDisconnect
            0
        );
        $.vaultIndex[_vault] = $.sockets.length;
        $.sockets.push(vsocket);

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

        VaultSocket storage socket = _socket(_vault);

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

        VaultSocket storage socket = _socket(_vault);

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

    function updateReportData(
        uint64 _vaultsDataTimestamp,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataReportCid
    ) external {
        if (msg.sender != LIDO_LOCATOR.accounting()) revert NotAuthorized();

        VaultHubStorage storage $ = _storage();
        $.vaultsDataTimestamp = _vaultsDataTimestamp;
        $.vaultsDataTreeRoot = _vaultsDataTreeRoot;
        $.vaultsDataReportCid = _vaultsDataReportCid;
        emit VaultsReportDataUpdated(_vaultsDataTimestamp, _vaultsDataTreeRoot, _vaultsDataReportCid);
    }

    /// @notice force disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    /// @dev vault's `liabilityShares` should be zero
    function disconnect(address _vault) external onlyRole(VAULT_MASTER_ROLE) {
        if (_vault == address(0)) revert VaultZeroAddress();

        _disconnect(_vault);
    }

    function _disconnect(address _vault) internal {
        VaultSocket storage socket = _socket(_vault);

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
    /// @param _feeSharesCharged the feeSharesCharged of the vault
    /// @param _liabilityShares the liabilityShares of the vault
    /// @param _proof the proof of the reported data
    function updateVaultData(
        address _vault,
        uint256 _totalValue,
        int256 _inOutDelta,
        uint256 _feeSharesCharged,
        uint256 _liabilityShares,
        bytes32[] calldata _proof
    ) external {
        VaultHubStorage storage $ = _storage();
        uint256 vaultIndex = $.vaultIndex[_vault];
        if (vaultIndex == 0) revert NotConnectedToHub(_vault);

        if (
            !REPORT_HELPER.isValidProof(
                _vault,
                _proof,
                $.vaultsDataTreeRoot,
                _totalValue,
                _inOutDelta,
                _feeSharesCharged,
                _liabilityShares
            )
        ) revert InvalidProof();

        VaultSocket storage socket = $.sockets[vaultIndex];
        // NB: charged fees can only cumulatively increase with time
        if (_feeSharesCharged < socket.feeSharesCharged) {
            revert InvalidFees(_vault, _feeSharesCharged, socket.feeSharesCharged);
        }
        socket.liabilityShares += uint96(_feeSharesCharged - socket.feeSharesCharged);
        socket.feeSharesCharged = uint96(_feeSharesCharged);

        uint256 newLiabilityShares = Math256.max(socket.liabilityShares, _liabilityShares);
        // locked ether can only be increased asynchronously once the oracle settled the new floor value
        // as of reference slot to prevent slashing upsides in between the report gathering and delivering
        uint256 lockedEther = Math256.max(
            (LIDO.getPooledEthBySharesRoundUp(newLiabilityShares) * TOTAL_BASIS_POINTS) /
                (TOTAL_BASIS_POINTS - socket.reserveRatioBP),
            socket.pendingDisconnect ? 0 : CONNECT_DEPOSIT
        );

        socket.report.totalValue = uint128(_totalValue);
        socket.report.inOutDelta = int128(_inOutDelta);
        socket.report.timestamp = uint64($.vaultsDataTimestamp);
        socket.locked = uint128(lockedEther);

        uint256 length = $.sockets.length;
        if (socket.pendingDisconnect) {
            // remove disconnected vault from the list
            address vaultAddress = socket.vault;
            VaultSocket memory lastSocket = $.sockets[length - 1];
            $.sockets[vaultIndex] = lastSocket;
            $.vaultIndex[lastSocket.vault] = vaultIndex;
            $.sockets.pop();
            delete $.vaultIndex[vaultAddress];
        }
    }

    function mintVaultsTreasuryFeeShares(uint256 _amountOfShares) external {
        if (msg.sender != LIDO_LOCATOR.accounting()) revert NotAuthorized();
        LIDO.mintExternalShares(LIDO_LOCATOR.treasury(), _amountOfShares);
    }

    function _socket(address _vault) internal view returns (VaultSocket storage) {
        VaultHubStorage storage $ = _storage();
        uint256 index = $.vaultIndex[_vault];
        if (index == 0 || $.sockets[index].pendingDisconnect) revert NotConnectedToHub(_vault);
        return $.sockets[index];
    }

    function _storage() internal pure returns (VaultHubStorage storage $) {
        assembly {
            $.slot := VAULT_HUB_STORAGE_LOCATION
        }
    }

    function _isManager(address _account, address _vault) internal view returns (bool) {
        return _account == _socket(_vault).manager;
    }

    /// @dev check if the share limit is within the upper bound set by RELATIVE_SHARE_LIMIT_BP
    function _checkShareLimitUpperBound(address _vault, uint256 _shareLimit) internal view {
        uint256 relativeMaxShareLimitPerVault = (LIDO.getTotalShares() * RELATIVE_SHARE_LIMIT_BP) / TOTAL_BASIS_POINTS;
        if (_shareLimit > relativeMaxShareLimitPerVault) {
            revert ShareLimitTooHigh(_vault, _shareLimit, relativeMaxShareLimitPerVault);
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
    event ForcedValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);

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
    error VaultProxyZeroCodehash();
    error InvalidOperator();
}
