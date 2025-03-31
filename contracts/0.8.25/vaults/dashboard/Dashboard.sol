// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {UXLayer} from "./UXLayer.sol";
import {IStakingVault} from "../interfaces/IStakingVault.sol";
import {VaultHub} from "../VaultHub.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";

contract Dashboard is UXLayer {
    /**
     * @notice Address of the implementation contract
     * @dev Used to prevent initialization in the implementation
     */
    address private immutable _SELF;

    /**
     * @notice Indicates whether the contract has been initialized
     */
    bool public initialized;

    constructor(address _wETH, address _lidoLocator) UXLayer(_wETH, _lidoLocator) {
        _SELF = address(this);
    }

    function initialize(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) public {
        if (initialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();

        initialized = true;

        super._initialize(_defaultAdmin, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);

        emit Initialized(_defaultAdmin);
    }

    function stakingVault() public view override returns (IStakingVault) {
        return IStakingVault(_loadStakingVaultAddress());
    }

    function vaultHub() public view override returns (VaultHub) {
        return VaultHub(stakingVault().vaultHub());
    }

    /**
     * @dev Loads the address of the underlying StakingVault.
     * @return addr The address of the StakingVault.
     */
    function _loadStakingVaultAddress() internal view returns (address addr) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        assembly {
            addr := mload(add(args, 32))
        }
    }
}
