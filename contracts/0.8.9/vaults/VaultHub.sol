// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {ILockable} from "./interfaces/ILockable.sol";
import {IHub} from "./interfaces/IHub.sol";

interface StETH {
    function mintExternalShares(address, uint256) external;
    function burnExternalShares(uint256) external;

    function getPooledEthByShares(uint256) external view returns (uint256);
    function getSharesByPooledEth(uint256) external view returns (uint256);
}

// TODO: add Lido fees
// TODO: rebalance gas compensation
// TODO: optimize storage
contract VaultHub is AccessControlEnumerable, IHub {
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("VAULT_MASTER_ROLE");

    uint256 internal constant BPS_BASE = 10000;

    StETH public immutable STETH;

    struct VaultSocket {
        /// @notice vault address
        ILockable vault;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint256 capShares;
        /// @notice total number of stETH shares minted by the vault
        uint256 mintedShares;
        /// @notice minimum bond rate in basis points
        uint256 minBondRateBP;
    }

    /// @notice vault sockets with vaults connected to the hub
    VaultSocket[] public vaults;
    /// @notice mapping from vault address to its socket
    mapping(ILockable => VaultSocket) public vaultIndex;

    constructor(address _admin, address _stETH) {
        STETH = StETH(_stETH);

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
        uint256 _minBondRateBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        if (vaultIndex[_vault].vault != ILockable(address(0))) revert AlreadyConnected(address(_vault));

        VaultSocket memory vr = VaultSocket(ILockable(_vault), _capShares, 0, _minBondRateBP);
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
    /// @param _shares amount of shares to mint
    /// @return totalEtherToLock total amount of ether that should be locked on the vault
    function mintSharesBackedByVault(
        address _receiver,
        uint256 _shares
    ) external returns (uint256 totalEtherToLock) {
        ILockable vault = ILockable(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        uint256 newMintedShares = socket.mintedShares + _shares;
        if (newMintedShares > socket.capShares) revert MintCapReached(address(vault));

        uint256 newMintedStETH = STETH.getPooledEthByShares(newMintedShares);
        totalEtherToLock = newMintedStETH * BPS_BASE / (BPS_BASE - socket.minBondRateBP);
        if (totalEtherToLock > vault.value()) revert BondLimitReached(address(vault));

        vaultIndex[vault].mintedShares = newMintedShares;
        STETH.mintExternalShares(_receiver, _shares);

        emit MintedSharesOnVault(address(vault), newMintedShares);

        // TODO: invariants
        // mintedShares <= lockedBalance in shares
        // mintedShares <= capShares
        // externalBalance == sum(lockedBalance - bond )
    }

    /// @notice burn shares backed by vault external balance
    /// @dev shares should be approved to be spend by this contract
    /// @param _amountOfShares amount of shares to burn
    function burnSharesBackedByVault(uint256 _amountOfShares) external {
        ILockable vault = ILockable(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        if (socket.mintedShares < _amountOfShares) revert NotEnoughShares(address(vault), socket.mintedShares);

        uint256 newMintedShares = socket.mintedShares - _amountOfShares;
        vaultIndex[vault].mintedShares = newMintedShares;
        STETH.burnExternalShares(_amountOfShares);

        emit BurnedSharesOnVault(address(vault), newMintedShares);
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

        emit VaultRebalanced(address(_vault), socket.minBondRateBP, amountToRebalance);
    }

    function forgive() external payable {
        ILockable vault = ILockable(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        uint256 numberOfShares = STETH.getSharesByPooledEth(msg.value);

        vaultIndex[vault].mintedShares = socket.mintedShares - numberOfShares;

        // mint stETH (shares+ TPE+)
        (bool success,) = address(STETH).call{value: msg.value}("");
        if (!success) revert StETHMintFailed(address(vault));

        // and burn on behalf of this node (shares- TPE-)
        STETH.burnExternalShares(numberOfShares);
    }

    struct ShareRate {
        uint256 eth;
        uint256 shares;
    }

    function _calculateVaultsRebase(
        ShareRate memory shareRate
    ) internal view returns (
        uint256[] memory lockedEther
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
        lockedEther = new uint256[](vaults.length);

        for (uint256 i = 0; i < vaults.length; ++i) {
            VaultSocket memory socket = vaults[i];
            uint256 externalEther = socket.mintedShares * shareRate.eth / shareRate.shares;

            lockedEther[i] = externalEther * BPS_BASE / (BPS_BASE - socket.minBondRateBP);
        }

        // here we need to pre-calculate the new locked balance for each vault
        // factoring in stETH APR, treasury fee, optionality fee and NO fee

        // rebalance fee //TODO: implement

        // fees is calculated based on the current `balance.locked` of the vault
        // minting new fees as new external shares
        // then new balance.locked is derived from `mintedShares` of the vault

        // So the vault is paying fee from the highest amount of stETH minted
        // during the period

        // vault gets its balance unlocked only after the report
        // PROBLEM: infinitely locked balance
        // 1. we incur fees => minting stETH on behalf of the vault
        // 2. even if we burn all stETH, we have a bit of stETH minted
        // 3. new borrow fee will be incurred next time ...
        // 4  ...
        // 5. infinite fee circle

        // So, we need a way to close the vault completely and way out
        // - Separate close procedure
        // - take fee as ETH if possible (can optimize some gas on accounting mb)
    }

    function _updateVaults(
        uint256[] memory values,
        int256[] memory netCashFlows,
        uint256[] memory lockedEther
    ) internal {
        for(uint256 i; i < vaults.length; ++i) {
            vaults[i].vault.update(
                values[i],
                netCashFlows[i],
                lockedEther[i]
            );
        }
    }

    function _mintRate(VaultSocket memory _socket) internal view returns (uint256) {
        return  STETH.getPooledEthByShares(_socket.mintedShares) * BPS_BASE / _socket.vault.value();
    }

    function _authedSocket(ILockable _vault) internal view returns (VaultSocket memory) {
        VaultSocket memory socket = vaultIndex[_vault];
        if (socket.vault != _vault) revert NotConnectedToHub(address(_vault));

        return socket;
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
