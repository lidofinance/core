// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

/// @dev Dashboard-like vault owner: enumerable ACL plus node operator fee getters
contract VaultOwnerACL__MockForVaultViewer is AccessControlEnumerable {
    uint256 public feeRate;
    uint256 public accruedFee;

    constructor(address _admin, uint256 _feeRate, uint256 _accruedFee) {
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        feeRate = _feeRate;
        accruedFee = _accruedFee;
    }
}
