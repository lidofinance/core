/* Spec for the `PredepositGuarantee` contract */

using PredepositGuarantee as _PredepositGuarantee;

methods {
    // `PredepositGuarantee`
    function PredepositGuarantee.validatorStatus(
        bytes
    ) external returns (IPredepositGuarantee.ValidatorStatus) envfree;
    // The following pure function causes sanity problems, therefore summarized
    function PredepositGuarantee._depositDataRootWithZeroSig(
        bytes calldata,
        uint256,
        bytes32
    ) internal returns (bytes32) => NONDET;
    

    // `StakingVault`
    // Without the following summary, the call from `VaultHub`:Line 1071,
    // `_predepositGuarantee().proveUnknownValidator(_witness, IStakingVault(_vault))`,
    // becomes unresolved ("callee contract unresolved").
    function _.withdraw(address, uint256) external => DISPATCHER(true);

    function _.beaconChainDepositsPaused() external => DISPATCHER(true);
    function _.resumeBeaconChainDeposits() external => DISPATCHER(true);
    function _.pauseBeaconChainDeposits() external => DISPATCHER(true);
    function _.transferOwnership(address) external => DISPATCHER(true);
    function _.pendingOwner() external => DISPATCHER(true);
    function _.depositor() external => DISPATCHER(true);
    function _.owner() external => DISPATCHER(true);
    function _.nodeOperator() external => DISPATCHER(true);
    function _.acceptOwnership() external => DISPATCHER(true);
    function _.fund() external => DISPATCHER(true);
    function _.requestValidatorExit(bytes) external => DISPATCHER(true);
    function _.triggerValidatorWithdrawals(bytes, uint64[], address) external => DISPATCHER(true);
    function _.stage(uint256) external => DISPATCHER(true);

    // The function `depositToBeaconChain` deposits to various contracts. To simplify things
    // we summarized it as `NONDET`, although this is not strictly speaking sound.
    function _.depositToBeaconChain(IStakingVault.Deposit _deposit) external => NONDET;

    // `BLS` Library
    // Summarizing the `BLS` library since the Prover cannot easily handle such
    // calculations and it contains many unsafe memory operations that hurt static
    // analysis.
    // TODO: Can we do better than `NONDET`? Can we revert (e.g. in `verifyDepositMessage`)?
    function BLS12_381.verifyDepositMessage(
        bytes calldata,
        bytes calldata,
        uint256,
        BLS12_381.DepositY calldata,
        bytes32,
        bytes32
    ) internal => NONDET;
    function BLS12_381.sha256Pair(bytes32, bytes32) internal returns (bytes32) => NONDET;
    function BLS12_381.pubkeyRoot(bytes calldata) internal returns (bytes32) => NONDET;

    // `SSZ` Library
    // TODO: Can we do better than `NONDET`?
    function SSZ.hashTreeRoot(SSZ.BeaconBlockHeader memory) internal returns (bytes32) => NONDET;
    function SSZ.hashTreeRoot(SSZ.Validator memory) internal returns (bytes32) => NONDET;
    function SSZ.verifyProof(bytes32[] calldata, bytes32, bytes32, SSZ.GIndex) internal => NONDET;
    
    // `CLProofVerifier`
    // TODO: Can we do better than `NONDET`?
    function CLProofVerifier._validatePubKeyWCProof(
        IPredepositGuarantee.ValidatorWitness calldata,
        bytes32
    ) internal => NONDET;
}


/// @title Valid transitions for validator status
rule validatorStatusTransitions(method f, bytes validatorKey) filtered {
    f -> !f.isView
} {
    IPredepositGuarantee.ValidatorStatus statusPre = _PredepositGuarantee.validatorStatus(
        validatorKey
    );

    env e;
    calldataarg args;
    f(e, args);

    IPredepositGuarantee.ValidatorStatus statusPost = _PredepositGuarantee.validatorStatus(
        validatorKey
    );

    assert(
        statusPre.stage == IPredepositGuarantee.ValidatorStage.NONE => (
            statusPost.stage == IPredepositGuarantee.ValidatorStage.NONE ||
            statusPost.stage == IPredepositGuarantee.ValidatorStage.PREDEPOSITED ||
            (
                statusPost.stage == IPredepositGuarantee.ValidatorStage.ACTIVATED &&
                f.selector == sig:PredepositGuarantee.proveUnknownValidator(
                    IPredepositGuarantee.ValidatorWitness, address
                ).selector
            )
        ),
        "Transitions from NONE stage"
    );
    assert(
        statusPre.stage == IPredepositGuarantee.ValidatorStage.PREDEPOSITED => (
            statusPost.stage == IPredepositGuarantee.ValidatorStage.PREDEPOSITED ||
            statusPost.stage == IPredepositGuarantee.ValidatorStage.PROVEN ||
            statusPost.stage == IPredepositGuarantee.ValidatorStage.ACTIVATED ||
            statusPost.stage == IPredepositGuarantee.ValidatorStage.COMPENSATED
        ),
        "Transitions from PREDEPOSITED stage"
    );
    assert(
        statusPre.stage == IPredepositGuarantee.ValidatorStage.PROVEN => (
            statusPost.stage == IPredepositGuarantee.ValidatorStage.PROVEN ||
            statusPost.stage == IPredepositGuarantee.ValidatorStage.ACTIVATED
        ),
        "Transitions from PROVEN stage"
    );
    assert(
        statusPre.stage == IPredepositGuarantee.ValidatorStage.ACTIVATED => (
            statusPost.stage == IPredepositGuarantee.ValidatorStage.ACTIVATED
        ),
        "ACTIVATED is a terminal status"
    );
    assert(
        statusPre.stage == IPredepositGuarantee.ValidatorStage.COMPENSATED => (
            statusPost.stage == IPredepositGuarantee.ValidatorStage.COMPENSATED
        ),
        "COMPENSATED is a terminal status"
    );
}
