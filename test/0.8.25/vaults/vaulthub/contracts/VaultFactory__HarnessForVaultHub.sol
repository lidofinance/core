// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultFactory} from "contracts/0.8.25/vaults/VaultFactory.sol";
import {IVaultFactory} from "contracts/0.8.25/vaults/interfaces/IVaultFactory.sol";

/**
 * @title VaultFactory__HarnessForVaultHub
 * @notice Test harness for VaultFactory that adds helper functions for testing
 * @dev Extends the real VaultFactory with test-only vault registration
 */
contract VaultFactory__HarnessForVaultHub is VaultFactory {
    // Track test-registered vaults separately
    mapping(address => bool) private testRegisteredVaults;

    constructor(
        address _lidoLocator,
        address _beacon,
        address _dashboardImpl,
        address _previousFactory
    ) VaultFactory(_lidoLocator, _beacon, _dashboardImpl, _previousFactory) {}

    /**
     * @notice Test helper: Register a vault that was created outside the factory
     * @param _vault The vault address to register
     * @dev This is needed for tests that create vaults manually via PinnedBeaconProxy
     */
    function registerTestVault(address _vault) external {
        testRegisteredVaults[_vault] = true;
    }

    /**
     * @notice Check if a vault is registered for testing
     * @param _vault The vault address to check
     * @return true if vault was registered via registerTestVault
     */
    function isTestRegistered(address _vault) external view returns (bool) {
        return testRegisteredVaults[_vault];
    }

    /**
     * @notice Shadow deployedVaults to include test registrations
     * @param _vault The vault address to check
     * @return true if vault was deployed by factory or registered for testing
     * @dev This shadows the base implementation. Cast to this type to use it.
     */
    function deployedVaultsWithTest(address _vault) external view returns (bool) {
        // Check test registrations first
        if (testRegisteredVaults[_vault]) {
            return true;
        }

        // Check real factory deployment via the interface
        return IVaultFactory(address(this)).deployedVaults(_vault);
    }
}
