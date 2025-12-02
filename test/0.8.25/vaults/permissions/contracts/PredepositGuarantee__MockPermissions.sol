// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

contract PredepositGuarantee__MockPermissions {
    event Mock__CompensateDisprovenPredeposit(bytes pubkey, address recipient);

    function compensateDisprovenPredeposit(bytes calldata _pubkey, address _recipient) external returns (uint256) {
        emit Mock__CompensateDisprovenPredeposit(_pubkey, _recipient);
        return 1 ether;
    }
}
