// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.0;

import {IStakingVault} from "./IStakingVault.sol";

/**
 * @title IPredepositGuarantee
 * @author Lido
 * @notice Interface for the `PredepositGuarantee` contract
 */
interface IPredepositGuarantee {
    /**
     * @notice user input for validator proof verification
     * @custom:proof array of merkle proofs from parent(pubkey,wc) node to Beacon block root
     * @custom:pubkey of validator to prove
     * @custom:validatorIndex of validator in CL state tree
     * @custom:childBlockTimestamp of EL block that has parent block beacon root in BEACON_ROOTS contract
     * @custom:slot of the beacon block for which the proof is generated
     * @custom:proposerIndex of the beacon block for which the proof is generated
     */
    struct ValidatorWitness {
        bytes32[] proof;
        bytes pubkey;
        uint256 validatorIndex;
        uint64 childBlockTimestamp;
        uint64 slot;
        uint64 proposerIndex;
    }

    function compensateDisprovenPredeposit(
        bytes calldata _validatorPubkey,
        address _recipient
    ) external returns (uint256 compensatedEther);

    function proveUnknownValidator(ValidatorWitness calldata _witness, IStakingVault _stakingVault) external;
}
