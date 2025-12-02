// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract PredepositGuarantee__MockForLazyOracle is IPredepositGuarantee {
    function pendingActivations(IStakingVault _vault) external view override returns (uint256) {}

    function proveUnknownValidator(ValidatorWitness calldata _witness, IStakingVault _stakingVault) external override {}

    function validatorStatus(bytes calldata _pubkey) external view override returns (ValidatorStatus memory) {}
}
