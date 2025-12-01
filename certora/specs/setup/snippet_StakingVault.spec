methods {
    // dispatch local variables to StakingVault
    function _.DEPOSIT_CONTRACT() external => DISPATCHER(true);
    function _.initialize(address,address,address) external => DISPATCHER(true);
    function _.withdrawalCredentials() external => DISPATCHER(true);
    function _.owner() external => DISPATCHER(true);
    function _.pendingOwner() external => DISPATCHER(true);
    function _.acceptOwnership() external => DISPATCHER(true);
    function _.transferOwnership(address) external => DISPATCHER(true);
    function _.nodeOperator() external => DISPATCHER(true);
    function _.depositor() external => DISPATCHER(true);
    function _.fund() external => DISPATCHER(true);
    function _.withdraw(address,uint256) external => DISPATCHER(true);
    function _.beaconChainDepositsPaused() external => DISPATCHER(true);
    function _.pauseBeaconChainDeposits() external => DISPATCHER(true);
    function _.resumeBeaconChainDeposits() external => DISPATCHER(true);
    function _.triggerValidatorWithdrawals(bytes,uint64[],address) external => DISPATCHER(true);
    // merely emits an event, no need to dispatch
    function _.requestValidatorExit(bytes) external => NONDET;
}
