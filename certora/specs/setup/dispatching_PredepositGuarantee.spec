import "snippet_proof.spec";

methods {
    function _.verifyDepositMessage(IStakingVault.Deposit calldata, BLS12_381.DepositY calldata, bytes32) internal => NONDET;

    // dispatch local variables to StakingVault
    function _.withdrawalCredentials() external => DISPATCHER(true);
    function _.owner() external => DISPATCHER(true);
    function _.nodeOperator() external => DISPATCHER(true);
    function _.depositToBeaconChain(IStakingVault.Deposit) external => DISPATCHER(true);
}
