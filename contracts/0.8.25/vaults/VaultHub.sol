// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILido as IStETH} from "../interfaces/ILido.sol";

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
        /// @notice unused gap in the slot 2
        /// uint104 _unused_gap_;
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
    /// @notice amount of ETH that is locked on the vault on connect and can be withdrawn on disconnect only
    uint256 internal constant CONNECT_DEPOSIT = 1 ether;
    /// @notice length of the validator pubkey in bytes
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    /// @notice limit for the number of vaults that can ever be connected to the vault hub
    uint256 private immutable CONNECTED_VAULTS_LIMIT;
    /// @notice limit for a single vault share limit relative to Lido TVL in basis points
    uint256 private immutable RELATIVE_SHARE_LIMIT_BP;

    /// @notice Lido stETH contract
    IStETH public immutable STETH;
    address public immutable accounting;

    /// @param _stETH Lido stETH contract
    /// @param _connectedVaultsLimit Maximum number of vaults that can be connected simultaneously
    /// @param _relativeShareLimitBP Maximum share limit relative to TVL in basis points
    constructor(IStETH _stETH, address _accounting, uint256 _connectedVaultsLimit, uint256 _relativeShareLimitBP) {
        if (_connectedVaultsLimit == 0) revert ZeroArgument("_connectedVaultsLimit");
        if (_relativeShareLimitBP == 0) revert ZeroArgument("_relativeShareLimitBP");
        if (_relativeShareLimitBP > TOTAL_BASIS_POINTS) revert RelativeShareLimitBPTooHigh(_relativeShareLimitBP, TOTAL_BASIS_POINTS);

        STETH = _stETH;
        accounting = _accounting;
        CONNECTED_VAULTS_LIMIT = _connectedVaultsLimit;
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
        _getVaultHubStorage().sockets.push(VaultSocket(address(0), 0, 0, 0, 0, 0, false));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
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

    /// @notice checks if the vault is healthy by comparing its projected valuation after applying rebalance threshold
    ///         against the current value of minted shares
    /// @param _vault vault address
    /// @return true if vault is healthy, false otherwise
    function isVaultHealthy(address _vault) public view returns (bool) {
        VaultSocket storage socket = _connectedSocket(_vault);
        if (socket.sharesMinted == 0) return true;

        return (
            IStakingVault(_vault).valuation() * (TOTAL_BASIS_POINTS - socket.rebalanceThresholdBP) / TOTAL_BASIS_POINTS
        ) >= STETH.getPooledEthBySharesRoundUp(socket.sharesMinted);
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _reserveRatioBP minimum reserve ratio in basis points
    /// @param _rebalanceThresholdBP threshold to force rebalance on the vault in basis points
    /// @param _treasuryFeeBP treasury fee in basis points
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function connectVault(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _rebalanceThresholdBP,
        uint256 _treasuryFeeBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_reserveRatioBP == 0) revert ZeroArgument("_reserveRatioBP");
        if (_reserveRatioBP > TOTAL_BASIS_POINTS) revert ReserveRatioTooHigh(_vault, _reserveRatioBP, TOTAL_BASIS_POINTS);
        if (_rebalanceThresholdBP == 0) revert ZeroArgument("_rebalanceThresholdBP");
        if (_rebalanceThresholdBP > _reserveRatioBP) revert RebalanceThresholdTooHigh(_vault, _rebalanceThresholdBP, _reserveRatioBP);
        if (_treasuryFeeBP > TOTAL_BASIS_POINTS) revert TreasuryFeeTooHigh(_vault, _treasuryFeeBP, TOTAL_BASIS_POINTS);
        if (vaultsCount() == CONNECTED_VAULTS_LIMIT) revert TooManyVaults();
        _checkShareLimitUpperBound(_vault, _shareLimit);

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultIndex[_vault] != 0) revert AlreadyConnected(_vault, $.vaultIndex[_vault]);

        bytes32 vaultProxyCodehash = address(_vault).codehash;
        if (!$.vaultProxyCodehash[vaultProxyCodehash]) revert VaultProxyNotAllowed(_vault);

        VaultSocket memory vsocket = VaultSocket(
            _vault,
            0, // sharesMinted
            uint96(_shareLimit),
            uint16(_reserveRatioBP),
            uint16(_rebalanceThresholdBP),
            uint16(_treasuryFeeBP),
            false // isDisconnected
        );
        $.vaultIndex[_vault] = $.sockets.length;
        $.sockets.push(vsocket);

        IStakingVault(_vault).lock(CONNECT_DEPOSIT);

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
    function selfDisconnect(address _vault) external whenResumed {
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
        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - socket.reserveRatioBP;
        uint256 maxMintableEther = (vault_.valuation() * maxMintableRatioBP) / TOTAL_BASIS_POINTS;
        uint256 etherToLock = STETH.getPooledEthBySharesRoundUp(vaultSharesAfterMint);
        if (etherToLock > maxMintableEther) {
            revert InsufficientValuationToMint(_vault, vault_.valuation());
        }

        socket.sharesMinted = uint96(vaultSharesAfterMint);

        // Calculate the total ETH that needs to be locked in the vault to maintain the reserve ratio
        uint256 totalEtherLocked = (etherToLock * TOTAL_BASIS_POINTS) / maxMintableRatioBP;
        if (totalEtherLocked > vault_.locked()) {
            vault_.lock(totalEtherLocked);
        }

        STETH.mintExternalShares(_recipient, _amountOfShares);

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

        STETH.burnExternalShares(_amountOfShares);

        emit BurnedSharesOnVault(_vault, _amountOfShares);
    }

    /// @notice separate burn function for EOA vault owners; requires vaultHub to be approved to transfer stETH
    /// @dev msg.sender should be vault's owner
    function transferAndBurnShares(address _vault, uint256 _amountOfShares) external {
        STETH.transferSharesFrom(msg.sender, address(this), _amountOfShares);

        burnShares(_vault, _amountOfShares);
    }

    /// @notice force rebalance of the vault to have sufficient reserve ratio
    /// @param _vault vault address
    /// @dev permissionless if the vault's min reserve ratio is broken
    function forceRebalance(address _vault) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        _requireUnhealthy(_vault);

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 mintedStETH = STETH.getPooledEthByShares(socket.sharesMinted); // TODO: fix rounding issue
        uint256 reserveRatioBP = socket.reserveRatioBP;
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);

        // how much ETH should be moved out of the vault to rebalance it to minimal reserve ratio

        // (mintedStETH - X) / (vault.valuation() - X) = maxMintableRatio / BPS_BASE
        // (mintedStETH - X) * BPS_BASE = (vault.valuation() - X) * maxMintableRatio
        // mintedStETH * BPS_BASE - X * BPS_BASE = vault.valuation() * maxMintableRatio - X * maxMintableRatio
        // X * maxMintableRatio - X * BPS_BASE = vault.valuation() * maxMintableRatio - mintedStETH * BPS_BASE
        // X * (maxMintableRatio - BPS_BASE) = vault.valuation() * maxMintableRatio - mintedStETH * BPS_BASE
        // X = (vault.valuation() * maxMintableRatio - mintedStETH * BPS_BASE) / (maxMintableRatio - BPS_BASE)
        // X = (mintedStETH * BPS_BASE - vault.valuation() * maxMintableRatio) / (BPS_BASE - maxMintableRatio)
        // reserveRatio = BPS_BASE - maxMintableRatio
        // X = (mintedStETH * BPS_BASE - vault.valuation() * maxMintableRatio) / reserveRatio

        uint256 amountToRebalance = (mintedStETH * TOTAL_BASIS_POINTS -
            IStakingVault(_vault).valuation() * maxMintableRatio) / reserveRatioBP;

        // TODO: add some gas compensation here
        IStakingVault(_vault).rebalance(amountToRebalance);
    }

    /// @notice rebalances the vault by writing off the amount of ether equal
    ///     to `msg.value` from the vault's minted stETH
    /// @dev msg.sender should be vault's contract
    function rebalance() external payable whenResumed {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        VaultSocket storage socket = _connectedSocket(msg.sender);

        uint256 sharesToBurn = STETH.getSharesByPooledEth(msg.value);
        uint256 sharesMinted = socket.sharesMinted;
        if (sharesMinted < sharesToBurn) revert InsufficientSharesToBurn(msg.sender, sharesMinted);

        socket.sharesMinted = uint96(sharesMinted - sharesToBurn);

        STETH.rebalanceExternalEtherToInternal{value: msg.value}();

        emit VaultRebalanced(msg.sender, sharesToBurn);
    }

    /// @notice Forces validator exit from the beacon chain when vault is unhealthy
    /// @param _vault The address of the vault to exit validators from
    /// @param _pubkeys The public keys of the validators to exit
    /// @param _refundRecepient The address that will receive the refund for transaction costs
    /// @dev    When the vault becomes unhealthy, anyone can force its validators to exit the beacon chain
    ///         This returns the vault's deposited ETH back to vault's balance and allows to rebalance the vault
    function forceValidatorExit(
        address _vault,
        bytes calldata _pubkeys,
        address _refundRecepient
    ) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_refundRecepient == address(0)) revert ZeroArgument("_refundRecepient");
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) revert InvalidPubkeysLength();
        _requireUnhealthy(_vault);

        uint256 numValidators = _pubkeys.length / PUBLIC_KEY_LENGTH;
        uint64[] memory amounts = new uint64[](numValidators);

        IStakingVault(_vault).triggerValidatorWithdrawal{value: msg.value}(_pubkeys, amounts, _refundRecepient);

        emit ForceValidatorExitTriggered(_vault, _pubkeys, _refundRecepient);
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

    function calculateVaultsRebase(
        uint256 _postTotalShares,
        uint256 _postTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preTotalPooledEther,
        uint256 _sharesToMintAsFees
    ) public view returns (uint256[] memory lockedEther, uint256[] memory treasuryFeeShares, uint256 totalTreasuryFeeShares) {
        /// HERE WILL BE ACCOUNTING DRAGON

        //                 \||/
        //                 |  $___oo
        //       /\  /\   / (__,,,,|
        //     ) /^\) ^\/ _)
        //     )   /^\/   _)
        //     )   _ /  / _)
        // /\  )/\/ ||  | )_)
        //<  >      |(,,) )__)
        // ||      /    \)___)\
        // | \____(      )___) )___
        //  \______(_______;;; __;;;

        VaultHubStorage storage $ = _getVaultHubStorage();

        uint256 length = vaultsCount();

        treasuryFeeShares = new uint256[](length);
        lockedEther = new uint256[](length);

        for (uint256 i = 0; i < length; ++i) {
            VaultSocket memory socket = $.sockets[i + 1];
            if (!socket.pendingDisconnect) {
                treasuryFeeShares[i] = _calculateTreasuryFees(
                    socket,
                    _postTotalShares - _sharesToMintAsFees,
                    _postTotalPooledEther,
                    _preTotalShares,
                    _preTotalPooledEther
                );

                totalTreasuryFeeShares += treasuryFeeShares[i];

                uint256 totalMintedShares = socket.sharesMinted + treasuryFeeShares[i];
                uint256 mintedStETH = (totalMintedShares * _postTotalPooledEther) / _postTotalShares; //TODO: check rounding
                lockedEther[i] = Math256.max(
                    (mintedStETH * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - socket.reserveRatioBP),
                    CONNECT_DEPOSIT
                );
            }
        }
    }

    /// @dev impossible to invoke this method under negative rebase
    function _calculateTreasuryFees(
        VaultSocket memory _socket,
        uint256 _postTotalSharesNoFees,
        uint256 _postTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preTotalPooledEther
    ) internal view returns (uint256 treasuryFeeShares) {
        IStakingVault vault_ = IStakingVault(_socket.vault);

        uint256 chargeableValue = Math256.min(
            vault_.valuation(),
            (_socket.shareLimit * _preTotalPooledEther) / _preTotalShares
        );

        // treasury fee is calculated as a share of potential rewards that
        // Lido curated validators could earn if vault's ETH was staked in Lido
        // itself and minted as stETH shares
        //
        // treasuryFeeShares = value * lidoGrossAPR * treasuryFeeRate / preShareRate
        // lidoGrossAPR = postShareRateWithoutFees / preShareRate - 1
        // = value  * (postShareRateWithoutFees / preShareRate - 1) * treasuryFeeRate / preShareRate

        // TODO: optimize potential rewards calculation
        uint256 potentialRewards = ((chargeableValue * (_postTotalPooledEther * _preTotalShares)) /
            (_postTotalSharesNoFees * _preTotalPooledEther) - chargeableValue);
        uint256 treasuryFee = (potentialRewards * _socket.treasuryFeeBP) / TOTAL_BASIS_POINTS;

        treasuryFeeShares = (treasuryFee * _preTotalShares) / _preTotalPooledEther;
    }

    function updateVaults(
        uint256[] memory _valuations,
        int256[] memory _inOutDeltas,
        uint256[] memory _locked,
        uint256[] memory _treasureFeeShares
    ) external {
        if (msg.sender != accounting) revert NotAuthorized("updateVaults", msg.sender);
        VaultHubStorage storage $ = _getVaultHubStorage();

        for (uint256 i = 0; i < _valuations.length; i++) {
            VaultSocket storage socket = $.sockets[i + 1];

            uint256 treasuryFeeShares = _treasureFeeShares[i];
            if (treasuryFeeShares > 0) {
                socket.sharesMinted += uint96(treasuryFeeShares);
            }

            IStakingVault(socket.vault).report(_valuations[i], _inOutDeltas[i], _locked[i]);
        }

        uint256 length = $.sockets.length;

        for (uint256 i = 1; i < length; i++) {
            VaultSocket storage socket = $.sockets[i];
            if (socket.pendingDisconnect) {
                // remove disconnected vault from the list
                VaultSocket memory lastSocket = $.sockets[length - 1];
                $.sockets[i] = lastSocket;
                $.vaultIndex[lastSocket.vault] = i;
                $.sockets.pop(); // TODO: replace with length--
                delete $.vaultIndex[socket.vault];
                --length;
            }
        }
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
        uint256 relativeMaxShareLimitPerVault = (STETH.getTotalShares() * RELATIVE_SHARE_LIMIT_BP) / TOTAL_BASIS_POINTS;
        if (_shareLimit > relativeMaxShareLimitPerVault) {
            revert ShareLimitTooHigh(_vault, _shareLimit, relativeMaxShareLimitPerVault);
        }
    }

    function _requireUnhealthy(address _vault) internal view {
        if (isVaultHealthy(_vault)) revert AlreadyHealthy(_vault);
    }

    event VaultConnected(address indexed vault, uint256 capShares, uint256 minReserveRatio, uint256 rebalanceThreshold, uint256 treasuryFeeBP);
    event ShareLimitUpdated(address indexed vault, uint256 newShareLimit);
    event VaultDisconnected(address indexed vault);
    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned);
    event VaultProxyCodehashAdded(bytes32 indexed codehash);
    event ForceValidatorExitTriggered(address indexed vault, bytes pubkeys, address refundRecepient);

    error StETHMintFailed(address vault);
    error AlreadyHealthy(address vault);
    error InsufficientSharesToBurn(address vault, uint256 amount);
    error ShareLimitExceeded(address vault, uint256 capShares);
    error AlreadyConnected(address vault, uint256 index);
    error NotConnectedToHub(address vault);
    error RebalanceFailed(address vault);
    error NotAuthorized(string operation, address addr);
    error ZeroArgument(string argument);
    error NotEnoughBalance(address vault, uint256 balance, uint256 shouldBe);
    error TooManyVaults();
    error ShareLimitTooHigh(address vault, uint256 capShares, uint256 maxCapShares);
    error ReserveRatioTooHigh(address vault, uint256 reserveRatioBP, uint256 maxReserveRatioBP);
    error RebalanceThresholdTooHigh(address vault, uint256 rebalanceThresholdBP, uint256 maxRebalanceThresholdBP);
    error TreasuryFeeTooHigh(address vault, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
    error ExternalSharesCapReached(address vault, uint256 capShares, uint256 maxMintableExternalShares);
    error InsufficientValuationToMint(address vault, uint256 valuation);
    error AlreadyExists(bytes32 codehash);
    error NoMintedSharesShouldBeLeft(address vault, uint256 sharesMinted);
    error VaultProxyNotAllowed(address beacon);
    error InvalidPubkeysLength();
    error ConnectedVaultsLimitTooLow(uint256 connectedVaultsLimit, uint256 currentVaultsCount);
    error RelativeShareLimitBPTooHigh(uint256 relativeShareLimitBP, uint256 totalBasisPoints);
}
