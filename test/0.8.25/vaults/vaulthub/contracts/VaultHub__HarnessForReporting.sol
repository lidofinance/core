// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";

contract VaultHub__HarnessForReporting is VaultHub {
    // keccak256(abi.encode(uint256(keccak256("VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_HUB_STORAGE_LOCATION =
        0xb158a1a9015c52036ff69e7937a7bb424e82a8c4cbec5c5309994af06d825300;

    constructor(
        ILidoLocator _locator,
        ILido _lido,
        uint256 _connectedVaultsLimit,
        uint256 _relativeShareLimitBP
    ) VaultHub(_locator, _lido, _connectedVaultsLimit, _relativeShareLimitBP) {}

    function harness_getVaultHubStorage() private pure returns (VaultHubStorage storage $) {
        assembly {
            $.slot := VAULT_HUB_STORAGE_LOCATION
        }
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _reserveRatioBP minimum reserve ratio in basis points
    /// @param _rebalanceThresholdBP threshold to force rebalance on the vault in basis points
    /// @param _treasuryFeeBP treasury fee in basis points
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function harness__connectVault(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _rebalanceThresholdBP,
        uint256 _treasuryFeeBP
    ) external {
        VaultHubStorage storage $ = harness_getVaultHubStorage();

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

        emit VaultConnected(_vault, _shareLimit, _reserveRatioBP, _rebalanceThresholdBP, _treasuryFeeBP);
    }
}
