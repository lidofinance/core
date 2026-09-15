// summarizes call to CLProofVerifier
// The Prover is unable to find `CLProofVerifier` for some reason (it did work in
// previous versions of the code), so we switched to using a wildcard.
methods {
    function _._validatePubKeyWCProof(IPredepositGuarantee.ValidatorWitness calldata, bytes32) internal => NONDET;
}
