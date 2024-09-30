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
}

// TODO: rebalance gas compensation
// TODO: optimize storage
// TODO: add limits for vaults length
abstract contract VaultHub is AccessControlEnumerable, IHub, ILiquidity {
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("VAULT_MASTER_ROLE");

    uint256 internal constant BPS_BASE = 1e4;

    StETH public immutable STETH;
    address public immutable treasury;

    struct VaultSocket {
        /// @notice vault address
        ILockable vault;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint256 capShares;
        /// @notice total number of stETH shares minted by the vault
        uint256 mintedShares;
        /// @notice minimum bond rate in basis points
        uint256 minBondRateBP;
        uint256 treasuryFeeBP;
    }

    /// @notice vault sockets with vaults connected to the hub
    VaultSocket[] public vaults;
    /// @notice mapping from vault address to its socket
    mapping(ILockable => VaultSocket) public vaultIndex;

    constructor(address _admin, address _stETH, address _treasury) {
        STETH = StETH(_stETH);
        treasury = _treasury;

        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice returns the number of vaults connected to the hub
    function getVaultsCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _capShares maximum number of stETH shares that can be minted by the vault
    /// @param _minBondRateBP minimum bond rate in basis points
    function connectVault(
        ILockable _vault,
        uint256 _capShares,
        uint256 _minBondRateBP,
        uint256 _treasuryFeeBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        if (vaultIndex[_vault].vault != ILockable(address(0))) revert AlreadyConnected(address(_vault));

        //TODO: sanity checks on parameters

        VaultSocket memory vr = VaultSocket(ILockable(_vault), _capShares, 0, _minBondRateBP, _treasuryFeeBP);
        vaults.push(vr);
        vaultIndex[_vault] = vr;

        emit VaultConnected(address(_vault), _capShares, _minBondRateBP);
    }

    /// @notice disconnects a vault from the hub
    /// @param _vault vault address
    /// @param _index index of the vault in the `vaults` array
    function disconnectVault(ILockable _vault, uint256 _index) external onlyRole(VAULT_MASTER_ROLE) {
        VaultSocket memory socket = vaultIndex[_vault];
        if (socket.vault != ILockable(address(0))) revert NotConnectedToHub(address(_vault));
        if (socket.vault != vaults[_index].vault) revert WrongVaultIndex(address(_vault), _index);

        vaults[_index] = vaults[vaults.length - 1];
        vaults.pop();
        delete vaultIndex[_vault];

        emit VaultDisconnected(address(_vault));
    }

    /// @notice mint shares backed by vault external balance to the receiver address
    /// @param _receiver address of the receiver
    /// @param _amountOfShares amount of shares to mint
    /// @return totalEtherToLock total amount of ether that should be locked on the vault
    /// @dev can be used by vaults only
    function mintSharesBackedByVault(
        address _receiver,
        uint256 _amountOfShares
    ) public returns (uint256 totalEtherToLock) {
        ILockable vault = ILockable(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        uint256 newMintedShares = socket.mintedShares + _amountOfShares;
        if (newMintedShares > socket.capShares) revert MintCapReached(address(vault));

        uint256 newMintedStETH = STETH.getPooledEthByShares(newMintedShares);
        totalEtherToLock = newMintedStETH * BPS_BASE / (BPS_BASE - socket.minBondRateBP);
        if (totalEtherToLock > vault.value()) revert BondLimitReached(address(vault));

        _mintSharesBackedByVault(socket, _receiver, _amountOfShares);
    }

    /// @notice mint StETH tokens  backed by vault external balance to the receiver address
    /// @param _receiver address of the receiver
    /// @param _amountOfTokens amount of stETH tokens to mint
    /// @return totalEtherToLock total amount of ether that should be locked on the vault
    /// @dev can be used by vaults only
    function mintStethBackedByVault(
        address _receiver,
        uint256 _amountOfTokens
    ) external returns (uint256) {
        uint256 sharesToMintAsFees = STETH.getSharesByPooledEth(_amountOfTokens);

        return mintSharesBackedByVault(_receiver, sharesToMintAsFees);
    }

    /// @notice burn shares backed by vault external balance
    /// @dev shares should be approved to be spend by this contract
    /// @param _amountOfShares amount of shares to burn
    /// @dev can be used by vaults only
    function burnSharesBackedByVault(uint256 _amountOfShares) external {
        ILockable vault = ILockable(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        _burnSharesBackedByVault(socket, _amountOfShares);
    }

    function forceRebalance(ILockable _vault) external {
        VaultSocket memory socket = _authedSocket(_vault);

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
        ILockable vault = ILockable(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        uint256 numberOfShares = STETH.getSharesByPooledEth(msg.value);

        // mint stETH (shares+ TPE+)
        (bool success,) = address(STETH).call{value: msg.value}("");
        if (!success) revert StETHMintFailed(address(vault));

        _burnSharesBackedByVault(socket, numberOfShares);

        emit VaultRebalanced(address(vault), numberOfShares, socket.minBondRateBP);
    }

    function _mintSharesBackedByVault(
        VaultSocket memory _socket,
        address _receiver,
        uint256 _amountOfShares
    ) internal {
        ILockable vault = _socket.vault;

        vaultIndex[vault].mintedShares += _amountOfShares;
        STETH.mintExternalShares(_receiver, _amountOfShares);
        emit MintedSharesOnVault(address(vault), _amountOfShares);

        // TODO: invariants
        // mintedShares <= lockedBalance in shares
        // mintedShares <= capShares
        // externalBalance == sum(lockedBalance - bond )
    }

    function _burnSharesBackedByVault(VaultSocket memory _socket, uint256 _amountOfShares) internal {
        ILockable vault = _socket.vault;
        if (_socket.mintedShares < _amountOfShares) revert NotEnoughShares(address(vault), _socket.mintedShares);

        vaultIndex[vault].mintedShares -= _amountOfShares;
        STETH.burnExternalShares(_amountOfShares);
        emit BurnedSharesOnVault(address(vault), _amountOfShares);
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

        // for each vault
        treasuryFeeShares = new uint256[](vaults.length);

        lockedEther = new uint256[](vaults.length);

        for (uint256 i = 0; i < vaults.length; ++i) {
            VaultSocket memory socket = vaults[i];

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
            uint256 externalEther = totalMintedShares * postTotalPooledEther / postTotalShares; //TODO: check rounding
            lockedEther[i] = externalEther * BPS_BASE / (BPS_BASE - socket.minBondRateBP);
        }
    }

    function _calculateLidoFees(
        VaultSocket memory _socket,
        uint256 postTotalSharesNoFees,
        uint256 postTotalPooledEther,
        uint256 preTotalShares,
        uint256 preTotalPooledEther
    ) internal view returns (uint256 treasuryFeeShares) {
        ILockable vault = _socket.vault;

        uint256 chargeableValue = _min(vault.value(), _socket.capShares * preTotalPooledEther / preTotalShares);

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
        for(uint256 i; i < vaults.length; ++i) {
            VaultSocket memory socket = vaults[i];
            // TODO: can be aggregated and optimized
            if (treasuryFeeShares[i] > 0) _mintSharesBackedByVault(socket, treasury, treasuryFeeShares[i]);

            socket.vault.update(
                values[i],
                netCashFlows[i],
                lockedEther[i]
            );
        }
    }

    function _mintRate(VaultSocket memory _socket) internal view returns (uint256) {
        return STETH.getPooledEthByShares(_socket.mintedShares) * BPS_BASE / _socket.vault.value(); //TODO: check rounding
    }

    function _authedSocket(ILockable _vault) internal view returns (VaultSocket memory) {
        VaultSocket memory socket = vaultIndex[_vault];
        if (socket.vault != _vault) revert NotConnectedToHub(address(_vault));

        return socket;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    error StETHMintFailed(address vault);
    error AlreadyBalanced(address vault);
    error NotEnoughShares(address vault, uint256 amount);
    error WrongVaultIndex(address vault, uint256 index);
    error BondLimitReached(address vault);
    error MintCapReached(address vault);
    error AlreadyConnected(address vault);
    error NotConnectedToHub(address vault);
    error RebalanceFailed(address vault);
    error NotAuthorized(string operation, address addr);
}
