// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {MerkleProof} from "@openzeppelin/contracts-v5.2/utils/cryptography/MerkleProof.sol";
import {OperatorGrid} from "./OperatorGrid.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "../interfaces/ILido.sol";

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

    struct VaultSocket {
        // ### 1st slot
        /// @notice vault address
        address vault;
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
        /// @notice infra fee in basis points
        uint16 infraFeeBP;
        /// @notice liquidity fee in basis points
        uint16 liquidityFeeBP;
        /// @notice reservation fee in basis points
        uint16 reservationFeeBP;
        /// @notice if true, vault is disconnected and fee is not accrued
        bool pendingDisconnect;
        /// @notice unused gap in the slot 2
        /// uint72 _unused_gap_;
        // ### 3rd slot
        /// @notice cumulative amount of shares charged as fees for the vault
        uint96 feeSharesCharged;
        /// @notice unused gap in the slot 3
        /// uint160 _unused_gap_;
    }

    struct VaultInfo {
        address vault;
        uint256 balance;
        int256 inOutDelta;
        bytes32 withdrawalCredentials;
        uint256 liabilityShares;
        uint96 shareLimit;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 infraFeeBP;
        uint16 liquidityFeeBP;
        uint16 reservationFeeBP;
        bool pendingDisconnect;
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

    /// @param _locator Lido Locator contract
    /// @param _lido Lido stETH contract
    /// @param _relativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(
        ILidoLocator _locator,
        ILido _lido,
        uint256 _relativeShareLimitBP
    ) {
        if (_relativeShareLimitBP == 0) revert ZeroArgument("_relativeShareLimitBP");
        if (_relativeShareLimitBP > TOTAL_BASIS_POINTS)
            revert RelativeShareLimitBPTooHigh(_relativeShareLimitBP, TOTAL_BASIS_POINTS);

        LIDO_LOCATOR = _locator;
        LIDO = _lido;
        RELATIVE_SHARE_LIMIT_BP = _relativeShareLimitBP;

        _disableInitializers();
    }

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __VaultHub_init(_admin);
    }

    /// @param _admin admin address to manage the roles
    function __VaultHub_init(address _admin) internal onlyInitializing {
        __AccessControlEnumerable_init();

        // the stone in the elevator
        _getVaultHubStorage().sockets.push(VaultSocket(address(0), 0, 0, 0, 0, 0, 0, 0, false, 0));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    function operatorGrid() external view returns (address) {
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

    /// @notice returns batch of vaults info
    /// @param _offset offset of the vault in the batch (indexes start from 0)
    /// @param _limit limit of the batch
    /// @return batch of vaults info
    function batchVaultsInfo(uint256 _offset, uint256 _limit) external view returns (VaultInfo[] memory batch) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 limit = _offset + _limit > $.sockets.length - 1 ? $.sockets.length - 1 - _offset : _limit;
        batch = new VaultInfo[](limit);
        uint256 startIndex = _offset + 1;
        for (uint256 i = 0; i < limit; i++) {
            VaultSocket memory socket = $.sockets[startIndex + i];
            IStakingVault currentVault = IStakingVault(socket.vault);
            batch[i] = VaultInfo(
                address(currentVault),
                address(currentVault).balance,
                currentVault.inOutDelta(),
                currentVault.withdrawalCredentials(),
                socket.liabilityShares,
                socket.shareLimit,
                socket.reserveRatioBP,
                socket.forcedRebalanceThresholdBP,
                socket.infraFeeBP,
                socket.liquidityFeeBP,
                socket.reservationFeeBP,
                socket.pendingDisconnect
            );
        }
    }

    /// @notice checks if the vault is healthy by comparing its total value after applying rebalance threshold
    ///         against current liability shares
    /// @param _vault vault address
    /// @return true if vault is healthy, false otherwise
    function isVaultHealthyAsOfLatestReport(address _vault) public view returns (bool) {
        VaultSocket storage socket = _connectedSocket(_vault);
        return _isVaultHealthyByThreshold(
            IStakingVault(_vault).totalValue(),
            socket.liabilityShares,
            socket.forcedRebalanceThresholdBP
        );
    }

    function _isVaultHealthyByThreshold(
        uint256 _totalValue,
        uint256 _liabilityShares,
        uint256 _checkThreshold
    ) internal view returns (bool) {
        if (_liabilityShares == 0) return true;

        return
            ((_totalValue * (TOTAL_BASIS_POINTS - _checkThreshold)) /
                TOTAL_BASIS_POINTS) >= LIDO.getPooledEthBySharesRoundUp(_liabilityShares);
    }

    /// @notice estimate ether amount to make the vault healthy using rebalance
    /// @param _vault vault address
    /// @return amount to rebalance  or UINT256_MAX if it's impossible to make the vault healthy using rebalance
    function rebalanceShortfall(address _vault) public view returns (uint256) {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        bool isHealthy = isVaultHealthyAsOfLatestReport(_vault);

        // Health vault do not need to rebalance
        if (isHealthy) {
            return 0;
        }

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 liabilityStETH = LIDO.getPooledEthBySharesRoundUp(socket.liabilityShares);
        uint256 reserveRatioBP = socket.reserveRatioBP;
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);
        uint256 totalValue = IStakingVault(_vault).totalValue();

        // Impossible to rebalance a vault with deficit
        if (liabilityStETH >= totalValue) {
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

        return (liabilityStETH * TOTAL_BASIS_POINTS - totalValue * maxMintableRatio) / reserveRatioBP;
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    function connectVault(address _vault) external {
        (
        /* address nodeOperator */,
        /* uint256 tierId */,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 infraFeeBP,
            uint256 liquidityFeeBP,
            uint256 reservationFeeBP
        ) = OperatorGrid(LIDO_LOCATOR.operatorGrid()).vaultInfo(_vault);
        _connectVault(_vault, shareLimit, reserveRatioBP, forcedRebalanceThresholdBP, infraFeeBP, liquidityFeeBP, reservationFeeBP);
    }

    /// @notice returns the latest report data
    /// @return timestamp of the report
    /// @return treeRoot of the report
    /// @return reportCid of the report
    function latestReportData() external view returns (
        uint64 timestamp,
        bytes32 treeRoot,
        string memory reportCid
    ) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        return (
            $.vaultsDataTimestamp,
            $.vaultsDataTreeRoot,
            $.vaultsDataReportCid
        );
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _reserveRatioBP minimum reserve ratio in basis points
    /// @param _forcedRebalanceThresholdBP threshold to force rebalance on the vault in basis points
    /// @param _infraFeeBP infra fee in basis points
    /// @param _liquidityFeeBP liquidity fee in basis points
    /// @param _reservationFeeBP reservation fee in basis points
    function _connectVault(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) internal {
        if (_reserveRatioBP == 0) revert ZeroArgument("_reserveRatioBP");
        if (_reserveRatioBP > TOTAL_BASIS_POINTS)
            revert ReserveRatioTooHigh(_vault, _reserveRatioBP, TOTAL_BASIS_POINTS);
        if (_forcedRebalanceThresholdBP == 0) revert ZeroArgument("_forcedRebalanceThresholdBP");
        if (_forcedRebalanceThresholdBP > _reserveRatioBP)
            revert ForcedRebalanceThresholdTooHigh(_vault, _forcedRebalanceThresholdBP, _reserveRatioBP);
        if (_infraFeeBP > TOTAL_BASIS_POINTS) revert InfraFeeTooHigh(_vault, _infraFeeBP, TOTAL_BASIS_POINTS);
        if (_liquidityFeeBP > TOTAL_BASIS_POINTS) revert LiquidityFeeTooHigh(_vault, _liquidityFeeBP, TOTAL_BASIS_POINTS);
        if (_reservationFeeBP > TOTAL_BASIS_POINTS) revert ReservationFeeTooHigh(_vault, _reservationFeeBP, TOTAL_BASIS_POINTS);

        IStakingVault vault_ = IStakingVault(_vault);
        if (vault_.ossified()) revert VaultOssified(_vault);
        if (!vault_.vaultHubAuthorized()) revert VaultDeauthorized(_vault);
        _checkShareLimitUpperBound(_vault, _shareLimit);

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultIndex[_vault] != 0) revert AlreadyConnected(_vault, $.vaultIndex[_vault]);

        bytes32 vaultProxyCodehash = address(_vault).codehash;
        if (!$.vaultProxyCodehash[vaultProxyCodehash]) revert VaultProxyNotAllowed(_vault, vaultProxyCodehash);

        if (vault_.depositor() != LIDO_LOCATOR.predepositGuarantee())
            revert VaultDepositorNotAllowed(vault_.depositor());

        if (vault_.locked() < CONNECT_DEPOSIT)
            revert VaultInsufficientLocked(_vault, vault_.locked(), CONNECT_DEPOSIT);
        if (_vault.balance < CONNECT_DEPOSIT)
            revert VaultInsufficientBalance(_vault, _vault.balance, CONNECT_DEPOSIT);

        VaultSocket memory vsocket = VaultSocket(
            _vault,
            0, // liabilityShares
            uint96(_shareLimit),
            uint16(_reserveRatioBP),
            uint16(_forcedRebalanceThresholdBP),
            uint16(_infraFeeBP),
            uint16(_liquidityFeeBP),
            uint16(_reservationFeeBP),
            false, // pendingDisconnect
            0 // feeSharesCharged
        );
        $.vaultIndex[_vault] = $.sockets.length;
        $.sockets.push(vsocket);

        // here we intentionally prohibit all reports having referenceSlot earlier than the current block;
        vault_.report(uint64(block.timestamp), _vault.balance, vault_.inOutDelta(), vault_.locked());

        emit VaultConnectionSet(_vault, _shareLimit, _reserveRatioBP, _forcedRebalanceThresholdBP, _infraFeeBP, _liquidityFeeBP, _reservationFeeBP);
    }

    /// @notice updates share limit for the vault
    /// Setting share limit to zero actually pause the vault's ability to mint
    /// and stops charging fees from the vault
    /// @param _vault vault address
    /// @param _shareLimit new share limit
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function updateShareLimit(address _vault, uint256 _shareLimit) external onlyRole(VAULT_MASTER_ROLE) {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        _checkShareLimitUpperBound(_vault, _shareLimit);

        VaultSocket storage socket = _connectedSocket(_vault);

        socket.shareLimit = uint96(_shareLimit);

        emit ShareLimitUpdated(_vault, _shareLimit);
    }

    /// @notice updates fees for the vault
    /// @param _vault vault address
    /// @param _infraFeeBP new infra fee
    /// @param _liquidityFeeBP new liquidity fee
    /// @param _reservationFeeBP new reservation fee
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function updateVaultFees(address _vault, uint256 _infraFeeBP, uint256 _liquidityFeeBP, uint256 _reservationFeeBP) external onlyRole(VAULT_MASTER_ROLE) {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_infraFeeBP > TOTAL_BASIS_POINTS) revert InfraFeeTooHigh(_vault, _infraFeeBP, TOTAL_BASIS_POINTS);
        if (_liquidityFeeBP > TOTAL_BASIS_POINTS) revert LiquidityFeeTooHigh(_vault, _liquidityFeeBP, TOTAL_BASIS_POINTS);
        if (_reservationFeeBP > TOTAL_BASIS_POINTS) revert ReservationFeeTooHigh(_vault, _reservationFeeBP, TOTAL_BASIS_POINTS);

        VaultSocket storage socket = _connectedSocket(_vault);

        socket.infraFeeBP = uint16(_infraFeeBP);
        socket.liquidityFeeBP = uint16(_liquidityFeeBP);
        socket.reservationFeeBP = uint16(_reservationFeeBP);

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
        if (_vault == address(0)) revert ZeroArgument("_vault");
        _checkShareLimitUpperBound(_vault, _shareLimit);
        if (msg.sender != LIDO_LOCATOR.operatorGrid()) revert NotAuthorized("updateConnection", msg.sender);

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 totalValue = IStakingVault(_vault).totalValue();
        uint256 liabilityShares = socket.liabilityShares;

        // check healthy with new rebalance threshold
        if (!_isVaultHealthyByThreshold(totalValue, liabilityShares, _reserveRatioBP))
            revert VaultMintingCapacityExceeded(_vault, totalValue, liabilityShares, _reserveRatioBP);

        socket.shareLimit = uint96(_shareLimit);
        socket.reserveRatioBP = uint16(_reserveRatioBP);
        socket.forcedRebalanceThresholdBP = uint16(_forcedRebalanceThresholdBP);
        socket.infraFeeBP = uint16(_infraFeeBP);
        socket.liquidityFeeBP = uint16(_liquidityFeeBP);
        socket.reservationFeeBP = uint16(_reservationFeeBP);

        emit VaultConnectionSet(_vault, _shareLimit, _reserveRatioBP, _forcedRebalanceThresholdBP, _infraFeeBP, _liquidityFeeBP, _reservationFeeBP);
    }

    function updateReportData(
        uint64 _vaultsDataTimestamp,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataReportCid
    ) external {
        if (msg.sender != LIDO_LOCATOR.accounting()) revert NotAuthorized("updateReportData", msg.sender);

        VaultHubStorage storage $ = _getVaultHubStorage();
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
        if (_vault == address(0)) revert ZeroArgument("_vault");

        _disconnect(_vault);
    }

    /// @notice disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    /// @dev vault's `liabilityShares` should be zero
    function voluntaryDisconnect(address _vault) external whenResumed {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        _vaultAuth(_vault, "disconnect");

        _disconnect(_vault);
    }

    /// @notice mint StETH shares backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _amountOfShares amount of stETH shares to mint
    /// @dev msg.sender should be vault's owner
    function mintShares(address _vault, address _recipient, uint256 _amountOfShares) external whenResumed {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");

        _vaultAuth(_vault, "mint");

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 vaultSharesAfterMint = socket.liabilityShares + _amountOfShares;
        uint256 shareLimit = socket.shareLimit;
        if (vaultSharesAfterMint > shareLimit) revert ShareLimitExceeded(_vault, shareLimit);

        IStakingVault vault_ = IStakingVault(_vault);
        if (!vault_.isReportFresh()) revert VaultReportStaled(_vault);

        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - socket.reserveRatioBP;
        uint256 maxMintableEther = (vault_.totalValue() * maxMintableRatioBP) / TOTAL_BASIS_POINTS;
        uint256 stETHAfterMint = LIDO.getPooledEthBySharesRoundUp(vaultSharesAfterMint);
        if (stETHAfterMint > maxMintableEther) {
            revert InsufficientTotalValueToMint(_vault, vault_.totalValue());
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 minLocked = (stETHAfterMint * TOTAL_BASIS_POINTS) / maxMintableRatioBP;

        if (minLocked > vault_.locked()) {
            revert VaultInsufficientLocked(_vault, vault_.locked(), minLocked);
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
    /// @dev VaultHub must have all the stETH on its balance
    function burnShares(address _vault, uint256 _amountOfShares) public whenResumed {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");
        _vaultAuth(_vault, "burn");

        VaultSocket storage socket = _connectedSocket(_vault);

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

    /// @notice permissionless rebalance for unhealthy vaults
    /// @param _vault vault address
    /// @dev rebalance all available amount of ether until the vault is healthy
    function forceRebalance(address _vault) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        uint256 maxAmountToRebalance = rebalanceShortfall(_vault);
        if (maxAmountToRebalance == 0) revert AlreadyHealthy(_vault);
        uint256 amountToRebalance = Math256.min(maxAmountToRebalance, _vault.balance);

        // TODO: add some gas compensation here
        IStakingVault(_vault).rebalance(amountToRebalance);
    }

    /// @notice rebalances the vault by writing off the amount of ether equal
    ///     to `msg.value` from the vault's liability stETH
    /// @dev msg.sender should be vault's contract
    function rebalance() external payable whenResumed {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        VaultSocket storage socket = _connectedSocket(msg.sender);

        uint256 sharesToBurn = LIDO.getSharesByPooledEth(msg.value);
        uint256 liabilityShares = socket.liabilityShares;
        if (liabilityShares < sharesToBurn) revert InsufficientSharesToBurn(msg.sender, liabilityShares);

        socket.liabilityShares = uint96(liabilityShares - sharesToBurn);

        LIDO.rebalanceExternalEtherToInternal{value: msg.value}();

        emit VaultRebalanced(msg.sender, sharesToBurn);
    }

    /// @notice Forces validator exit from the beacon chain when vault is unhealthy
    /// @param _vault The address of the vault to exit validators from
    /// @param _pubkeys The public keys of the validators to exit
    /// @param _refundRecipient The address that will receive the refund for transaction costs
    /// @dev    When the vault becomes unhealthy, anyone can force its validators to exit the beacon chain
    ///         This returns the vault's deposited ETH back to vault's balance and allows to rebalance the vault
    function forceValidatorExit(address _vault, bytes calldata _pubkeys, address _refundRecipient) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_refundRecipient == address(0)) revert ZeroArgument("_refundRecipient");
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) revert InvalidPubkeysLength();
        if (isVaultHealthyAsOfLatestReport(_vault)) revert AlreadyHealthy(_vault);

        uint256 numValidators = _pubkeys.length / PUBLIC_KEY_LENGTH;
        uint64[] memory amounts = new uint64[](numValidators);

        IStakingVault(_vault).triggerValidatorWithdrawal{value: msg.value}(_pubkeys, amounts, _refundRecipient);

        emit ForcedValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
    }

    function _disconnect(address _vault) internal {
        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 liabilityShares = socket.liabilityShares;
        if (liabilityShares > 0) {
            revert NoLiabilitySharesShouldBeLeft(_vault, liabilityShares);
        }

        socket.pendingDisconnect = true;

        emit VaultDisconnectInitiated(_vault);
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
        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 vaultIndex = $.vaultIndex[_vault];
        if (vaultIndex == 0) revert NotConnectedToHub(_vault);

        bytes32 root = $.vaultsDataTreeRoot;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(_vault, _totalValue, _inOutDelta, _feeSharesCharged, _liabilityShares))));
        if (!MerkleProof.verify(_proof, root, leaf)) revert InvalidProof();

        VaultSocket storage socket = $.sockets[vaultIndex];
        // NB: charged fees can only cumulatively increase with time
        if (_feeSharesCharged  < socket.feeSharesCharged) {
            revert InvalidFees(_vault, _feeSharesCharged, socket.feeSharesCharged);
        }
        socket.liabilityShares += uint96(_feeSharesCharged - socket.feeSharesCharged);
        socket.feeSharesCharged = uint96(_feeSharesCharged);

        uint256 newLiabilityShares = Math256.max(socket.liabilityShares, _liabilityShares);
        // locked ether can only be increased asynchronously once the oracle settled the new floor value
        // as of reference slot to prevent slashing upsides in between the report gathering and delivering
        uint256 lockedEther = Math256.max(
            LIDO.getPooledEthBySharesRoundUp(newLiabilityShares) * TOTAL_BASIS_POINTS / (TOTAL_BASIS_POINTS - socket.reserveRatioBP),
            socket.pendingDisconnect ? 0 : CONNECT_DEPOSIT
        );

        IStakingVault(socket.vault).report($.vaultsDataTimestamp, _totalValue, _inOutDelta, lockedEther);

        uint256 length = $.sockets.length;
        if (socket.pendingDisconnect) {
            // remove disconnected vault from the list
            address vaultAddress = socket.vault;
            VaultSocket memory lastSocket = $.sockets[length - 1];
            $.sockets[vaultIndex] = lastSocket;
            $.vaultIndex[lastSocket.vault] = vaultIndex;
            $.sockets.pop();
            delete $.vaultIndex[vaultAddress];

            emit VaultDisconnectCompleted(vaultAddress);
        }
    }

    function mintVaultsTreasuryFeeShares(uint256 _amountOfShares) external {
        if (msg.sender != LIDO_LOCATOR.accounting()) revert NotAuthorized("mintVaultsTreasuryFeeShares", msg.sender);
        LIDO.mintExternalShares(LIDO_LOCATOR.treasury(), _amountOfShares);
    }

    function _vaultAuth(address _vault, string memory _operation) internal view {
        if (msg.sender != OwnableUpgradeable(_vault).owner()) revert NotAuthorized(_operation, msg.sender);
    }

    function _connectedSocket(address _vault) internal view returns (VaultSocket storage) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 index = $.vaultIndex[_vault];
        if (index == 0 || $.sockets[index].pendingDisconnect) revert NotConnectedToHub(_vault);
        return $.sockets[index];
    }

    function _getVaultHubStorage() private pure returns (VaultHubStorage storage $) {
        assembly {
            $.slot := VAULT_HUB_STORAGE_LOCATION
        }
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
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );

    event VaultsReportDataUpdated(uint64 indexed timestamp, bytes32 root, string cid);
    event ShareLimitUpdated(address indexed vault, uint256 newShareLimit);
    event VaultFeesUpdated(address indexed vault, uint256 infraFeeBP, uint256 liquidityFeeBP, uint256 reservationFeeBP);
    event VaultDisconnectInitiated(address indexed vault);
    event VaultDisconnectCompleted(address indexed vault);
    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned);
    event VaultProxyCodehashAdded(bytes32 indexed codehash);
    event ForcedValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);

    error AlreadyHealthy(address vault);
    error VaultMintingCapacityExceeded(address vault, uint256 totalValue, uint256 liabilityShares, uint256 newRebalanceThresholdBP);
    error InsufficientSharesToBurn(address vault, uint256 amount);
    error ShareLimitExceeded(address vault, uint256 shareLimit);
    error AlreadyConnected(address vault, uint256 index);
    error NotConnectedToHub(address vault);
    error NotAuthorized(string operation, address addr);
    error ZeroArgument(string argument);
    error ShareLimitTooHigh(address vault, uint256 shareLimit, uint256 maxShareLimit);
    error ReserveRatioTooHigh(address vault, uint256 reserveRatioBP, uint256 maxReserveRatioBP);
    error ForcedRebalanceThresholdTooHigh(address vault, uint256 forcedRebalanceThresholdBP, uint256 maxForcedRebalanceThresholdBP);
    error InfraFeeTooHigh(address vault, uint256 infraFeeBP, uint256 maxInfraFeeBP);
    error LiquidityFeeTooHigh(address vault, uint256 liquidityFeeBP, uint256 maxLiquidityFeeBP);
    error ReservationFeeTooHigh(address vault, uint256 reservationFeeBP, uint256 maxReservationFeeBP);
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
    error VaultDeauthorized(address vault);
    error VaultProxyZeroCodehash();
}
