// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultFactory} from "contracts/0.8.25/vaults/VaultFactory.sol";
import {IVaultFactory} from "contracts/0.8.25/vaults/interfaces/IVaultFactory.sol";

/**
 * @title VaultFactoryWrapper
 * @notice Wrapper for VaultFactory that intercepts deployedVaults() calls
 * @dev Uses composition (HAS-A) instead of inheritance to intercept non-virtual function
 */
contract VaultFactoryWrapper is IVaultFactory {
    VaultFactory public immutable wrappedFactory;

    // Track test-registered vaults
    mapping(address => bool) private testRegisteredVaults;

    constructor(VaultFactory _factory) {
        wrappedFactory = _factory;
    }

    /**
     * @notice Test helper: Register a vault that was created outside the factory
     * @param _vault The vault address to register
     */
    function registerTestVault(address _vault) external {
        testRegisteredVaults[_vault] = true;
    }

    /**
     * @notice Intercepts deployedVaults to check both real factory and test registrations
     * @param _vault The vault address to check
     * @return true if vault was deployed by factory or registered for testing
     */
    function deployedVaults(address _vault) external view override returns (bool) {
        // Check test registrations first
        if (testRegisteredVaults[_vault]) {
            return true;
        }

        // Check real factory deployment
        return wrappedFactory.deployedVaults(_vault);
    }
}
