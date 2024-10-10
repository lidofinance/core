// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v4.4/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v4.4/proxy/beacon/BeaconProxy.sol";
import {IHub} from "./interfaces/IHub.sol";
import {ILockable} from "./interfaces/ILockable.sol";
import {StakingVault} from "./StakingVault.sol";

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

contract VaultFactory is UpgradeableBeacon{

    IHub public immutable VAULT_HUB;

    error ZeroAddress(string field);

    /**
    * @notice Event emitted on a Vault creation
    * @param admin The address of the Vault admin
    * @param vault The address of the created Vault
    * @param capShares The maximum number of stETH shares that can be minted by the vault
    * @param minimumBondShareBP The minimum bond rate in basis points
    * @param treasuryFeeBP The fee that goes to the treasury
    */
    event VaultCreated(
        address indexed admin,
        address indexed vault,
        uint256 capShares,
        uint256 minimumBondShareBP,
        uint256 treasuryFeeBP
    );

    constructor(address _owner, address _implementation, IHub _vaultHub) UpgradeableBeacon(_implementation) {
        if (_implementation == address(0)) revert ZeroAddress("_implementation");
        if (address(_vaultHub) == address(0)) revert ZeroAddress("_vaultHub");
        _transferOwnership(_owner);
        VAULT_HUB = _vaultHub;
    }

    function createVault(
        address _vaultOwner,
        uint256 _capShares,
        uint256 _minimumBondShareBP,
        uint256 _treasuryFeeBP
    ) external onlyOwner returns(address vault) {
        if (address(_vaultOwner) == address(0)) revert ZeroAddress("_vaultOwner");

        vault = address(
            new BeaconProxy(
                address(this),
                abi.encodeWithSelector(StakingVault.initialize.selector, _vaultOwner)
            )
        );

        // add vault to hub
        VAULT_HUB.connectVault(ILockable(vault), _capShares, _minimumBondShareBP, _treasuryFeeBP);

        // emit event
        emit VaultCreated(_vaultOwner, vault, _capShares, _minimumBondShareBP, _treasuryFeeBP);

        return address(vault);
    }
}
