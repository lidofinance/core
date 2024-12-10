// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/IBeacon.sol";
import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILido as StETH} from "../interfaces/ILido.sol";
import {IBeaconProxy} from "./interfaces/IBeaconProxy.sol";

import {Math256} from "contracts/common/lib/Math256.sol";

/// @notice VaultHub is a contract that manages vaults connected to the Lido protocol
/// It allows to connect vaults, disconnect them, mint and burn stETH
/// It also allows to force rebalance of the vaults
/// Also, it passes the report from the accounting oracle to the vaults and charges fees
/// @author folkyatina
abstract contract VaultHub is AccessControlEnumerableUpgradeable {
    /// @custom:storage-location erc7201:VaultHub
    struct VaultHubStorage {
        /// @notice vault sockets with vaults connected to the hub
        /// @dev first socket is always zero. stone in the elevator
        VaultSocket[] sockets;

        /// @notice mapping from vault address to its socket
        /// @dev if vault is not connected to the hub, its index is zero
        mapping(address => uint256) vaultIndex;

        /// @notice allowed factory addresses
        mapping (address => bool) vaultFactories;
        /// @notice allowed vault implementation addresses
        mapping (address => bool) vaultImpl;
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
        /// @notice if vault's reserve decreases to this threshold ratio,
        /// it should be force rebalanced
        uint16 reserveRatioThresholdBP;
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
        /// @notice if true, vault is disconnected and fee is not accrued
        bool isDisconnected;
        // ### we have 104 bytes left in this slot
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
    /// @dev maximum number of vaults that can be connected to the hub
    uint256 internal constant MAX_VAULTS_COUNT = 500;
    /// @dev maximum size of the single vault relative to Lido TVL in basis points
    uint256 internal constant MAX_VAULT_SIZE_BP = 10_00;
    /// @notice amount of ETH that is locked on the vault on connect and can be withdrawn on disconnect only
    uint256 internal constant CONNECT_DEPOSIT = 1 ether;

    /// @notice Lido stETH contract
    StETH public immutable STETH;

    /// @param _stETH Lido stETH contract
    constructor(StETH _stETH) {
        STETH = _stETH;

        _disableInitializers();
    }

    /// @param _admin admin address to manage the roles
    function __VaultHub_init(address _admin) internal onlyInitializing {
        __AccessControlEnumerable_init();
        // the stone in the elevator
        _getVaultHubStorage().sockets.push(VaultSocket(address(0), 0, 0, 0, 0, 0, false));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice added factory address to allowed list
    /// @param factory factory address
    function addFactory(address factory) public onlyRole(VAULT_REGISTRY_ROLE) {
        if (factory == address(0)) revert ZeroArgument("factory");

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultFactories[factory]) revert AlreadyExists(factory);
        $.vaultFactories[factory] = true;
        emit VaultFactoryAdded(factory);
    }

    /// @notice added vault implementation address to allowed list
    /// @param impl vault implementation address
    function addVaultImpl(address impl) public onlyRole(VAULT_REGISTRY_ROLE) {
        if (impl == address(0)) revert ZeroArgument("impl");

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultImpl[impl]) revert AlreadyExists(impl);
        $.vaultImpl[impl] = true;
        emit VaultImplAdded(impl);
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

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _reserveRatioBP minimum Reserve ratio in basis points
    /// @param _reserveRatioThresholdBP reserve ratio that makes possible to force rebalance on the vault (in basis points)
    /// @param _treasuryFeeBP treasury fee in basis points
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function connectVault(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _reserveRatioThresholdBP,
        uint256 _treasuryFeeBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_reserveRatioBP == 0) revert ZeroArgument("_reserveRatioBP");
        if (_reserveRatioBP > TOTAL_BASIS_POINTS) revert ReserveRatioTooHigh(_vault, _reserveRatioBP, TOTAL_BASIS_POINTS);
        if (_reserveRatioThresholdBP == 0) revert ZeroArgument("_reserveRatioThresholdBP");
        if (_reserveRatioThresholdBP > _reserveRatioBP) revert ReserveRatioTooHigh(_vault, _reserveRatioThresholdBP, _reserveRatioBP);
        if (_treasuryFeeBP > TOTAL_BASIS_POINTS) revert TreasuryFeeTooHigh(_vault, _treasuryFeeBP, TOTAL_BASIS_POINTS);
        if (vaultsCount() == MAX_VAULTS_COUNT) revert TooManyVaults();
        _checkShareLimitUpperBound(_vault, _shareLimit);

        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultIndex[_vault] != 0) revert AlreadyConnected(_vault, $.vaultIndex[_vault]);

        address factory = IBeaconProxy(_vault).getBeacon();
        if (!$.vaultFactories[factory]) revert FactoryNotAllowed(factory);

        address vaultProxyImplementation = IBeacon(factory).implementation();
        if (!$.vaultImpl[vaultProxyImplementation]) revert ImplNotAllowed(vaultProxyImplementation);

        VaultSocket memory vr = VaultSocket(
            _vault,
            0, // sharesMinted
            uint96(_shareLimit),
            uint16(_reserveRatioBP),
            uint16(_reserveRatioThresholdBP),
            uint16(_treasuryFeeBP),
            false // isDisconnected
        );
        $.vaultIndex[_vault] = $.sockets.length;
        $.sockets.push(vr);

        IStakingVault(_vault).lock(CONNECT_DEPOSIT);

        emit VaultConnected(_vault, _shareLimit, _reserveRatioBP, _treasuryFeeBP);
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
    function voluntaryDisconnect(address _vault) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        _vaultAuth(_vault, "disconnect");

        _disconnect(_vault);
    }

    /// @notice mint StETH shares backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _amountOfShares amount of stETH shares to mint
    /// @dev msg.sender should be vault's owner
    function mintSharesBackedByVault(address _vault, address _recipient, uint256 _amountOfShares) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");

        _vaultAuth(_vault, "mint");

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 vaultSharesAfterMint = socket.sharesMinted + _amountOfShares;
        uint256 shareLimit = socket.shareLimit;
        if (vaultSharesAfterMint > shareLimit) revert ShareLimitExceeded(_vault, shareLimit);

        uint256 reserveRatioBP = socket.reserveRatioBP;
        uint256 maxMintableShares = _maxMintableShares(_vault, reserveRatioBP);

        if (vaultSharesAfterMint > maxMintableShares) {
            revert InsufficientValuationToMint(_vault, IStakingVault(_vault).valuation());
        }

        socket.sharesMinted = uint96(vaultSharesAfterMint);

        uint256 totalEtherLocked = (STETH.getPooledEthByShares(vaultSharesAfterMint) * TOTAL_BASIS_POINTS) /
            (TOTAL_BASIS_POINTS - reserveRatioBP);

        if (totalEtherLocked > IStakingVault(_vault).locked()) {
            IStakingVault(_vault).lock(totalEtherLocked);
        }

        STETH.mintExternalShares(_recipient, _amountOfShares);

        emit MintedSharesOnVault(_vault, _amountOfShares);
    }

    /// @notice burn steth shares from the balance of the VaultHub contract
    /// @param _vault vault address
    /// @param _amountOfShares amount of shares to burn
    /// @dev msg.sender should be vault's owner
    /// @dev VaultHub must have all the stETH on its balance
    function burnSharesBackedByVault(address _vault, uint256 _amountOfShares) public {
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
    function transferAndBurnStethBackedByVault(address _vault, uint256 _tokens) external {
        STETH.transferFrom(msg.sender, address(this), _tokens);

        burnSharesBackedByVault(_vault, _tokens);
    }

    /// @notice force rebalance of the vault to have sufficient reserve ratio
    /// @param _vault vault address
    /// @dev permissionless if the vault's min reserve ratio is broken
    function forceRebalance(address _vault) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 threshold = _maxMintableShares(_vault, socket.reserveRatioThresholdBP);
        uint256 sharesMinted = socket.sharesMinted;
        if (sharesMinted <= threshold) {
            // NOTE!: on connect vault is always balanced
            revert AlreadyBalanced(_vault, sharesMinted, threshold);
        }

        uint256 mintedStETH = STETH.getPooledEthByShares(sharesMinted);
        uint256 reserveRatioBP = socket.reserveRatioBP;
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);

        // how much ETH should be moved out of the vault to rebalance it to minimal reserve ratio

        // (mintedStETH - X) / (vault.valuation() - X) = maxMintableRatio / BPS_BASE
        // mintedStETH * BPS_BASE - X * BPS_BASE = vault.valuation() * maxMintableRatio - X * maxMintableRatio
        // X * maxMintableRatio - X * BPS_BASE = vault.valuation() * maxMintableRatio - mintedStETH * BPS_BASE
        // X = (vault.valuation() * maxMintableRatio - mintedStETH * BPS_BASE) / (maxMintableRatio - BPS_BASE)
        // X = mintedStETH * BPS_BASE - vault.valuation() * maxMintableRatio / (BPS_BASE - maxMintableRatio);
        // X = mintedStETH * BPS_BASE - vault.valuation() * maxMintableRatio / reserveRatio

        uint256 amountToRebalance = (mintedStETH * TOTAL_BASIS_POINTS -
            IStakingVault(_vault).valuation() * maxMintableRatio) / reserveRatioBP;

        // TODO: add some gas compensation here
        IStakingVault(_vault).rebalance(amountToRebalance);
    }

    /// @notice rebalances the vault by writing off the the amount of ether equal
    ///     to msg.value from the vault's minted stETH
    /// @dev msg.sender should be vault's contract
    function rebalance() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        VaultSocket storage socket = _connectedSocket(msg.sender);

        uint256 sharesToBurn = STETH.getSharesByPooledEth(msg.value);
        uint256 sharesMinted = socket.sharesMinted;
        if (sharesMinted < sharesToBurn) revert InsufficientSharesToBurn(msg.sender, sharesMinted);

        socket.sharesMinted = uint96(sharesMinted - sharesToBurn);

        // mint stETH (shares+ TPE+)
        (bool success, ) = address(STETH).call{value: msg.value}("");
        if (!success) revert StETHMintFailed(msg.sender);
        STETH.burnExternalShares(sharesToBurn);

        emit VaultRebalanced(msg.sender, sharesToBurn);
    }

    function _disconnect(address _vault) internal {
        VaultSocket storage socket = _connectedSocket(_vault);
        IStakingVault vault_ = IStakingVault(socket.vault);

        uint256 sharesMinted = socket.sharesMinted;
        if (sharesMinted > 0) {
            revert NoMintedSharesShouldBeLeft(_vault, sharesMinted);
        }

        socket.isDisconnected = true;

        vault_.report(vault_.valuation(), vault_.inOutDelta(), 0);

        emit VaultDisconnected(_vault);
    }

    function _calculateVaultsRebase(
        uint256 _postTotalShares,
        uint256 _postTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preTotalPooledEther,
        uint256 _sharesToMintAsFees
    ) internal view returns (uint256[] memory lockedEther, uint256[] memory treasuryFeeShares, uint256 totalTreasuryFeeShares) {
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
            if (!socket.isDisconnected) {
                treasuryFeeShares[i] = _calculateLidoFees(
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

    function _calculateLidoFees(
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
            (_postTotalSharesNoFees * _preTotalPooledEther) -chargeableValue);
        uint256 treasuryFee = (potentialRewards * _socket.treasuryFeeBP) / TOTAL_BASIS_POINTS;

        treasuryFeeShares = (treasuryFee * _preTotalShares) / _preTotalPooledEther;
    }

    function _updateVaults(
        uint256[] memory _valuations,
        int256[] memory _inOutDeltas,
        uint256[] memory _locked,
        uint256[] memory _treasureFeeShares
    ) internal returns (uint256 totalTreasuryShares) {
        VaultHubStorage storage $ = _getVaultHubStorage();

        for (uint256 i = 0; i < _valuations.length; i++) {
            VaultSocket storage socket = $.sockets[i + 1];

            if (socket.isDisconnected) continue; // we skip disconnected vaults

            uint256 treasuryFeeShares = _treasureFeeShares[i];
            if (treasuryFeeShares > 0) {
                socket.sharesMinted += uint96(treasuryFeeShares);
                totalTreasuryShares += treasuryFeeShares;
            }
            IStakingVault(socket.vault).report(_valuations[i], _inOutDeltas[i], _locked[i]);
        }

        uint256 length = $.sockets.length;

        for (uint256 i = 1; i < length; i++) {
            VaultSocket storage socket = $.sockets[i];
            if (socket.isDisconnected) {
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
        if (msg.sender != IStakingVault(_vault).owner()) revert NotAuthorized(_operation, msg.sender);
    }

    function _connectedSocket(address _vault) internal view returns (VaultSocket storage) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 index = $.vaultIndex[_vault];
        if (index == 0 || $.sockets[index].isDisconnected) revert NotConnectedToHub(_vault);
        return $.sockets[index];
    }

    /// @dev returns total number of stETH shares that is possible to mint on the provided vault with provided reserveRatio
    /// it does not count shares that is already minted
    function _maxMintableShares(address _vault, uint256 _reserveRatio) internal view returns (uint256) {
        uint256 maxStETHMinted = (IStakingVault(_vault).valuation() * (TOTAL_BASIS_POINTS - _reserveRatio)) /
            TOTAL_BASIS_POINTS;
        return STETH.getSharesByPooledEth(maxStETHMinted);
    }

    function _getVaultHubStorage() private pure returns (VaultHubStorage storage $) {
        assembly {
            $.slot := VAULT_HUB_STORAGE_LOCATION
        }
    }

    /// @dev check if the share limit is within the upper bound set by MAX_VAULT_SIZE_BP
    function _checkShareLimitUpperBound(address _vault, uint256 _shareLimit) internal view {
        // no vault should be more than 10% (MAX_VAULT_SIZE_BP) of the current Lido TVL
        uint256 relativeMaxShareLimitPerVault = (STETH.getTotalShares() * MAX_VAULT_SIZE_BP) / TOTAL_BASIS_POINTS;
        if (_shareLimit > relativeMaxShareLimitPerVault) {
            revert ShareLimitTooHigh(_vault, _shareLimit, relativeMaxShareLimitPerVault);
        }
    }

    event VaultConnected(address indexed vault, uint256 capShares, uint256 minReserveRatio, uint256 treasuryFeeBP);
    event ShareLimitUpdated(address indexed vault, uint256 newShareLimit);
    event VaultDisconnected(address indexed vault);
    event MintedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event BurnedSharesOnVault(address indexed vault, uint256 amountOfShares);
    event VaultRebalanced(address indexed vault, uint256 sharesBurned);
    event VaultImplAdded(address indexed impl);
    event VaultFactoryAdded(address indexed factory);
    error StETHMintFailed(address vault);
    error AlreadyBalanced(address vault, uint256 mintedShares, uint256 rebalancingThresholdInShares);
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
    error TreasuryFeeTooHigh(address vault, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
    error ExternalSharesCapReached(address vault, uint256 capShares, uint256 maxMintableExternalShares);
    error InsufficientValuationToMint(address vault, uint256 valuation);
    error AlreadyExists(address addr);
    error FactoryNotAllowed(address beacon);
    error ImplNotAllowed(address impl);
    error NoMintedSharesShouldBeLeft(address vault, uint256 sharesMinted);
}
