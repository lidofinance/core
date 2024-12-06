// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {IHubVault} from "./interfaces/IHubVault.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {ILido as StETH} from "contracts/0.8.25/interfaces/ILido.sol";
import {IBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/IBeacon.sol";
import {IBeaconProxy} from "./interfaces/IBeaconProxy.sol";

// TODO: rebalance gas compensation
// TODO: unstructured storag and upgradability

/// @notice Vaults registry contract that is an interface to the Lido protocol
/// in the same time
/// @author folkyatina
abstract contract VaultHub is AccessControlEnumerableUpgradeable {
    /// @custom:storage-location erc7201:VaultHub
    struct VaultHubStorage {
        /// @notice vault sockets with vaults connected to the hub
        /// @dev first socket is always zero. stone in the elevator
        VaultSocket[] sockets;

        /// @notice mapping from vault address to its socket
        /// @dev if vault is not connected to the hub, its index is zero
        mapping(IHubVault => uint256) vaultIndex;

        /// @notice allowed factory addresses
        mapping (address => bool) vaultFactories;
        /// @notice allowed vault implementation addresses
        mapping (address => bool) vaultImpl;
    }

    struct VaultSocket {
        /// @notice vault address
        IHubVault vault;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        /// @notice total number of stETH shares minted by the vault
        uint96 sharesMinted;
        /// @notice minimal share of ether that is reserved for each stETH minted
        uint16 reserveRatio;
        /// @notice if vault's reserve decreases to this threshold ratio,
        /// it should be force rebalanced
        uint16 reserveRatioThreshold;
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
    }

    // keccak256(abi.encode(uint256(keccak256("VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_HUB_STORAGE_LOCATION =
        0xb158a1a9015c52036ff69e7937a7bb424e82a8c4cbec5c5309994af06d825300;

    /// @notice role that allows to connect vaults to the hub
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("Vaults.VaultHub.VaultMasterRole");
    /// @notice role that allows to add factories and vault implementations to hub
    bytes32 public constant VAULT_REGISTRY_ROLE = keccak256("Vaults.VaultHub.VaultRegistryRole");
    /// @dev basis points base
    uint256 internal constant BPS_BASE = 100_00;
    /// @dev maximum number of vaults that can be connected to the hub
    uint256 internal constant MAX_VAULTS_COUNT = 500;
    /// @dev maximum size of the single vault relative to Lido TVL in basis points
    uint256 internal constant MAX_VAULT_SIZE_BP = 10_00;

    StETH public immutable stETH;
    address public immutable treasury;

    constructor(StETH _stETH, address _treasury) {
        stETH = _stETH;
        treasury = _treasury;

        _disableInitializers();
    }

    function __VaultHub_init(address _admin) internal onlyInitializing {
        __AccessControlEnumerable_init();
        // stone in the elevator
        _getVaultHubStorage().sockets.push(VaultSocket(IHubVault(address(0)), 0, 0, 0, 0, 0));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice added factory address to allowed list
    function addFactory(address factory) public onlyRole(VAULT_REGISTRY_ROLE) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultFactories[factory]) revert AlreadyExists(factory);
        $.vaultFactories[factory] = true;
        emit VaultFactoryAdded(factory);
    }

    /// @notice added vault implementation address to allowed list
    function addImpl(address impl) public onlyRole(VAULT_REGISTRY_ROLE) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        if ($.vaultImpl[impl]) revert AlreadyExists(impl);
        $.vaultImpl[impl] = true;
        emit VaultImplAdded(impl);
    }

    /// @notice returns the number of vaults connected to the hub
    function vaultsCount() public view returns (uint256) {
        return _getVaultHubStorage().sockets.length - 1;
    }

    function vault(uint256 _index) public view returns (IHubVault) {
        return _getVaultHubStorage().sockets[_index + 1].vault;
    }

    function vaultSocket(uint256 _index) external view returns (VaultSocket memory) {
        return _getVaultHubStorage().sockets[_index + 1];
    }

    function vaultSocket(address _vault) external view returns (VaultSocket memory) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        return $.sockets[$.vaultIndex[IHubVault(_vault)]];
    }

    /// @notice Returns all vaults owned by a given address
    /// @param _owner Address of the owner
    /// @return An array of vaults owned by the given address
    function vaultsByOwner(address _owner) external view returns (IHubVault[] memory) {
        VaultHubStorage storage $ = _getVaultHubStorage();
        uint256 count = 0;

        // First, count how many vaults belong to the owner
        for (uint256 i = 1; i < $.sockets.length; i++) {
            if ($.sockets[i].vault.owner() == _owner) {
                count++;
            }
        }

        // Create an array to hold the owner's vaults
        IHubVault[] memory ownerVaults = new IHubVault[](count);
        uint256 index = 0;

        // Populate the array with the owner's vaults
        for (uint256 i = 1; i < $.sockets.length; i++) {
            if ($.sockets[i].vault.owner() == _owner) {
                ownerVaults[index] = $.sockets[i].vault;
                index++;
            }
        }

        return ownerVaults;
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _reserveRatio minimum Reserve ratio in basis points
    /// @param _reserveRatioThreshold reserve ratio that makes possible to force rebalance on the vault (in basis points)
    /// @param _treasuryFeeBP treasury fee in basis points
    function connectVault(
        IHubVault _vault,
        uint256 _shareLimit,
        uint256 _reserveRatio,
        uint256 _reserveRatioThreshold,
        uint256 _treasuryFeeBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        if (address(_vault) == address(0)) revert ZeroArgument("_vault");
        if (_shareLimit == 0) revert ZeroArgument("_shareLimit");

        if (_reserveRatio == 0) revert ZeroArgument("_reserveRatio");
        if (_reserveRatio > BPS_BASE) revert ReserveRatioTooHigh(address(_vault), _reserveRatio, BPS_BASE);

        if (_reserveRatioThreshold == 0) revert ZeroArgument("_reserveRatioThreshold");
        if (_reserveRatioThreshold > _reserveRatio)
            revert ReserveRatioTooHigh(address(_vault), _reserveRatioThreshold, _reserveRatio);

        if (_treasuryFeeBP == 0) revert ZeroArgument("_treasuryFeeBP");
        if (_treasuryFeeBP > BPS_BASE) revert TreasuryFeeTooHigh(address(_vault), _treasuryFeeBP, BPS_BASE);

        VaultHubStorage storage $ = _getVaultHubStorage();

        address factory = IBeaconProxy(address (_vault)).getBeacon();
        if (!$.vaultFactories[factory]) revert FactoryNotAllowed(factory);

        address impl = IBeacon(factory).implementation();
        if (!$.vaultImpl[impl]) revert ImplNotAllowed(impl);

        if ($.vaultIndex[_vault] != 0) revert AlreadyConnected(address(_vault), $.vaultIndex[_vault]);
        if (vaultsCount() == MAX_VAULTS_COUNT) revert TooManyVaults();
        if (_shareLimit > (stETH.getTotalShares() * MAX_VAULT_SIZE_BP) / BPS_BASE) {
            revert ShareLimitTooHigh(address(_vault), _shareLimit, stETH.getTotalShares() / 10);
        }

        uint256 capVaultBalance = stETH.getPooledEthByShares(_shareLimit);
        uint256 maxAvailableExternalBalance = stETH.getMaxAvailableExternalBalance();
        if (capVaultBalance > maxAvailableExternalBalance) {
            revert ExternalBalanceCapReached(address(_vault), capVaultBalance, maxAvailableExternalBalance);
        }

        VaultSocket memory vr = VaultSocket(
            IHubVault(_vault),
            uint96(_shareLimit),
            0, // sharesMinted
            uint16(_reserveRatio),
            uint16(_reserveRatioThreshold),
            uint16(_treasuryFeeBP)
        );
        $.vaultIndex[_vault] = $.sockets.length;
        $.sockets.push(vr);

        emit VaultConnected(address(_vault), _shareLimit, _reserveRatio, _treasuryFeeBP);
    }

    /// @notice disconnects a vault from the hub
    /// @dev can be called by vaults only
    function disconnectVault(address _vault) external {
        VaultHubStorage storage $ = _getVaultHubStorage();

        IHubVault vault_ = IHubVault(_vault);
        uint256 index = $.vaultIndex[vault_];
        if (index == 0) revert NotConnectedToHub(_vault);
        if (msg.sender != vault_.owner()) revert NotAuthorized("disconnect", msg.sender);

        VaultSocket memory socket = $.sockets[index];
        IHubVault vaultToDisconnect = socket.vault;

        if (socket.sharesMinted > 0) {
            uint256 stethToBurn = stETH.getPooledEthByShares(socket.sharesMinted);
            vaultToDisconnect.rebalance(stethToBurn);
        }

        vaultToDisconnect.report(vaultToDisconnect.valuation(), vaultToDisconnect.inOutDelta(), 0);

        VaultSocket memory lastSocket = $.sockets[$.sockets.length - 1];
        $.sockets[index] = lastSocket;
        $.vaultIndex[lastSocket.vault] = index;
        $.sockets.pop();

        delete $.vaultIndex[vaultToDisconnect];

        emit VaultDisconnected(address(vaultToDisconnect));
    }

    /// @notice mint StETH tokens backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _tokens amount of stETH tokens to mint
    /// @dev can be used by vault owner only
    function mintStethBackedByVault(address _vault, address _recipient, uint256 _tokens) external {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_tokens == 0) revert ZeroArgument("_tokens");

        VaultHubStorage storage $ = _getVaultHubStorage();

        IHubVault vault_ = IHubVault(_vault);
        uint256 index = $.vaultIndex[vault_];
        if (index == 0) revert NotConnectedToHub(_vault);
        if (msg.sender != vault_.owner()) revert NotAuthorized("mint", msg.sender);

        VaultSocket memory socket = $.sockets[index];

        uint256 sharesToMint = stETH.getSharesByPooledEth(_tokens);
        uint256 vaultSharesAfterMint = socket.sharesMinted + sharesToMint;
        if (vaultSharesAfterMint > socket.shareLimit) revert ShareLimitExceeded(_vault, socket.shareLimit);

        uint256 maxMintableShares = _maxMintableShares(socket.vault, socket.reserveRatio);

        if (vaultSharesAfterMint > maxMintableShares) {
            revert InsufficientValuationToMint(address(vault_), vault_.valuation());
        }

        $.sockets[index].sharesMinted = uint96(vaultSharesAfterMint);

        stETH.mintExternalShares(_recipient, sharesToMint);

        emit MintedStETHOnVault(_vault, _tokens);

        uint256 totalEtherLocked = (stETH.getPooledEthByShares(vaultSharesAfterMint) * BPS_BASE) /
            (BPS_BASE - socket.reserveRatio);

        vault_.lock(totalEtherLocked);
    }

    /// @notice burn steth from the balance of the vault contract
    /// @param _vault vault address
    /// @param _tokens amount of tokens to burn
    /// @dev can be used by vault owner only; vaultHub must be approved to transfer stETH
    function burnStethBackedByVault(address _vault, uint256 _tokens) public {
        if (_tokens == 0) revert ZeroArgument("_tokens");

        VaultHubStorage storage $ = _getVaultHubStorage();

        IHubVault vault_ = IHubVault(_vault);
        uint256 index = $.vaultIndex[vault_];
        if (index == 0) revert NotConnectedToHub(_vault);
        if (msg.sender != vault_.owner()) revert NotAuthorized("burn", msg.sender);

        VaultSocket memory socket = $.sockets[index];

        uint256 amountOfShares = stETH.getSharesByPooledEth(_tokens);
        if (socket.sharesMinted < amountOfShares) revert InsufficientSharesToBurn(_vault, socket.sharesMinted);

        $.sockets[index].sharesMinted = socket.sharesMinted - uint96(amountOfShares);

        stETH.burnExternalShares(amountOfShares);

        emit BurnedStETHOnVault(_vault, _tokens);
    }

    /// @notice separate burn function for EOA vault owners; requires vaultHub to be approved to transfer stETH
    function transferAndBurnStethBackedByVault(address _vault, uint256 _tokens) external {
        stETH.transferFrom(msg.sender, address(this), _tokens);

        burnStethBackedByVault(_vault, _tokens);
    }

    /// @notice force rebalance of the vault to have sufficient reserve ratio
    /// @param _vault vault address
    /// @dev can be used permissionlessly if the vault's min reserve ratio is broken
    function forceRebalance(IHubVault _vault) external {
        VaultHubStorage storage $ = _getVaultHubStorage();

        uint256 index = $.vaultIndex[_vault];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = $.sockets[index];

        uint256 threshold = _maxMintableShares(_vault, socket.reserveRatioThreshold);
        if (socket.sharesMinted <= threshold) {
            revert AlreadyBalanced(address(_vault), socket.sharesMinted, threshold);
        }

        uint256 mintedStETH = stETH.getPooledEthByShares(socket.sharesMinted);
        uint256 maxMintableRatio = (BPS_BASE - socket.reserveRatio);

        // how much ETH should be moved out of the vault to rebalance it to minimal reserve ratio

        // (mintedStETH - X) / (vault.valuation() - X) = maxMintableRatio / BPS_BASE
        // mintedStETH * BPS_BASE - X * BPS_BASE = vault.valuation() * maxMintableRatio - X * maxMintableRatio
        // X * maxMintableRatio - X * BPS_BASE = vault.valuation() * maxMintableRatio - mintedStETH * BPS_BASE
        // X = (vault.valuation() * maxMintableRatio - mintedStETH * BPS_BASE) / (maxMintableRatio - BPS_BASE)
        // X = mintedStETH * BPS_BASE - vault.valuation() * maxMintableRatio / (BPS_BASE - maxMintableRatio);
        // X = mintedStETH * BPS_BASE - vault.valuation() * maxMintableRatio / reserveRatio

        uint256 amountToRebalance = (mintedStETH * BPS_BASE - _vault.valuation() * maxMintableRatio) /
            socket.reserveRatio;

        // TODO: add some gas compensation here

        _vault.rebalance(amountToRebalance);
    }

    /// @notice rebalances the vault, by writing off the amount equal to passed ether
    ///     from the vault's minted stETH counter
    /// @dev can be called by vaults only
    function rebalance() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        VaultHubStorage storage $ = _getVaultHubStorage();

        uint256 index = $.vaultIndex[IHubVault(msg.sender)];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = $.sockets[index];

        uint256 sharesToBurn = stETH.getSharesByPooledEth(msg.value);
        if (socket.sharesMinted < sharesToBurn) revert InsufficientSharesToBurn(msg.sender, socket.sharesMinted);

        $.sockets[index].sharesMinted = socket.sharesMinted - uint96(sharesToBurn);

        // mint stETH (shares+ TPE+)
        (bool success, ) = address(stETH).call{value: msg.value}("");
        if (!success) revert StETHMintFailed(msg.sender);
        stETH.burnExternalShares(sharesToBurn);

        emit VaultRebalanced(msg.sender, sharesToBurn);
    }

    function _calculateVaultsRebase(
        uint256 _postTotalShares,
        uint256 _postTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preTotalPooledEther,
        uint256 _sharesToMintAsFees
    ) internal view returns (uint256[] memory lockedEther, uint256[] memory treasuryFeeShares) {
        /// HERE WILL BE ACCOUNTING DRAGONS

        //                 \||/
        //                 |  @___oo
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
        // for each vault
        treasuryFeeShares = new uint256[](length);

        lockedEther = new uint256[](length);

        for (uint256 i = 0; i < length; ++i) {
            VaultSocket memory socket = $.sockets[i + 1];

            // if there is no fee in Lido, then no fee in vaults
            // see LIP-12 for details
            if (_sharesToMintAsFees > 0) {
                treasuryFeeShares[i] = _calculateLidoFees(
                    socket,
                    _postTotalShares - _sharesToMintAsFees,
                    _postTotalPooledEther,
                    _preTotalShares,
                    _preTotalPooledEther
                );
            }

            uint256 totalMintedShares = socket.sharesMinted + treasuryFeeShares[i];
            uint256 mintedStETH = (totalMintedShares * _postTotalPooledEther) / _postTotalShares; //TODO: check rounding
            lockedEther[i] = (mintedStETH * BPS_BASE) / (BPS_BASE - socket.reserveRatio);
        }
    }

    function _calculateLidoFees(
        VaultSocket memory _socket,
        uint256 _postTotalSharesNoFees,
        uint256 _postTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preTotalPooledEther
    ) internal view returns (uint256 treasuryFeeShares) {
        IHubVault vault_ = _socket.vault;

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
            (_postTotalSharesNoFees * _preTotalPooledEther) -
            chargeableValue);
        uint256 treasuryFee = (potentialRewards * _socket.treasuryFeeBP) / BPS_BASE;

        treasuryFeeShares = (treasuryFee * _preTotalShares) / _preTotalPooledEther;
    }

    function _updateVaults(
        uint256[] memory _valuations,
        int256[] memory _inOutDeltas,
        uint256[] memory _locked,
        uint256[] memory _treasureFeeShares
    ) internal {
        VaultHubStorage storage $ = _getVaultHubStorage();

        uint256 totalTreasuryShares;
        for (uint256 i = 0; i < _valuations.length; ++i) {
            VaultSocket memory socket = $.sockets[i + 1];
            if (_treasureFeeShares[i] > 0) {
                socket.sharesMinted += uint96(_treasureFeeShares[i]);
                totalTreasuryShares += _treasureFeeShares[i];
            }

            socket.vault.report(_valuations[i], _inOutDeltas[i], _locked[i]);
        }

        if (totalTreasuryShares > 0) {
            stETH.mintExternalShares(treasury, totalTreasuryShares);
        }
    }

    /// @dev returns total number of stETH shares that is possible to mint on the provided vault with provided reserveRatio
    /// it does not count shares that is already minted
    function _maxMintableShares(IHubVault _vault, uint256 _reserveRatio) internal view returns (uint256) {
        uint256 maxStETHMinted = (_vault.valuation() * (BPS_BASE - _reserveRatio)) / BPS_BASE;
        return stETH.getSharesByPooledEth(maxStETHMinted);
    }

    function _getVaultHubStorage() private pure returns (VaultHubStorage storage $) {
        assembly {
            $.slot := VAULT_HUB_STORAGE_LOCATION
        }
    }

    event VaultConnected(address vault, uint256 capShares, uint256 minReserveRatio, uint256 treasuryFeeBP);
    event VaultDisconnected(address vault);
    event MintedStETHOnVault(address sender, uint256 tokens);
    event BurnedStETHOnVault(address sender, uint256 tokens);
    event VaultRebalanced(address sender, uint256 sharesBurned);
    event VaultImplAdded(address impl);
    event VaultFactoryAdded(address factory);

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
    error ExternalBalanceCapReached(address vault, uint256 capVaultBalance, uint256 maxAvailableExternalBalance);
    error InsufficientValuationToMint(address vault, uint256 valuation);
    error AlreadyExists(address addr);
    error FactoryNotAllowed(address beacon);
    error ImplNotAllowed(address impl);
}
