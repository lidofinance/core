// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

contract IStETH {
    function mintExternalShares(address _receiver, uint256 _amountOfShares) external {}

    function burnExternalShares(uint256 _amountOfShares) external {}

    function getSharesByPooledEthRoundedUp(uint256 _amountOfEther) external view returns (uint256) {}
}

contract VaultHub__MockForDashboard {
    uint256 internal constant BPS_BASE = 100_00;
    IStETH public immutable steth;
    address public immutable LIDO_LOCATOR;
    uint256 public constant CONNECT_DEPOSIT = 1 ether;
    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;
    uint64 public latestReportDataTimestamp;

    constructor(IStETH _steth, address _lidoLocator) {
        steth = _steth;
        LIDO_LOCATOR = _lidoLocator;
    }

    mapping(address => VaultHub.VaultConnection) public vaultConnections;
    mapping(address => VaultHub.VaultRecord) public vaultRecords;

    function mock__setVaultConnection(address vault, VaultHub.VaultConnection memory connection) external {
        vaultConnections[vault] = connection;
    }

    function vaultConnection(address vault) external view returns (VaultHub.VaultConnection memory) {
        return vaultConnections[vault];
    }

    function mock__setVaultRecord(address vault, VaultHub.VaultRecord memory record) external {
        vaultRecords[vault] = record;
    }

    function vaultRecord(address vault) external view returns (VaultHub.VaultRecord memory) {
        return vaultRecords[vault];
    }

    function totalValue(address vault) external view returns (uint256) {
        return vaultRecords[vault].report.totalValue;
    }

    function locked(address vault) external view returns (uint256) {
        return vaultRecords[vault].locked;
    }

    function liabilityShares(address _vault) external view returns (uint256) {
        return vaultRecords[_vault].liabilityShares;
    }

    function latestReport(address _vault) external view returns (VaultHub.Report memory) {
        return vaultRecords[_vault].report;
    }

    function maxLockableValue(address _vault) external view returns (uint256) {
        return vaultRecords[_vault].report.totalValue;
    }

    function withdrawableValue(address _vault) external view returns (uint256) {
        return Math256.min(vaultRecords[_vault].report.totalValue - vaultRecords[_vault].locked, _vault.balance);
    }

    function disconnect(address vault) external {
        emit Mock__VaultDisconnectInitiated(vault);
    }

    function deleteVaultConnection(address vault) external {
        delete vaultConnections[vault];
        delete vaultRecords[vault];
    }

    function connectVault(address vault) external {
        vaultConnections[vault] = VaultHub.VaultConnection({
            owner: IStakingVault(vault).owner(),
            shareLimit: 1,
            vaultIndex: 2,
            pendingDisconnect: false,
            reserveRatioBP: 500,
            forcedRebalanceThresholdBP: 100,
            infraFeeBP: 100,
            liquidityFeeBP: 100,
            reservationFeeBP: 100,
            isBeaconDepositsManuallyPaused: false
        });

        emit Mock__VaultConnected(vault);
    }

    function mintShares(address vault, address recipient, uint256 amount) external {
        if (vault == address(0)) revert ZeroArgument("_vault");
        if (recipient == address(0)) revert ZeroArgument("recipient");
        if (amount == 0) revert ZeroArgument("amount");

        steth.mintExternalShares(recipient, amount);
        emit Mock__MintedShares(vault, recipient, amount);
    }

    function burnShares(address _vault, uint256 _amountOfShares) external {
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");

        steth.burnExternalShares(_amountOfShares);
        emit Mock__BurnedShares(_vault, _amountOfShares);
    }

    function voluntaryDisconnect(address _vault) external {
        emit Mock__VaultDisconnectInitiated(_vault);
    }

    function rebalance(address _vault, uint256 _amountOfEther) external payable {
        emit Mock__Rebalanced(_vault, _amountOfEther);
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

    function pauseBeaconChainDeposits(address _vault) external {
        emit Mock__BeaconChainDepositsPaused(_vault);
    }

    function resumeBeaconChainDeposits(address _vault) external {
        emit Mock__BeaconChainDepositsResumed(_vault);
    }

    function fund(address _vault) external payable {
        emit Mock__Funded(_vault, msg.value);
    }

    function withdraw(address _vault, address _recipient, uint256 _amount) external {
        emit Mock__Withdrawn(_vault, _recipient, _amount);
    }

    function compensateDisprovenPredepositFromPDG(
        address _vault,
        bytes calldata _validatorPubkey,
        address _recipient
    ) external returns (uint256) {
        emit Mock__CompensatedDisprovenPredepositFromPDG(_vault, _validatorPubkey, _recipient);
        return 1 ether;
    }

    function proveUnknownValidatorToPDG(
        address _vault,
        IPredepositGuarantee.ValidatorWitness calldata _witness
    ) external {
        emit Mock__ValidatorProvedToPDG(_vault, _witness);
    }

    function transferVaultOwnership(address _vault, address _newOwner) external {
        emit Mock__VaultOwnershipTransferred(_vault, _newOwner);
    }

    function isVaultConnected(address _vault) public view returns (bool) {
        return vaultConnections[_vault].vaultIndex != 0;
    }

    function updateConnection(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) external {
        if (!isVaultConnected(_vault)) revert NotConnectedToHub(_vault);
        emit Mock__VaultConnectionUpdated(
            _vault,
            _shareLimit,
            _reserveRatioBP,
            _forcedRebalanceThresholdBP,
            _infraFeeBP,
            _liquidityFeeBP,
            _reservationFeeBP
        );
    }

    event Mock__ValidatorExitRequested(address vault, bytes pubkeys);
    event Mock__ValidatorWithdrawalsTriggered(address vault, bytes pubkeys, uint64[] amounts, address refundRecipient);
    event Mock__BeaconChainDepositsPaused(address vault);
    event Mock__BeaconChainDepositsResumed(address vault);
    event Mock__Funded(address vault, uint256 amount);
    event Mock__CompensatedDisprovenPredepositFromPDG(address vault, bytes validatorPubkey, address recipient);
    event Mock__ValidatorProvedToPDG(address vault, IPredepositGuarantee.ValidatorWitness witness);
    event Mock__VaultOwnershipTransferred(address vault, address newOwner);
    event Mock__Withdrawn(address vault, address recipient, uint256 amount);
    event Mock__MintedShares(address vault, address recipient, uint256 amount);
    event Mock__BurnedShares(address vault, uint256 amount);
    event Mock__VaultDisconnectInitiated(address vault);
    event Mock__Rebalanced(address vault, uint256 amount);
    event Mock__VaultConnected(address vault);
    event Mock__VaultConnectionUpdated(
        address vault,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );

    error ZeroArgument(string argument);
    error NotConnectedToHub(address vault);
}
