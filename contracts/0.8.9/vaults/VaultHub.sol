// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {IConnected} from "./interfaces/IConnected.sol";
import {IHub} from "./interfaces/IHub.sol";

interface StETH {
    function getExternalEther() external view returns (uint256);
    function mintExternalShares(address, uint256) external;
    function burnExternalShares(address, uint256) external;

    function getPooledEthByShares(uint256) external returns (uint256);
    function getSharesByPooledEth(uint256) external view returns (uint256);

    function transferShares(address, uint256) external returns (uint256);
}

contract VaultHub is AccessControlEnumerable, IHub {
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("VAULT_MASTER_ROLE");

    uint256 internal constant BPS_IN_100_PERCENT = 10000;

    StETH public immutable STETH;

    struct VaultSocket {
        IConnected vault;
        /// @notice maximum number of stETH shares that can be minted for this vault
        /// TODO: figure out the fees interaction with the cap
        uint256 capShares;
        uint256 mintedShares; // TODO: optimize
        uint256 minimumBondShareBP;
    }

    VaultSocket[] public vaults;
    mapping(IConnected => VaultSocket) public vaultIndex;

    constructor(address _mintBurner) {
        STETH = StETH(_mintBurner);
    }

    function getVaultsCount() external view returns (uint256) {
        return vaults.length;
    }

    function addVault(
        IConnected _vault,
        uint256 _capShares,
        uint256 _minimumBondShareBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        // we should add here a register of vault implementations
        // and deploy proxies directing to these

        if (vaultIndex[_vault].vault != IConnected(address(0))) revert("ALREADY_EXIST"); // TODO: custom error

        VaultSocket memory vr = VaultSocket(IConnected(_vault), _capShares, 0, _minimumBondShareBP);
        vaults.push(vr); //TODO: uint256 and safecast
        vaultIndex[_vault] = vr;

        // TODO: emit
    }

    /// @notice mint shares backed by vault external balance to the receiver address
    /// @param _receiver address of the receiver
    /// @param _shares amount of shares to mint
    /// @return totalEtherToLock total amount of ether that should be locked
    function mintSharesBackedByVault(
        address _receiver,
        uint256 _shares
    ) external returns (uint256 totalEtherToLock) {
        IConnected vault = IConnected(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        uint256 mintedShares = socket.mintedShares + _shares;
        if (mintedShares >= socket.capShares) revert("CAP_REACHED");

        totalEtherToLock = STETH.getPooledEthByShares(mintedShares) * BPS_IN_100_PERCENT / (BPS_IN_100_PERCENT - socket.minimumBondShareBP);
        if (totalEtherToLock >= vault.value()) {
            revert("MAX_MINT_RATE_REACHED");
        }

        vaultIndex[vault].mintedShares = mintedShares; // SSTORE

        STETH.mintExternalShares(_receiver, _shares);

        // TODO: events

        // TODO: invariants
        // mintedShares <= lockedBalance in shares
        // mintedShares <= capShares
        // externalBalance == sum(lockedBalance - bond )
    }

    function burnSharesBackedByVault(address _account, uint256 _amountOfShares) external {
        IConnected vault = IConnected(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        if (socket.mintedShares < _amountOfShares) revert("NOT_ENOUGH_SHARES");

        vaultIndex[vault].mintedShares = socket.mintedShares - _amountOfShares;

        STETH.burnExternalShares(_account, _amountOfShares);

        // TODO: events
        // TODO: invariants
    }

    function forgive() external payable {
        IConnected vault = IConnected(msg.sender);
        VaultSocket memory socket = _authedSocket(vault);

        uint256 numberOfShares = STETH.getSharesByPooledEth(msg.value);

        vaultIndex[vault].mintedShares = socket.mintedShares - numberOfShares;

        // mint stETH (shares+ TPE+)
        (bool success,) = address(STETH).call{value: msg.value}("");
        if (!success) revert("STETH_MINT_FAILED");

        // and burn on behalf of this node (shares- TPE-)
        STETH.burnExternalShares(address(this), numberOfShares);
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

            lockedEther[i] = externalEther * BPS_IN_100_PERCENT / (BPS_IN_100_PERCENT - socket.minimumBondShareBP);
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

    function _authedSocket(IConnected _vault) internal view returns (VaultSocket memory) {
        VaultSocket memory socket = vaultIndex[_vault];
        if (socket.vault != _vault) revert("NOT_CONNECTED_TO_HUB");

        return socket;
    }
}
