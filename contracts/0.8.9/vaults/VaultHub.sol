// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {ILockable} from "./interfaces/ILockable.sol";
import {IHub} from "./interfaces/IHub.sol";
import {ILiquidity} from "./interfaces/ILiquidity.sol";

interface StETH {
    function mintExternalShares(address, uint256) external;
    function burnExternalShares(uint256) external;

    function getPooledEthByShares(uint256) external view returns (uint256);
    function getSharesByPooledEth(uint256) external view returns (uint256);
    function getTotalShares() external view returns (uint256);
}

// TODO: rebalance gas compensation
// TODO: optimize storage
// TODO: add limits for vaults length
// TODO: unstructured storag and upgradability

/// @notice Vaults registry contract that is an interface to the Lido protocol
/// in the same time
/// @author folkyatina
abstract contract VaultHub is AccessControlEnumerable, IHub, ILiquidity {
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("VAULT_MASTER_ROLE");
    uint256 internal constant BPS_BASE = 1e4;
    uint256 internal constant MAX_VAULTS_COUNT = 500;

    StETH public immutable STETH;
    address public immutable TREASURE;

    struct VaultSocket {
        /// @notice vault address
        ILockable vault;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 capShares;
        /// @notice total number of stETH shares minted by the vault
        uint96 mintedShares;
        /// @notice minimum bond rate in basis points
        uint16 minBondRateBP;
        uint16 treasuryFeeBP;
    }

    /// @notice vault sockets with vaults connected to the hub
    /// @dev first socket is always zero. stone in the elevator
    VaultSocket[] private sockets;
    /// @notice mapping from vault address to its socket
    /// @dev if vault is not connected to the hub, it's index is zero
    mapping(ILockable => uint256) private vaultIndex;

    constructor(address _admin, address _stETH, address _treasury) {
        STETH = StETH(_stETH);
        TREASURE = _treasury;

        sockets.push(VaultSocket(ILockable(address(0)), 0, 0, 0, 0)); // stone in the elevator

        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice returns the number of vaults connected to the hub
    function vaultsCount() public view returns (uint256) {
        return sockets.length - 1;
    }

    function vault(uint256 _index) public view returns (ILockable) {
        return sockets[_index + 1].vault;
    }

    function vaultSocket(uint256 _index) external view returns (VaultSocket memory) {
        return sockets[_index + 1];
    }

    function vaultSocket(ILockable _vault) public view returns (VaultSocket memory) {
        return sockets[vaultIndex[_vault]];
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _capShares maximum number of stETH shares that can be minted by the vault
    /// @param _minBondRateBP minimum bond rate in basis points
    /// @param _treasuryFeeBP fee that goes to the treasury
    function connectVault(
        ILockable _vault,
        uint256 _capShares,
        uint256 _minBondRateBP,
        uint256 _treasuryFeeBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        if (_capShares == 0) revert ZeroArgument("capShares");
        if (_minBondRateBP == 0) revert ZeroArgument("minBondRateBP");
        if (_treasuryFeeBP == 0) revert ZeroArgument("treasuryFeeBP");
        if (address(_vault) == address(0)) revert ZeroArgument("vault");

        if (vaultIndex[_vault] != 0) revert AlreadyConnected(address(_vault));
        if (vaultsCount() >= MAX_VAULTS_COUNT) revert TooManyVaults();
        if (_capShares > STETH.getTotalShares() / 10) {
            revert CapTooHigh(address(_vault), _capShares, STETH.getTotalShares()/10);
        }
        if (_minBondRateBP > BPS_BASE) revert MinBondRateTooHigh(address(_vault), _minBondRateBP, BPS_BASE);
        if (_treasuryFeeBP > BPS_BASE) revert TreasuryFeeTooHigh(address(_vault), _treasuryFeeBP, BPS_BASE);

        VaultSocket memory vr = VaultSocket(ILockable(_vault), uint96(_capShares), 0, uint16(_minBondRateBP), uint16(_treasuryFeeBP));
        vaultIndex[_vault] = sockets.length;
        sockets.push(vr);

        emit VaultConnected(address(_vault), _capShares, _minBondRateBP);
    }

    /// @notice disconnects a vault from the hub
    /// @param _vault vault address
    function disconnectVault(ILockable _vault) external onlyRole(VAULT_MASTER_ROLE) {
        if (_vault == ILockable(address(0))) revert ZeroArgument("vault");

        uint256 index = vaultIndex[_vault];
        if (index == 0) revert NotConnectedToHub(address(_vault));
        VaultSocket memory socket = sockets[index];

        if (socket.mintedShares > 0) {
            uint256 stethToBurn = STETH.getPooledEthByShares(socket.mintedShares);
            if (address(_vault).balance >= stethToBurn) {
                _vault.rebalance(stethToBurn);
            } else {
                revert NotEnoughBalance(address(_vault), address(_vault).balance, stethToBurn);
            }
        }

        _vault.update(_vault.value(), _vault.netCashFlow(), 0);

        VaultSocket memory lastSocket = sockets[sockets.length - 1];
        sockets[index] = lastSocket;
        vaultIndex[lastSocket.vault] = index;
        sockets.pop();

        delete vaultIndex[_vault];

        emit VaultDisconnected(address(_vault));
    }

    /// @notice mint StETH tokens  backed by vault external balance to the receiver address
    /// @param _receiver address of the receiver
    /// @param _amountOfTokens amount of stETH tokens to mint
    /// @return totalEtherToLock total amount of ether that should be locked on the vault
    /// @dev can be used by vaults only
    function mintStethBackedByVault(
        address _receiver,
        uint256 _amountOfTokens
    ) external returns (uint256 totalEtherToLock) {
        if (_amountOfTokens == 0) revert ZeroArgument("amountOfTokens");
        if (_receiver == address(0)) revert ZeroArgument("receivers");

        ILockable vault_ = ILockable(msg.sender);
        uint256 index = vaultIndex[vault_];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        uint256 sharesToMint = STETH.getSharesByPooledEth(_amountOfTokens);
        uint256 sharesMintedOnVault = socket.mintedShares + sharesToMint;
        if (sharesMintedOnVault > socket.capShares) revert MintCapReached(msg.sender);

        uint256 newMintedStETH = STETH.getPooledEthByShares(sharesMintedOnVault);
        totalEtherToLock = newMintedStETH * BPS_BASE / (BPS_BASE - socket.minBondRateBP);
        if (totalEtherToLock > vault_.value()) revert BondLimitReached(msg.sender);

        sockets[index].mintedShares = uint96(sharesMintedOnVault);

        STETH.mintExternalShares(_receiver, sharesToMint);

        emit MintedStETHOnVault(msg.sender, _amountOfTokens);
    }

    /// @notice burn steth from the balance of the vault contract
    /// @param _amountOfTokens amount of tokens to burn
    /// @dev can be used by vaults only
    function burnStethBackedByVault(uint256 _amountOfTokens) external {
        if (_amountOfTokens == 0) revert ZeroArgument("amountOfTokens");

        uint256 index = vaultIndex[ILockable(msg.sender)];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        uint256 amountOfShares = STETH.getSharesByPooledEth(_amountOfTokens);
        if (socket.mintedShares < amountOfShares) revert NotEnoughShares(msg.sender, socket.mintedShares);

        sockets[index].mintedShares -= uint96(amountOfShares);
        STETH.burnExternalShares(amountOfShares);

        emit BurnedStETHOnVault(msg.sender, _amountOfTokens);
    }

    function forceRebalance(ILockable _vault) external {
        uint256 index = vaultIndex[_vault];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        if (_vault.isHealthy()) revert AlreadyBalanced(address(_vault));

        uint256 mintedStETH = STETH.getPooledEthByShares(socket.mintedShares);
        uint256 maxMintedShare = (BPS_BASE - socket.minBondRateBP);

        // how much ETH should be moved out of the vault to rebalance it to target bond rate
        // (mintedStETH - X) / (vault.value() - X) == (BPS_BASE - minBondRateBP)
        //
        // X is amountToRebalance
        uint256 amountToRebalance =
            (mintedStETH * BPS_BASE - maxMintedShare * _vault.value()) / socket.minBondRateBP;

        // TODO: add some gas compensation here

        uint256 mintRateBefore = _mintRate(socket);
        _vault.rebalance(amountToRebalance);

        if (mintRateBefore > _mintRate(socket)) revert RebalanceFailed(address(_vault));
    }

    function rebalance() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        uint256 index = vaultIndex[ILockable(msg.sender)];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        uint256 amountOfShares = STETH.getSharesByPooledEth(msg.value);
        if (socket.mintedShares < amountOfShares) revert NotEnoughShares(msg.sender, socket.mintedShares);

        // mint stETH (shares+ TPE+)
        (bool success,) = address(STETH).call{value: msg.value}("");
        if (!success) revert StETHMintFailed(msg.sender);

        sockets[index].mintedShares -= uint96(amountOfShares);
        STETH.burnExternalShares(amountOfShares);

        emit VaultRebalanced(msg.sender, amountOfShares, _mintRate(socket));
    }

    function _calculateVaultsRebase(
        uint256 postTotalShares,
        uint256 postTotalPooledEther,
        uint256 preTotalShares,
        uint256 preTotalPooledEther,
        uint256 sharesToMintAsFees
    ) internal view returns (
        uint256[] memory lockedEther,
        uint256[] memory treasuryFeeShares
    ) {
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
            if (sharesToMintAsFees > 0) {
                treasuryFeeShares[i] = _calculateLidoFees(
                    socket,
                    postTotalShares - sharesToMintAsFees,
                    postTotalPooledEther,
                    preTotalShares,
                    preTotalPooledEther
                );
            }

            uint256 totalMintedShares = socket.mintedShares + treasuryFeeShares[i];
            uint256 mintedStETH = totalMintedShares * postTotalPooledEther / postTotalShares; //TODO: check rounding
            lockedEther[i] = mintedStETH * BPS_BASE / (BPS_BASE - socket.minBondRateBP);
        }
    }

    function _calculateLidoFees(
        VaultSocket memory _socket,
        uint256 postTotalSharesNoFees,
        uint256 postTotalPooledEther,
        uint256 preTotalShares,
        uint256 preTotalPooledEther
    ) internal view returns (uint256 treasuryFeeShares) {
        ILockable vault_ = _socket.vault;

        uint256 chargeableValue = _min(vault_.value(), _socket.capShares * preTotalPooledEther / preTotalShares);

        // treasury fee is calculated as a share of potential rewards that
        // Lido curated validators could earn if vault's ETH was staked in Lido
        // itself and minted as stETH shares
        //
        // treasuryFeeShares = value * lidoGrossAPR * treasuryFeeRate / preShareRate
        // lidoGrossAPR = postShareRateWithoutFees / preShareRate - 1
        // = value  * (postShareRateWithoutFees / preShareRate - 1) * treasuryFeeRate / preShareRate

        // TODO: optimize potential rewards calculation
        uint256 potentialRewards = (chargeableValue * (postTotalPooledEther * preTotalShares) / (postTotalSharesNoFees * preTotalPooledEther) - chargeableValue);
        uint256 treasuryFee = potentialRewards * _socket.treasuryFeeBP / BPS_BASE;

        treasuryFeeShares = treasuryFee * preTotalShares / preTotalPooledEther;
    }

    function _updateVaults(
        uint256[] memory values,
         int256[] memory netCashFlows,
        uint256[] memory lockedEther,
        uint256[] memory treasuryFeeShares
    ) internal {
        uint256 totalTreasuryShares;
        for(uint256 i = 0; i < values.length; ++i) {
            VaultSocket memory socket = sockets[i + 1];
            // TODO: can be aggregated and optimized
            if (treasuryFeeShares[i] > 0) {
                socket.mintedShares += uint96(treasuryFeeShares[i]);
                totalTreasuryShares += treasuryFeeShares[i];
            }

            socket.vault.update(
                values[i],
                netCashFlows[i],
                lockedEther[i]
            );
        }

        if (totalTreasuryShares > 0) {
            STETH.mintExternalShares(TREASURE, totalTreasuryShares);
        }
    }

    function _mintRate(VaultSocket memory _socket) internal view returns (uint256) {
        return STETH.getPooledEthByShares(_socket.mintedShares) * BPS_BASE / _socket.vault.value(); //TODO: check rounding
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    error StETHMintFailed(address vault);
    error AlreadyBalanced(address vault);
    error NotEnoughShares(address vault, uint256 amount);
    error BondLimitReached(address vault);
    error MintCapReached(address vault);
    error AlreadyConnected(address vault);
    error NotConnectedToHub(address vault);
    error RebalanceFailed(address vault);
    error NotAuthorized(string operation, address addr);
    error ZeroArgument(string argument);
    error NotEnoughBalance(address vault, uint256 balance, uint256 shouldBe);
    error TooManyVaults();
    error CapTooHigh(address vault, uint256 capShares, uint256 maxCapShares);
    error MinBondRateTooHigh(address vault, uint256 minBondRateBP, uint256 maxMinBondRateBP);
    error TreasuryFeeTooHigh(address vault, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
}
