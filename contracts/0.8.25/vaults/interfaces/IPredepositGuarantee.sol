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
     * @notice represents validator stages in PDG flow
     * @param NONE - initial stage
     * @param PREDEPOSITED - PREDEPOSIT_AMOUNT is deposited to this validator by the vault
     * @param PROVEN - validator is proven to be valid and can be used to deposit to beacon chain
     * @param ACTIVATED - validator is proven and the ACTIVATION_DEPOSIT_AMOUNT is deposited to this validator
     * @param COMPENSATED - disproven validator has its PREDEPOSIT_AMOUNT ether compensated to staking vault owner and validator cannot be used in PDG anymore
     */
    enum ValidatorStage {
        NONE,
        PREDEPOSITED,
        PROVEN,
        ACTIVATED,
        COMPENSATED
    }
    /**
     * @notice represents status of the validator in PDG
     * @param stage represents validator stage in PDG flow
     * @param stakingVault pins validator to specific StakingVault
     * @param nodeOperator pins validator to specific NO
     */
    struct ValidatorStatus {
        ValidatorStage stage;
        IStakingVault stakingVault;
        address nodeOperator;
    }

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

    function pendingActivations(IStakingVault _vault) external view returns (uint256);
    function validatorStatus(bytes calldata _pubkey) external view returns (ValidatorStatus memory);
    function proveUnknownValidator(ValidatorWitness calldata _witness, IStakingVault _stakingVault) external;
}
