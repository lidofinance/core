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

/// @notice VaultHub is a contract that manages vaults connected to the Lido protocol
/// It allows to connect vaults, disconnect them, mint and burn stETH
/// It also allows to force rebalance of the vaults
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
        string vaultsDataTreeCid;
        /// @notice timestamp of the vaults data
        uint64 vaultsDataTimestamp;
    }

    struct VaultSocket {
        // ### 1st slot
        /// @notice vault address
        address vault;
        /// @notice total number of stETH shares minted by the vault
        uint96 sharesMinted;
        // ### 2nd slot
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        /// @notice minimal share of ether that is reserved for each stETH minted
        uint16 reserveRatioBP;
        /// @notice if vault's reserve decreases to this threshold, it should be force rebalanced
        uint16 rebalanceThresholdBP;
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
        /// @notice if true, vault is disconnected and fee is not accrued
        bool pendingDisconnect;
        /// @notice last fees accrued on the vault
        uint96 feeSharesCharged;
        /// @notice unused gap in the slot 2
        /// uint8 _unused_gap_;
    }

    struct VaultInfo {
        address vault;
        uint256 balance;
        int256 inOutDelta;
        bytes32 withdrawalCredentials;
        uint256 sharesMinted;
    }

    // keccak256(abi.encode(uint256(keccak256("VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_HUB_STORAGE_LOCATION =
        0xb158a1a9015c52036ff69e7937a7bb424e82a8c4cbec5c5309994af06d825300;

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
        _getVaultHubStorage().sockets.push(VaultSocket(address(0), 0, 0, 0, 0, 0, false, 0));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    function operatorGrid() external view returns (address) {
        return LIDO_LOCATOR.operatorGrid();
    }

    /// @notice added vault proxy codehash to allowed list
    /// @param codehash vault proxy codehash
    function addVaultProxyCodehash(bytes32 codehash) public onlyRole(VAULT_REGISTRY_ROLE) {
        if (codehash == bytes32(0)) revert ZeroArgument("codehash");

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultProxyCodehash[codehash]) revert AlreadyExists(codehash);
        $.vaultProxyCodehash[codehash] = true;
        emit VaultProxyCodehashAdded(codehash);
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
    function batchVaultsInfo(uint256 _offset, uint256 _limit) external view returns (VaultInfo[] memory) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 limit = _offset + _limit > $.sockets.length - 1 ? $.sockets.length - 1 - _offset : _limit;
        VaultInfo[] memory batch = new VaultInfo[](limit);
        for (uint256 i = 0; i < limit; i++) {
            VaultSocket storage socket = $.sockets[i + 1 + _offset];
            IStakingVault currentVault = IStakingVault(socket.vault);
            batch[i] = VaultInfo(
                address(currentVault),
                address(currentVault).balance,
                currentVault.inOutDelta(),
                currentVault.withdrawalCredentials(),
                socket.sharesMinted
            );
        }
        return batch;
    }

    /// @notice checks if the vault is healthy by comparing its projected valuation after applying rebalance threshold
    ///         against the current value of minted shares
    /// @param _vault vault address
    /// @return true if vault is healthy, false otherwise
    function isVaultHealthyAsOfLatestReport(address _vault) public view returns (bool) {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (socket.sharesMinted == 0) return true;

        return
            ((IStakingVault(_vault).valuation() * (TOTAL_BASIS_POINTS - socket.rebalanceThresholdBP)) /
                TOTAL_BASIS_POINTS) >= LIDO.getPooledEthBySharesRoundUp(socket.sharesMinted);
    }

    /// @notice estimate ether amount to make the vault healthy using rebalance
    /// @param _vault vault address
    /// @return amount to rebalance
    function rebalanceShortfall(address _vault) public view returns (uint256) {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 mintedStETH = LIDO.getPooledEthBySharesRoundUp(socket.sharesMinted);
        uint256 reserveRatioBP = socket.reserveRatioBP;
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);
        uint256 valuation = IStakingVault(_vault).valuation();

        // to avoid revert below
        if (mintedStETH * TOTAL_BASIS_POINTS < valuation * maxMintableRatio) {
            // return MAX_UINT_256
            return type(uint256).max;
        }

        // (mintedStETH - X) / (vault.valuation() - X) = maxMintableRatio / TOTAL_BASIS_POINTS
        // (mintedStETH - X) * TOTAL_BASIS_POINTS = (vault.valuation() - X) * maxMintableRatio
        // mintedStETH * TOTAL_BASIS_POINTS - X * TOTAL_BASIS_POINTS = vault.valuation() * maxMintableRatio - X * maxMintableRatio
        // X * maxMintableRatio - X * TOTAL_BASIS_POINTS = vault.valuation() * maxMintableRatio - mintedStETH * TOTAL_BASIS_POINTS
        // X * (maxMintableRatio - TOTAL_BASIS_POINTS) = vault.valuation() * maxMintableRatio - mintedStETH * TOTAL_BASIS_POINTS
        // X = (vault.valuation() * maxMintableRatio - mintedStETH * TOTAL_BASIS_POINTS) / (maxMintableRatio - TOTAL_BASIS_POINTS)
        // X = (mintedStETH * TOTAL_BASIS_POINTS - vault.valuation() * maxMintableRatio) / (TOTAL_BASIS_POINTS - maxMintableRatio)
        // reserveRatio = TOTAL_BASIS_POINTS - maxMintableRatio
        // X = (mintedStETH * TOTAL_BASIS_POINTS - vault.valuation() * maxMintableRatio) / reserveRatio

        return (mintedStETH * TOTAL_BASIS_POINTS - valuation * maxMintableRatio) / reserveRatioBP;
    }

    /// @notice connects a vault to the hub in permissionless way, get limits from the Operator Grid
    /// @param _vault vault address
    function connectVault(address _vault) external {
        (
        /* address nodeOperator */,
        /* uint256 tierId */,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 reserveRatioThresholdBP,
            uint256 treasuryFeeBP
        ) = OperatorGrid(LIDO_LOCATOR.operatorGrid()).vaultInfo(_vault);
        _connectVault(_vault, shareLimit, reserveRatioBP, reserveRatioThresholdBP, treasuryFeeBP);
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _reserveRatioBP minimum reserve ratio in basis points
    /// @param _rebalanceThresholdBP threshold to force rebalance on the vault in basis points
    /// @param _treasuryFeeBP treasury fee in basis points
    function _connectVault(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _rebalanceThresholdBP,
        uint256 _treasuryFeeBP
    ) internal {
        if (_reserveRatioBP == 0) revert ZeroArgument("_reserveRatioBP");
        if (_reserveRatioBP > TOTAL_BASIS_POINTS)
            revert ReserveRatioTooHigh(_vault, _reserveRatioBP, TOTAL_BASIS_POINTS);
        if (_rebalanceThresholdBP == 0) revert ZeroArgument("_rebalanceThresholdBP");
        if (_rebalanceThresholdBP > _reserveRatioBP)
            revert RebalanceThresholdTooHigh(_vault, _rebalanceThresholdBP, _reserveRatioBP);
        if (_treasuryFeeBP > TOTAL_BASIS_POINTS) revert TreasuryFeeTooHigh(_vault, _treasuryFeeBP, TOTAL_BASIS_POINTS);

        IStakingVault vault_ = IStakingVault(_vault);
        if (vault_.ossified()) revert VaultOssified(_vault);
        _checkShareLimitUpperBound(_vault, _shareLimit);

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultIndex[_vault] != 0) revert AlreadyConnected(_vault, $.vaultIndex[_vault]);

        bytes32 vaultProxyCodehash = address(_vault).codehash;
        if (!$.vaultProxyCodehash[vaultProxyCodehash]) revert VaultProxyNotAllowed(_vault);

        if (vault_.depositor() != LIDO_LOCATOR.predepositGuarantee())
            revert VaultDepositorNotAllowed(vault_.depositor());

        if (vault_.locked() < CONNECT_DEPOSIT)
            revert VaultInsufficientLocked(_vault, vault_.locked(), CONNECT_DEPOSIT);
        if (_vault.balance < CONNECT_DEPOSIT)
            revert VaultInsufficientBalance(_vault, _vault.balance, CONNECT_DEPOSIT);

        VaultSocket memory vsocket = VaultSocket(
            _vault,
            0, // sharesMinted
            uint96(_shareLimit),
            uint16(_reserveRatioBP),
            uint16(_rebalanceThresholdBP),
            uint16(_treasuryFeeBP),
            false, // pendingDisconnect
            0
        );
        $.vaultIndex[_vault] = $.sockets.length;
        $.sockets.push(vsocket);

        // here we intentionally prohibit all reports having referenceSlot earlier than the current block;
        // if the vault is not connected to the hub, it will revert.
        vault_.report(uint64(block.timestamp), _vault.balance, vault_.inOutDelta(), vault_.locked());

        emit VaultConnected(_vault, _shareLimit, _reserveRatioBP, _rebalanceThresholdBP, _treasuryFeeBP);
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

    function updateConnection(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _rebalanceThresholdBP,
        uint256 _treasuryFeeBP
    ) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        _checkShareLimitUpperBound(_vault, _shareLimit);
        if (msg.sender != LIDO_LOCATOR.operatorGrid()) revert NotAuthorized("updateConnection", msg.sender);

        VaultSocket storage socket = _connectedSocket(_vault);

        socket.shareLimit = uint96(_shareLimit);
        socket.reserveRatioBP = uint16(_reserveRatioBP);
        socket.rebalanceThresholdBP = uint16(_rebalanceThresholdBP);
        socket.treasuryFeeBP = uint16(_treasuryFeeBP);

        emit VaultConnectionUpdated(_vault, _shareLimit, _reserveRatioBP, _rebalanceThresholdBP, _treasuryFeeBP);
    }

    function updateReportData(
        uint64 _vaultsDataTimestamp,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataTreeCid
    ) external {
        if (msg.sender != LIDO_LOCATOR.accounting()) revert NotAuthorized("updateReportData", msg.sender);

        VaultHubStorage storage $ = _getVaultHubStorage();
        $.vaultsDataTimestamp = _vaultsDataTimestamp;
        $.vaultsDataTreeRoot = _vaultsDataTreeRoot;
        $.vaultsDataTreeCid = _vaultsDataTreeCid;
        emit VaultsReportDataUpdated(_vaultsDataTimestamp, _vaultsDataTreeRoot, _vaultsDataTreeCid);
    }

    /// @notice force disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    /// @dev vault's `mintedShares` should be zero
    function disconnect(address _vault) external onlyRole(VAULT_MASTER_ROLE) {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        _disconnect(_vault);
    }

    /// @notice disconnects a vault from the hub
    /// @param _vault vault address
    /// @dev msg.sender should be vault's owner
    /// @dev vault's `mintedShares` should be zero
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

        uint256 vaultSharesAfterMint = socket.sharesMinted + _amountOfShares;
        uint256 shareLimit = socket.shareLimit;
        if (vaultSharesAfterMint > shareLimit) revert ShareLimitExceeded(_vault, shareLimit);

        IStakingVault vault_ = IStakingVault(_vault);
        if (!vault_.isReportFresh()) revert VaultReportStaled(_vault);

        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - socket.reserveRatioBP;
        uint256 maxMintableEther = (vault_.valuation() * maxMintableRatioBP) / TOTAL_BASIS_POINTS;
        uint256 stETHAfterMint = LIDO.getPooledEthBySharesRoundUp(vaultSharesAfterMint);
        if (stETHAfterMint > maxMintableEther) {
            revert InsufficientValuationToMint(_vault, vault_.valuation());
        }

        // Calculate the minimum ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 minLocked = (stETHAfterMint * TOTAL_BASIS_POINTS) / maxMintableRatioBP;

        if (minLocked > vault_.locked()) {
            revert VaultInsufficientLocked(_vault, vault_.locked(), minLocked);
        }

        socket.sharesMinted = uint96(vaultSharesAfterMint);
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

        uint256 sharesMinted = socket.sharesMinted;
        if (sharesMinted < _amountOfShares) revert InsufficientSharesToBurn(_vault, sharesMinted);

        socket.sharesMinted = uint96(sharesMinted - _amountOfShares);

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

    /// @notice force rebalance of the vault to have sufficient reserve ratio
    /// @param _vault vault address
    /// @dev permissionless if the vault's min reserve ratio is broken
    function forceRebalance(address _vault) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        _requireUnhealthy(_vault);

        uint256 amountToRebalance = rebalanceShortfall(_vault);

        // TODO: add some gas compensation here
        IStakingVault(_vault).rebalance(amountToRebalance);
    }

    /// @notice rebalances the vault by writing off the amount of ether equal
    ///     to `msg.value` from the vault's minted stETH
    /// @dev msg.sender should be vault's contract
    function rebalance() external payable whenResumed {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        VaultSocket storage socket = _connectedSocket(msg.sender);

        uint256 sharesToBurn = LIDO.getSharesByPooledEth(msg.value);
        uint256 sharesMinted = socket.sharesMinted;
        if (sharesMinted < sharesToBurn) revert InsufficientSharesToBurn(msg.sender, sharesMinted);

        socket.sharesMinted = uint96(sharesMinted - sharesToBurn);

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
        _requireUnhealthy(_vault);

        uint256 numValidators = _pubkeys.length / PUBLIC_KEY_LENGTH;
        uint64[] memory amounts = new uint64[](numValidators);

        IStakingVault(_vault).triggerValidatorWithdrawal{value: msg.value}(_pubkeys, amounts, _refundRecipient);

        emit ForceValidatorExitTriggered(_vault, _pubkeys, _refundRecipient);
    }

    function _disconnect(address _vault) internal {
        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 sharesMinted = socket.sharesMinted;
        if (sharesMinted > 0) {
            revert NoMintedSharesShouldBeLeft(_vault, sharesMinted);
        }

        socket.pendingDisconnect = true;

        emit VaultDisconnected(_vault);
    }

    /// @notice Permissionless update of the vault data
    /// @param _vault the address of the vault
    /// @param _valuation the valuation of the vault
    /// @param _inOutDelta the inOutDelta of the vault
    /// @param _feeSharesCharged the feeSharesCharged of the vault
    /// @param _sharesMinted the sharesMinted of the vault
    /// @param _proof the proof of the reported data
    function updateVaultData(
        address _vault,
        uint256 _valuation,
        int256 _inOutDelta,
        uint256 _feeSharesCharged,
        uint256 _sharesMinted,
        bytes32[] calldata _proof
    ) external {
        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 vaultIndex = $.vaultIndex[_vault];
        if (vaultIndex == 0) revert NotConnectedToHub(_vault);

        bytes32 root = $.vaultsDataTreeRoot;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(_vault, _valuation, _inOutDelta, _feeSharesCharged, _sharesMinted))));
        if (!MerkleProof.verify(_proof, root, leaf)) revert InvalidProof();

        VaultSocket storage socket = $.sockets[vaultIndex];
        // NB: charged fees can only cumulatively increase with time
        if (_feeSharesCharged  < socket.feeSharesCharged) {
            revert InvalidFees(_vault, _feeSharesCharged, socket.feeSharesCharged);
        }
        socket.sharesMinted += uint96(_feeSharesCharged - socket.feeSharesCharged);
        socket.feeSharesCharged = uint96(_feeSharesCharged);

        uint256 newMintedShares = Math256.max(socket.sharesMinted, _sharesMinted);
        // locked ether can only be increased asynchronously once the oracle settled the new floor value
        // as of reference slot to prevent slashing upsides in between the report gathering and delivering
        uint256 lockedEther = Math256.max(
            LIDO.getPooledEthBySharesRoundUp(newMintedShares) * TOTAL_BASIS_POINTS / (TOTAL_BASIS_POINTS - socket.reserveRatioBP),
            socket.pendingDisconnect ? 0 : CONNECT_DEPOSIT
        );

        IStakingVault(socket.vault).report($.vaultsDataTimestamp, _valuation, _inOutDelta, lockedEther);

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

    function _requireUnhealthy(address _vault) internal view {
        if (isVaultHealthyAsOfLatestReport(_vault)) revert AlreadyHealthy(_vault);
    }

    event VaultConnected(
        address indexed vault,
        uint256 capShares,
        uint256 minReserveRatio,
        uint256 rebalanceThreshold,
        uint256 treasuryFeeBP
    );

    event VaultsReportDataUpdated(uint64 indexed timestamp, bytes32 root, string cid);

    event ShareLimitUpdated(address indexed vault, uint256 newShareLimit);
    event VaultDisconnected(address indexed vault);
    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned);
    event VaultProxyCodehashAdded(bytes32 indexed codehash);
    event ForceValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecipient);
    event VaultConnectionUpdated(address indexed vault, uint256 shareLimit, uint256 reserveRatioBP, uint256 rebalanceThresholdBP, uint256 treasuryFeeBP);

    error AlreadyHealthy(address vault);
    error InsufficientSharesToBurn(address vault, uint256 amount);
    error ShareLimitExceeded(address vault, uint256 capShares);
    error AlreadyConnected(address vault, uint256 index);
    error NotConnectedToHub(address vault);
    error NotAuthorized(string operation, address addr);
    error ZeroArgument(string argument);
    error ShareLimitTooHigh(address vault, uint256 capShares, uint256 maxCapShares);
    error ReserveRatioTooHigh(address vault, uint256 reserveRatioBP, uint256 maxReserveRatioBP);
    error RebalanceThresholdTooHigh(address vault, uint256 rebalanceThresholdBP, uint256 maxRebalanceThresholdBP);
    error TreasuryFeeTooHigh(address vault, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
    error InsufficientValuationToMint(address vault, uint256 valuation);
    error AlreadyExists(bytes32 codehash);
    error NoMintedSharesShouldBeLeft(address vault, uint256 sharesMinted);
    error VaultProxyNotAllowed(address beacon);
    error InvalidPubkeysLength();
    error RelativeShareLimitBPTooHigh(uint256 relativeShareLimitBP, uint256 totalBasisPoints);
    error VaultDepositorNotAllowed(address depositor);
    error InvalidProof();
    error InvalidFees(address vault, uint256 newFees, uint256 oldFees);
    error VaultInsufficientLocked(address vault, uint256 currentLocked, uint256 expectedLocked);
    error VaultOssified(address vault);
    error VaultInsufficientBalance(address vault, uint256 currentBalance, uint256 expectedBalance);
    error VaultReportStaled(address vault);
}
