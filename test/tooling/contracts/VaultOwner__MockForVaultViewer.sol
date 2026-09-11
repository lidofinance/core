// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

/// @dev vault owner contract without ACL: every call hits the fallback and returns `response` (empty by default)
contract VaultOwner__MockForVaultViewer {
    bytes public response;

    function mock__setResponse(bytes calldata _response) external {
        response = _response;
    }

    fallback() external {
        bytes memory r = response;
        assembly {
            return(add(r, 32), mload(r))
        }
    }
}
