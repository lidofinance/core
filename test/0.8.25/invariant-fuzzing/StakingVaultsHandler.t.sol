// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.25;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";

import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {LazyOracleMock, LidoLocatorMock, ConsensusContractMock} from "./CommonMocks.sol";

import {Constants} from "./StakingVaultConstants.sol";
import "forge-std/console2.sol";

/**
TODO:
    - function triggerValidatorWithdrawals()
    - PDG funcs
    - proveUnknownValidatorToPDG
    - compensateDisprovenPredepositFromPDG
**/

contract StakingVaultsHandler is CommonBase, StdCheats, StdUtils {
    // Protocol contracts
    ILido public lidoContract;
    LidoLocatorMock public lidoLocator;
    VaultHub public vaultHub;
    address public dashboard;
    StakingVault public stakingVault;
    LazyOracleMock public lazyOracle;
    ConsensusContractMock public consensusContract;
    VaultReport public lastReport;

    struct VaultReport {
        uint256 totalValue;
        uint256 cumulativeLidoFees;
        uint256 liabilityShares;
        uint64 reportTimestamp;
    }

    // Account addresses
    address public userAccount;
    address public rootAccount;

    uint256 public cl_balance = 0; //aka deposited on beacon chain

    uint256 constant MIN_SHARES = 1;
    uint256 constant MAX_SHARES = 100;

    uint256 public otcDeposited = 0;

    enum VaultAction {
        CONNECT,
        VOLUNTARY_DISCONNECT,
        UPDATE_VAULT_DATA,
        OTC_DEPOSIT,
        FUND,
        VH_WITHDRAW,
        SV_WITHDRAW
    }
    VaultAction[] public actionPath;
    uint256 public actionIndex = 0;

    constructor(address _lidoLocator, address _stakingVault, address _rootAccount, address _userAccount) {
        lidoLocator = LidoLocatorMock(_lidoLocator);
        lidoContract = ILido(lidoLocator.lido());
        vaultHub = VaultHub(payable(lidoLocator.vaultHub()));
        stakingVault = StakingVault(payable(_stakingVault));
        lazyOracle = LazyOracleMock(lidoLocator.lazyOracle());
        consensusContract = ConsensusContractMock(lidoLocator.consensusContract());
        rootAccount = _rootAccount;
        userAccount = _userAccount;
        actionPath = [
            VaultAction.CONNECT, //connect
            VaultAction.OTC_DEPOSIT, //otc funds
            VaultAction.UPDATE_VAULT_DATA, //trigger quarantine
            VaultAction.VOLUNTARY_DISCONNECT, //pendingDisconnect
            VaultAction.UPDATE_VAULT_DATA, //disconnected
            //quarantine expires (3days)
            VaultAction.CONNECT, //reconnect with same TV + wait for fresh report
            VaultAction.VOLUNTARY_DISCONNECT, //pendingDisconnect
            VaultAction.UPDATE_VAULT_DATA, //disconnected (2nd time) (Report2)
            VaultAction.SV_WITHDRAW, //withdraw from vault
            VaultAction.CONNECT, //reconnect with CONNECT_DEPOSIT
            VaultAction.UPDATE_VAULT_DATA // apply report2 -> QUARANTINE tirggered, and lower than the expired one -> expired quarantine considered as accounted
        ];
    }

    modifier actionIndexUpdate(VaultAction action) {
        if (actionPath[actionIndex] == action) {
            actionIndex++;
        } else {
            revert("not the good sequence");
        }
        _;
    }

    ////////// VAULTHUB INTERACTIONS //////////
    function connectVault() public actionIndexUpdate(VaultAction.CONNECT) {
        //check if the vault is already connected
        VaultHub.VaultConnection memory vc = vaultHub.vaultConnection(address(stakingVault));

        //do nothing if already connected
        if (vc.vaultIndex != 0) return;

        if (address(stakingVault).balance < Constants.CONNECT_DEPOSIT) {
            deal(address(userAccount), Constants.CONNECT_DEPOSIT);
            vm.prank(userAccount);
            stakingVault.fund{value: Constants.CONNECT_DEPOSIT}();
        }

        vm.prank(userAccount);
        stakingVault.transferOwnership(address(vaultHub));
        vm.prank(userAccount);
        vaultHub.connectVault(address(stakingVault));
    }

    function voluntaryDisconnect() public actionIndexUpdate(VaultAction.VOLUNTARY_DISCONNECT) {
        VaultHub.VaultConnection memory vc = vaultHub.vaultConnection(address(stakingVault));

        //do nothing if disconnected or already disconnecting
        if (vc.vaultIndex == 0 || vc.pendingDisconnect == true) return;

        //decrease liabilities
        uint256 shares = vaultHub.liabilityShares(address(stakingVault));
        if (shares != 0) {
            vaultHub.burnShares(address(stakingVault), shares);
        }

        vm.prank(userAccount);
        vaultHub.voluntaryDisconnect(address(stakingVault));
    }

    function fund(uint256 amount) public actionIndexUpdate(VaultAction.FUND) {
        amount = bound(amount, 1, 1 ether);
        deal(address(userAccount), amount);
        vm.prank(userAccount);
        vaultHub.fund{value: amount}(address(stakingVault));
    }

    function VHwithdraw(uint256 amount) public actionIndexUpdate(VaultAction.VH_WITHDRAW) {
        amount = bound(amount, 0, vaultHub.withdrawableValue(address(stakingVault)));

        if (amount == 0) {
            return;
        }
        vm.prank(userAccount);
        vaultHub.withdraw(address(stakingVault), userAccount, amount);
    }

    function rebalance(uint256 amount) public {
        amount = bound(amount, 1, address(stakingVault).balance);
        vm.prank(userAccount);
        vaultHub.rebalance(address(stakingVault), amount);
    }

    function mintShares(uint256 shares) public {
        shares = bound(shares, MIN_SHARES, MAX_SHARES);
        vm.prank(userAccount);
        vaultHub.mintShares(address(stakingVault), userAccount, shares);
    }

    function burnShares(uint256 shares) public {
        shares = bound(shares, MIN_SHARES, MAX_SHARES);
        uint256 currShares = vaultHub.liabilityShares(address(stakingVault));
        uint256 sharesToBurn = Math256.min(currShares, shares);
        if (sharesToBurn == 0) {
            return; // nothing to burn
        }
        vm.prank(userAccount);
        vaultHub.burnShares(address(stakingVault), sharesToBurn);
    }

    function transferAndBurnShares(uint256 shares) public {
        shares = bound(shares, MIN_SHARES, MAX_SHARES);
        uint256 currShares = vaultHub.liabilityShares(address(stakingVault));
        uint256 sharesToBurn = Math256.min(currShares, shares);
        if (sharesToBurn == 0) {
            return; // nothing to burn
        }
        vm.prank(userAccount);
        vaultHub.transferAndBurnShares(address(stakingVault), shares);
    }

    function pauseBeaconChainDeposits() public {
        vaultHub.pauseBeaconChainDeposits(address(stakingVault));
    }

    function resumeBeaconChainDeposits() public {
        vaultHub.resumeBeaconChainDeposits(address(stakingVault));
    }

    function getEffectiveVaultTotalValue() public returns (uint256) {
        return address(stakingVault).balance + cl_balance;
    }

    function getVaultTotalValue() public returns (uint256) {
        //gets reported TV + current ioDelta - reported ioDelta
        return vaultHub.totalValue(address(stakingVault));
    }

    function otcDeposit(uint256 amount) public actionIndexUpdate(VaultAction.OTC_DEPOSIT) {
        amount = bound(amount, 1 ether, 10 ether);
        otcDeposited += amount;
        deal(address(address(stakingVault)), amount);
    }

    ////////// LazyOracle INTERACTIONS //////////

    function updateVaultData(uint256 daysShift) public actionIndexUpdate(VaultAction.UPDATE_VAULT_DATA) {
        daysShift = bound(daysShift, 0, 1);
        daysShift *= 3; //0 or 3 days for quarantine period expiration
        console2.log("DaysShift = %d", daysShift);

        if (daysShift > 0) {
            vm.warp(block.timestamp + daysShift * 1 days);
            lazyOracle.setVaultDataTimestamp(uint64(block.timestamp));
            VaultHub.VaultObligations memory obligations = vaultHub.vaultObligations(address(stakingVault));

            lastReport = VaultReport({
                totalValue: vaultHub.totalValue(address(stakingVault)) + otcDeposited,
                cumulativeLidoFees: obligations.settledLidoFees + obligations.unsettledLidoFees + 1,
                liabilityShares: vaultHub.liabilityShares(address(stakingVault)),
                reportTimestamp: uint64(block.timestamp)
            });

            //reset otc deposit value
            otcDeposited = 0;
        }

        //path to trigger to get quarantine back in TV
        //reportTs - q.startTimestamp < $.quarantinePeriod

        //simulate next ref slot
        (uint256 refSlot, ) = consensusContract.getCurrentFrame();
        if (daysShift > 0) {
            refSlot += daysShift;
            consensusContract.setCurrentFrame(refSlot);
        }

        //update the vault data
        lazyOracle.updateVaultData(
            address(stakingVault),
            lastReport.totalValue,
            lastReport.cumulativeLidoFees,
            lastReport.liabilityShares,
            uint64(block.timestamp)
        );

        //Handle if disconnect was successfull
        if (stakingVault.pendingOwner() == userAccount) {
            vm.prank(userAccount);
            stakingVault.acceptOwnership();
        }
    }

    ////////// STAKING VAULT INTERACTIONS //////////

    function SVwithdraw(uint256 amount) public actionIndexUpdate(VaultAction.SV_WITHDRAW) {
        if (stakingVault.owner() != userAccount) {
            return; //we are managed by the VaultHub
        }

        amount = bound(amount, 0, address(stakingVault).balance);
        if (amount == 0) {
            return; // nothing to withdraw
        }
        vm.prank(userAccount);
        stakingVault.withdraw(userAccount, amount);
    }
}
