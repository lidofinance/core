// SPDX-License-Identifier: UNLICENSED
// for tooling/testing purposes only
//
// ================================================================================================================= //
// DISCLAIMER: This contract is intended solely for tooling/testing and is NOT an official component of the Lido core protocol.
// It is excluded from the Lido bug bounty program.
// This contract has not undergone security auditing and its interface or functionality may change without notice.
// ================================================================================================================= //
//
// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {BLS12_381} from "contracts/common/lib/BLS.sol";

/// @dev Thin wrapper around `BLS12_381` to enable E2E testing vs CL reference implementations (e.g. blst).
contract BLSvsBLST__FuzzHarness {
    function computeDepositDomain(bytes4 genesisForkVersion) external view returns (bytes32) {
        return BLS12_381.computeDepositDomain(genesisForkVersion);
    }

    function depositMessageSigningRoot(
        bytes calldata pubkey,
        uint256 amount,
        bytes32 withdrawalCredentials,
        bytes32 depositDomain
    ) external view returns (bytes32) {
        return BLS12_381.depositMessageSigningRoot(pubkey, amount, withdrawalCredentials, depositDomain);
    }

    function verifyDepositMessage(
        bytes calldata pubkey,
        bytes calldata signature,
        uint256 amount,
        BLS12_381.DepositY calldata depositY,
        bytes32 withdrawalCredentials,
        bytes32 depositDomain
    ) external view {
        BLS12_381.verifyDepositMessage(pubkey, signature, amount, depositY, withdrawalCredentials, depositDomain);
    }
}
