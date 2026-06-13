import "snippet_IHashConsensusMock.spec";
import "snippet_StakingVault.spec";

methods {
    function _._stakingVault() internal => CONSTANT;
    function _.verify(bytes32[] memory, bytes32, bytes32) internal => NONDET;

    // dispatch local variables to Dashboard
    function _.initialize(address,address,address,uint256,uint256) external => DISPATCHER(true);
    function _.grantRoles(Permissions.RoleAssignment[]) external => DISPATCHER(true);
    function _.grantRole(bytes32, address) external => DISPATCHER(true);
    function _.revokeRole(bytes32, address) external => DISPATCHER(true);
    function _.DEFAULT_ADMIN_ROLE() external => DISPATCHER(true);
    function _.NODE_OPERATOR_MANAGER_ROLE() external => DISPATCHER(true);
}
