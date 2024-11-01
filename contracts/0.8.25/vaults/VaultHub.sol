// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {IHubVault} from "./interfaces/IHubVault.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

interface StETH {
    function mintExternalShares(address, uint256) external;

    function burnExternalShares(uint256) external;

    function getExternalEther() external view returns (uint256);

    function getMaxExternalBalance() external view returns (uint256);

    function getPooledEthByShares(uint256) external view returns (uint256);

    function getSharesByPooledEth(uint256) external view returns (uint256);

    function getTotalShares() external view returns (uint256);

    function transferFrom(address, address, uint256) external;
}

// TODO: rebalance gas compensation
// TODO: unstructured storag and upgradability

/// @notice Vaults registry contract that is an interface to the Lido protocol
/// in the same time
/// @author folkyatina
abstract contract VaultHub is AccessControlEnumerableUpgradeable {
    /// @notice role that allows to connect vaults to the hub
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("Vaults.VaultHub.VaultMasterRole");
    /// @dev basis points base
    uint256 internal constant BPS_BASE = 100_00;
    /// @dev maximum number of vaults that can be connected to the hub
    uint256 internal constant MAX_VAULTS_COUNT = 500;
    /// @dev maximum size of the vault relative to Lido TVL in basis points
    uint256 internal constant MAX_VAULT_SIZE_BP = 10_00;

    StETH public immutable stETH;
    address public immutable treasury;

    struct VaultSocket {
        /// @notice vault address
        IHubVault vault;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        /// @notice total number of stETH shares minted by the vault
        uint96 sharesMinted;
        /// @notice minimal share of ether that is reserved for each stETH minted
        uint16 minReserveRatioBP;
        /// @notice reserve ratio that makes possible to force rebalance on the vault
        uint16 thresholdReserveRatioBP;
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
    }

    /// @notice vault sockets with vaults connected to the hub
    /// @dev first socket is always zero. stone in the elevator
    VaultSocket[] private sockets;
    /// @notice mapping from vault address to its socket
    /// @dev if vault is not connected to the hub, it's index is zero
    mapping(IHubVault => uint256) private vaultIndex;

    constructor(address _admin, address _stETH, address _treasury) {
        stETH = StETH(_stETH);
        treasury = _treasury;

        sockets.push(VaultSocket(IHubVault(address(0)), 0, 0, 0, 0, 0)); // stone in the elevator

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice returns the number of vaults connected to the hub
    function vaultsCount() public view returns (uint256) {
        return sockets.length - 1;
    }

    function vault(uint256 _index) public view returns (IHubVault) {
        return sockets[_index + 1].vault;
    }

    function vaultSocket(uint256 _index) external view returns (VaultSocket memory) {
        return sockets[_index + 1];
    }

    function vaultSocket(address _vault) external view returns (VaultSocket memory) {
        return sockets[vaultIndex[IHubVault(_vault)]];
    }

    function reserveRatio(address _vault) external view returns (int256) {
        return _reserveRatio(sockets[vaultIndex[IHubVault(_vault)]]);
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _minReserveRatioBP minimum Reserve ratio in basis points
    /// @param _thresholdReserveRatioBP reserve ratio that makes possible to force rebalance on the vault (in basis points)
    /// @param _treasuryFeeBP treasury fee in basis points
    function connectVault(
        IHubVault _vault,
        uint256 _shareLimit,
        uint256 _minReserveRatioBP,
        uint256 _thresholdReserveRatioBP,
        uint256 _treasuryFeeBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        if (address(_vault) == address(0)) revert ZeroArgument("_vault");
        if (_shareLimit == 0) revert ZeroArgument("_shareLimit");

        if (_minReserveRatioBP == 0) revert ZeroArgument("_minReserveRatioBP");
        if (_minReserveRatioBP > BPS_BASE) revert ReserveRatioTooHigh(address(_vault), _minReserveRatioBP, BPS_BASE);

        if (_thresholdReserveRatioBP == 0) revert ZeroArgument("thresholdReserveRatioBP");
        if (_thresholdReserveRatioBP > _minReserveRatioBP)
            revert ReserveRatioTooHigh(address(_vault), _thresholdReserveRatioBP, _minReserveRatioBP);

        if (_treasuryFeeBP == 0) revert ZeroArgument("_treasuryFeeBP");
        if (_treasuryFeeBP > BPS_BASE) revert TreasuryFeeTooHigh(address(_vault), _treasuryFeeBP, BPS_BASE);

        if (vaultIndex[_vault] != 0) revert AlreadyConnected(address(_vault), vaultIndex[_vault]);
        if (vaultsCount() == MAX_VAULTS_COUNT) revert TooManyVaults();
        if (_shareLimit > (stETH.getTotalShares() * MAX_VAULT_SIZE_BP) / BPS_BASE) {
            revert CapTooHigh(address(_vault), _shareLimit, stETH.getTotalShares() / 10);
        }

        uint256 capVaultBalance = stETH.getPooledEthByShares(_shareLimit);
        uint256 maxExternalBalance = stETH.getMaxExternalBalance();
        if (capVaultBalance + stETH.getExternalEther() > maxExternalBalance) {
            revert ExternalBalanceCapReached(address(_vault), capVaultBalance, maxExternalBalance);
        }

        VaultSocket memory vr = VaultSocket(
            IHubVault(_vault),
            uint96(_shareLimit),
            0, // sharesMinted
            uint16(_minReserveRatioBP),
            uint16(_thresholdReserveRatioBP),
            uint16(_treasuryFeeBP)
        );
        vaultIndex[_vault] = sockets.length;
        sockets.push(vr);

        emit VaultConnected(address(_vault), _shareLimit, _minReserveRatioBP, _treasuryFeeBP);
    }

    /// @notice disconnects a vault from the hub
    /// @dev can be called by vaults only
    function disconnectVault(address _vault) external {
        IHubVault vault_ = IHubVault(_vault);

        uint256 index = vaultIndex[vault_];
        if (index == 0) revert NotConnectedToHub(_vault);
        if (msg.sender != vault_.owner()) revert NotAuthorized("disconnect", msg.sender);

        VaultSocket memory socket = sockets[index];
        IHubVault vaultToDisconnect = socket.vault;

        if (socket.sharesMinted > 0) {
            uint256 stethToBurn = stETH.getPooledEthByShares(socket.sharesMinted);
            vaultToDisconnect.rebalance(stethToBurn);
        }

        vaultToDisconnect.report(vaultToDisconnect.valuation(), vaultToDisconnect.inOutDelta(), 0);

        VaultSocket memory lastSocket = sockets[sockets.length - 1];
        sockets[index] = lastSocket;
        vaultIndex[lastSocket.vault] = index;
        sockets.pop();

        delete vaultIndex[vaultToDisconnect];

        emit VaultDisconnected(address(vaultToDisconnect));
    }

    /// @notice mint StETH tokens backed by vault external balance to the receiver address
    /// @param _vault vault address
    /// @param _recipient address of the receiver
    /// @param _tokens amount of stETH tokens to mint
    /// @return totalEtherLocked total amount of ether that should be locked on the vault
    /// @dev can be used by vault owner only
    function mintStethBackedByVault(
        address _vault,
        address _recipient,
        uint256 _tokens
    ) external returns (uint256 totalEtherLocked) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_tokens == 0) revert ZeroArgument("_tokens");

        IHubVault vault_ = IHubVault(_vault);
        uint256 index = vaultIndex[vault_];
        if (index == 0) revert NotConnectedToHub(_vault);
        if (msg.sender != vault_.owner()) revert NotAuthorized("mint", msg.sender);

        VaultSocket memory socket = sockets[index];

        uint256 sharesToMint = stETH.getSharesByPooledEth(_tokens);
        uint256 vaultSharesAfterMint = socket.sharesMinted + sharesToMint;
        if (vaultSharesAfterMint > socket.shareLimit) revert MintCapReached(msg.sender, socket.shareLimit);

        int256 reserveRatioAfterMint = _reserveRatio(vault_, vaultSharesAfterMint);
        if (reserveRatioAfterMint < int16(socket.minReserveRatioBP)) {
            revert MinReserveRatioBroken(msg.sender, _reserveRatio(socket), socket.minReserveRatioBP);
        }

        sockets[index].sharesMinted = uint96(vaultSharesAfterMint);

        stETH.mintExternalShares(_recipient, sharesToMint);

        emit MintedStETHOnVault(msg.sender, _tokens);

        totalEtherLocked =
            (stETH.getPooledEthByShares(vaultSharesAfterMint) * BPS_BASE) /
            (BPS_BASE - socket.minReserveRatioBP);

        vault_.lock(totalEtherLocked);
    }

    /// @notice burn steth from the balance of the vault contract
    /// @param _vault vault address
    /// @param _tokens amount of tokens to burn
    /// @dev can be used by vault owner only; vaultHub must be approved to transfer stETH
    function burnStethBackedByVault(address _vault, uint256 _tokens) external {
        if (_tokens == 0) revert ZeroArgument("_tokens");

        IHubVault vault_ = IHubVault(_vault);
        uint256 index = vaultIndex[vault_];
        if (index == 0) revert NotConnectedToHub(_vault);
        if (msg.sender != vault_.owner()) revert NotAuthorized("burn", msg.sender);

        VaultSocket memory socket = sockets[index];

        stETH.transferFrom(msg.sender, address(this), _tokens);

        uint256 amountOfShares = stETH.getSharesByPooledEth(_tokens);
        if (socket.sharesMinted < amountOfShares) revert NotEnoughShares(msg.sender, socket.sharesMinted);

        sockets[index].sharesMinted -= uint96(amountOfShares);

        stETH.burnExternalShares(amountOfShares);

        emit BurnedStETHOnVault(msg.sender, _tokens);
    }

    /// @notice force rebalance of the vault
    /// @param _vault vault address
    /// @dev can be used permissionlessly if the vault's min reserve ratio is broken
    function forceRebalance(IHubVault _vault) external {
        uint256 index = vaultIndex[_vault];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        int256 reserveRatio_ = _reserveRatio(socket);

        if (reserveRatio_ >= int16(socket.thresholdReserveRatioBP)) {
            revert AlreadyBalanced(address(_vault), reserveRatio_, socket.minReserveRatioBP);
        }

        uint256 mintedStETH = stETH.getPooledEthByShares(socket.sharesMinted);
        uint256 maxMintedShare = (BPS_BASE - socket.minReserveRatioBP);

        // how much ETH should be moved out of the vault to rebalance it to minimal reserve ratio
        // (mintedStETH - X) / (vault.valuation() - X) == (BPS_BASE - minReserveRatioBP)
        //
        // X is amountToRebalance
        uint256 amountToRebalance = (mintedStETH * BPS_BASE - maxMintedShare * _vault.valuation()) /
            socket.minReserveRatioBP;

        // TODO: add some gas compensation here

        _vault.rebalance(amountToRebalance);

        if (reserveRatio_ >= _reserveRatio(socket)) revert RebalanceFailed(address(_vault));
    }

    /// @notice rebalances the vault, by writing off the amount equal to passed ether
    ///     from the vault's minted stETH counter
    /// @dev can be called by vaults only
    function rebalance() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        uint256 index = vaultIndex[IHubVault(msg.sender)];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        uint256 amountOfShares = stETH.getSharesByPooledEth(msg.value);
        if (socket.sharesMinted < amountOfShares) revert NotEnoughShares(msg.sender, socket.sharesMinted);

        sockets[index].sharesMinted = socket.sharesMinted - uint96(amountOfShares);

        // mint stETH (shares+ TPE+)
        (bool success, ) = address(stETH).call{value: msg.value}("");
        if (!success) revert StETHMintFailed(msg.sender);
        stETH.burnExternalShares(amountOfShares);

        emit VaultRebalanced(msg.sender, amountOfShares, _reserveRatio(socket));
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

        uint256 length = vaultsCount();
        // for each vault
        treasuryFeeShares = new uint256[](length);

        lockedEther = new uint256[](length);

        for (uint256 i = 0; i < length; ++i) {
            VaultSocket memory socket = sockets[i + 1];

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
            lockedEther[i] = (mintedStETH * BPS_BASE) / (BPS_BASE - socket.minReserveRatioBP);
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
        uint256 totalTreasuryShares;
        for (uint256 i = 0; i < _valuations.length; ++i) {
            VaultSocket memory socket = sockets[i + 1];
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

    function _reserveRatio(VaultSocket memory _socket) internal view returns (int256) {
        return _reserveRatio(_socket.vault, _socket.sharesMinted);
    }

    function _reserveRatio(IHubVault _vault, uint256 _mintedShares) internal view returns (int256) {
        return
            ((int256(_vault.valuation()) - int256(stETH.getPooledEthByShares(_mintedShares))) * int256(BPS_BASE)) /
            int256(_vault.valuation());
    }

    event VaultConnected(address vault, uint256 capShares, uint256 minReserveRatio, uint256 treasuryFeeBP);
    event VaultDisconnected(address vault);
    event MintedStETHOnVault(address sender, uint256 tokens);
    event BurnedStETHOnVault(address sender, uint256 tokens);
    event VaultRebalanced(address sender, uint256 shares, int256 reserveRatio);

    error StETHMintFailed(address vault);
    error AlreadyBalanced(address vault, int256 reserveRatio, uint256 minReserveRatio);
    error NotEnoughShares(address vault, uint256 amount);
    error MintCapReached(address vault, uint256 capShares);
    error AlreadyConnected(address vault, uint256 index);
    error NotConnectedToHub(address vault);
    error RebalanceFailed(address vault);
    error NotAuthorized(string operation, address addr);
    error ZeroArgument(string argument);
    error NotEnoughBalance(address vault, uint256 balance, uint256 shouldBe);
    error TooManyVaults();
    error CapTooHigh(address vault, uint256 capShares, uint256 maxCapShares);
    error ReserveRatioTooHigh(address vault, uint256 reserveRatioBP, uint256 maxReserveRatioBP);
    error TreasuryFeeTooHigh(address vault, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
    error ExternalBalanceCapReached(address vault, uint256 capVaultBalance, uint256 maxExternalBalance);
    error MinReserveRatioBroken(address vault, int256 reserveRatio, uint256 minReserveRatio);
}
