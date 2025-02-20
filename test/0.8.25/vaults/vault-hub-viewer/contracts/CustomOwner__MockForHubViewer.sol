// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

//
// This mock represents custom Vault owner contract, that does not have ACL e.g. Safe
//
contract CustomOwner__MockForHubViewer {
    bool public shouldRevertFallback;

    constructor() {
        shouldRevertFallback = true;
    }

    function setShouldRevertFallback(bool _shouldRevertFallback) external {
        shouldRevertFallback = _shouldRevertFallback;
    }

    fallback() external {
        if (shouldRevertFallback) revert("fallback");
    }

    receive() external payable {
        if (shouldRevertFallback) {
            revert("fallback");
        }
    }
}
