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

    /**
     * @notice represents validator stages in PDG flow
     * @param NONE - initial stage
     * @param PREDEPOSITED - PREDEPOSIT_AMOUNT is deposited with this validator by the vault
     * @param PROVEN - validator is proven to be valid and can be used to deposit to beacon chain
     * @param DISPROVEN - validator is proven to have wrong WC and its PREDEPOSIT_AMOUNT can be compensated to staking vault owner
     * @param COMPENSATED - disproven validator has its PREDEPOSIT_AMOUNT ether compensated to staking vault owner and validator cannot be used in PDG anymore
     */
    enum ValidatorStage {
        NONE,
        PREDEPOSITED,
        PROVEN,
        DISPROVEN,
        COMPENSATED
    }

    /**
     * @notice represents NO balance in PDG
     * @dev fits into single 32 bytes slot
     * @param total total ether balance of the NO
     * @param locked ether locked in not yet proven predeposits
     */
    struct NodeOperatorBalance {
        uint128 total;
        uint128 locked;
    }

    /**
     * @notice represents status of the validator in PDG
     * @dev is used to track validator from predeposit -> prove -> deposit
     * @param stage represents validator stage in PDG flow
     * @param stakingVault pins validator to specific StakingVault
     * @param nodeOperator pins validator to specific NO
     */
    struct ValidatorStatus {
        ValidatorStage stage;
        IStakingVault stakingVault;
        address nodeOperator;
    }

    function validatorStatus(bytes calldata _validatorPubkey) external view returns (ValidatorStatus memory);

    function compensateDisprovenPredeposit(bytes calldata _validatorPubkey) external returns (uint256 compensatedEther);

    function proveUnknownValidator(ValidatorWitness calldata _witness, IStakingVault _stakingVault) external;
}
