// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract PredepositGuarantee__MockForDashboard {
    event Mock__CompensatedDisprovenPredeposit(bytes validatorPubkey, address recipient);

    function compensateDisprovenPredeposit(
        bytes calldata _validatorPubkey,
        address _recipient
    ) public returns (uint256) {
        emit Mock__CompensatedDisprovenPredeposit(_validatorPubkey, _recipient);
        return 1 ether;
    }
}
