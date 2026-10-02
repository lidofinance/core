// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

/**
 * @title MinimalDashboard
 * @notice Minimal Dashboard implementation for VaultFactory testing
 * @dev Only exists so VaultFactory constructor doesn't revert
 *      VaultFactory uses Clones.cloneWithImmutableArgs which doesn't call constructor
 */
contract MinimalDashboard {
    /**
     * @notice Stub initialize to prevent reverts if factory tries to initialize
     * @dev Dashboard initialize signature for compatibility
     */
    function initialize(address, address, address, uint256, uint256) external {}

    /**
     * @notice Stub grantRole for factory initialization flow
     */
    function grantRole(bytes32, address) external {}

    /**
     * @notice Stub revokeRole for factory initialization flow
     */
    function revokeRole(bytes32, address) external {}

    /**
     * @notice Stub DEFAULT_ADMIN_ROLE getter
     */
    function DEFAULT_ADMIN_ROLE() external pure returns (bytes32) {
        return 0x00;
    }

    /**
     * @notice Stub NODE_OPERATOR_MANAGER_ROLE getter
     */
    function NODE_OPERATOR_MANAGER_ROLE() external pure returns (bytes32) {
        return keccak256("NODE_OPERATOR_MANAGER_ROLE");
    }

    /**
     * @notice Stub connectToVaultHub for factory flow
     */
    function connectToVaultHub() external payable {}

    /**
     * @notice Stub grantRoles for factory flow
     */
    function grantRoles(RoleAssignment[] calldata) external {}

    struct RoleAssignment {
        bytes32 role;
        address account;
    }
}
