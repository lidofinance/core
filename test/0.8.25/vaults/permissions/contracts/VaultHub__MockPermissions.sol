// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";

contract VaultHub__MockPermissions {
    event Mock__SharesMinted(address indexed _stakingVault, address indexed _recipient, uint256 _shares);
    event Mock__SharesBurned(address indexed _stakingVault, uint256 _shares);
    event Mock__Rebalanced(address indexed _vault, uint256 _ether);
    event Mock__VoluntaryDisconnect(address indexed _stakingVault);
    event Mock__LidoVaultHubAuthorized();
    event Mock__Funded(address indexed _vault, uint256 _amount);
    event Mock__Withdrawn(address indexed _vault, address indexed _recipient, uint256 _amount);
    event Mock__BeaconChainDepositsPaused(address indexed _vault);
    event Mock__BeaconChainDepositsResumed(address indexed _vault);
    event Mock__ValidatorExitRequested(address indexed _vault, bytes _pubkeys);
    event Mock__ValidatorWithdrawalsTriggered(
        address indexed _vault,
        bytes _pubkeys,
        uint64[] _amounts,
        address _refundRecipient
    );
    event Mock__CompensateDisprovenPredepositFromPDG(address indexed _vault, bytes _pubkey, address _recipient);
    event Mock__ProveUnknownValidatorToPDG(address indexed _vault, IPredepositGuarantee.ValidatorWitness _witness);
    event Mock__WithdrawForUnguaranteedDepositToBeaconChain(address indexed _vault, uint256 _ether);
    event Mock__TransferVaultOwnership(address indexed _vault, address _newOwner);

    address public immutable LIDO_LOCATOR;

    constructor(address _lidoLocator) {
        LIDO_LOCATOR = _lidoLocator;
    }

    function mintShares(address _stakingVault, address _recipient, uint256 _shares) external {
        emit Mock__SharesMinted(_stakingVault, _recipient, _shares);
    }

    function burnShares(address _stakingVault, uint256 _shares) external {
        emit Mock__SharesBurned(_stakingVault, _shares);
    }

    function rebalance(address _vault, uint256 _ether) external payable {
        emit Mock__Rebalanced(_vault, _ether);
    }

    function voluntaryDisconnect(address _stakingVault) external {
        emit Mock__VoluntaryDisconnect(_stakingVault);
    }

    function fund(address _vault) external payable {
        emit Mock__Funded(_vault, msg.value);
    }

    function withdraw(address _vault, address _recipient, uint256 _amount) external {
        emit Mock__Withdrawn(_vault, _recipient, _amount);
    }

    function pauseBeaconChainDeposits(address _vault) external {
        emit Mock__BeaconChainDepositsPaused(_vault);
    }

    function resumeBeaconChainDeposits(address _vault) external {
        emit Mock__BeaconChainDepositsResumed(_vault);
    }

    function requestValidatorExit(address _vault, bytes calldata _pubkeys) external {
        emit Mock__ValidatorExitRequested(_vault, _pubkeys);
    }

    function triggerValidatorWithdrawals(
        address _vault,
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        emit Mock__ValidatorWithdrawalsTriggered(_vault, _pubkeys, _amounts, _refundRecipient);
    }

    function compensateDisprovenPredepositFromPDG(
        address _vault,
        bytes calldata _pubkey,
        address _recipient
    ) external returns (uint256) {
        emit Mock__CompensateDisprovenPredepositFromPDG(_vault, _pubkey, _recipient);
        return 0;
    }

    function proveUnknownValidatorToPDG(
        address _vault,
        IPredepositGuarantee.ValidatorWitness calldata _witness
    ) external {
        emit Mock__ProveUnknownValidatorToPDG(_vault, _witness);
    }

    function transferVaultOwnership(address _vault, address _newOwner) external {
        emit Mock__TransferVaultOwnership(_vault, _newOwner);
    }
}
