// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {BeaconValidatorController} from "contracts/0.8.25/vaults/BeaconValidatorController.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract BeaconValidatorController__Harness is BeaconValidatorController {
    constructor(address _beaconChainDepositContract) BeaconValidatorController(_beaconChainDepositContract) {}

    function harness__depositContract() external view returns (address) {
        return _depositContract();
    }

    function harness__withdrawalCredentials() external view returns (bytes32) {
        return _withdrawalCredentials();
    }

    function harness__deposit(IStakingVault.Deposit[] calldata _deposits) external {
        _deposit(_deposits);
    }

    function harness__calculateWithdrawalFee(uint256 _amount) external view returns (uint256) {
        return _calculateWithdrawalFee(_amount);
    }

    function harness__requestExit(bytes calldata _pubkeys) external {
        _requestExit(_pubkeys);
    }

    function harness__initiateFullWithdrawal(bytes calldata _pubkeys) external payable {
        _initiateFullWithdrawal(_pubkeys);
    }

    function harness__initiatePartialWithdrawal(bytes calldata _pubkeys, uint64[] calldata _amounts) external payable {
        _initiatePartialWithdrawal(_pubkeys, _amounts);
    }

    function harness__computeDepositDataRoot(
        bytes calldata _pubkey,
        bytes calldata _withdrawalCredentials,
        bytes calldata _signature,
        uint256 _amount
    ) external pure returns (bytes32) {
        return _computeDepositDataRoot(_pubkey, _withdrawalCredentials, _signature, _amount);
    }
}
