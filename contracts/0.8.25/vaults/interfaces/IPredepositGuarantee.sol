// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVaultOwnable} from "./IStakingVault.sol";

/**
 * @title ICLProofVerifier
 * @author Lido
 * @notice Interface for the internal `CLProofVerifier` contract
 */
interface ICLProofVerifier {
    struct ValidatorWitness {
        bytes32[] proof;
        bytes pubkey;
        uint256 validatorIndex;
        uint64 childBlockTimestamp;
    }
}

/**
 * @title IPredepositGuarantee
 * @author Lido
 * @notice Interface for the `PredepositGuarantee` contract
 */
interface IPredepositGuarantee is ICLProofVerifier {
    enum BondStatus {
        NONE,
        AWAITING_PROOF,
        PROVED,
        PROVED_INVALID
    }

    struct NodeOperatorBond {
        uint128 total;
        uint128 locked;
    }

    struct ValidatorStatus {
        BondStatus bondStatus;
        IStakingVaultOwnable stakingVault;
        address nodeOperator;
    }

    // constructor and initializer interfaces not needed in interface definition

    function nodeOperatorBond(address _nodeOperator) external view returns (NodeOperatorBond memory);

    function nodeOperatorVoucher(address _nodeOperator) external view returns (address);

    function validatorStatus(bytes calldata _validatorPubkey) external view returns (ValidatorStatus memory);

    function topUpNodeOperatorBond(address _nodeOperator) external payable;

    function withdrawNodeOperatorBond(address _nodeOperator, uint128 _amount, address _recipient) external;

    function setNodeOperatorVoucher(address _voucher) external payable;

    function predeposit(
        IStakingVaultOwnable _stakingVault,
        IStakingVaultOwnable.Deposit[] calldata _deposits
    ) external payable;

    function proveValidatorWC(ValidatorWitness calldata _witness) external;

    function depositToBeaconChain(
        IStakingVaultOwnable _stakingVault,
        IStakingVaultOwnable.Deposit[] calldata _deposits
    ) external payable;

    function proveAndDeposit(
        ValidatorWitness[] calldata _witnesses,
        IStakingVaultOwnable.Deposit[] calldata _deposits,
        IStakingVaultOwnable _stakingVault
    ) external payable;

    function proveInvalidValidatorWC(
        ValidatorWitness calldata _witness,
        bytes32 _invalidWithdrawalCredentials
    ) external;

    function withdrawDisprovenPredeposit(
        bytes calldata _validatorPubkey,
        address _recipient
    ) external returns (uint128 amount);

    function disproveAndWithdraw(
        ValidatorWitness calldata _witness,
        bytes32 _invalidWithdrawalCredentials,
        address _recipient
    ) external returns (uint128 amount);
}
