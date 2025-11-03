// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.25;

// External dependencies
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {Vm} from "forge-std/Vm.sol";

import {ILido} from "contracts/common/interfaces/ILido.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";

import {Constants} from "./StakingVaultConstants.sol";
import {LidoLocatorMock, ConsensusContractMock} from "./mocks/CommonMocks.sol";

/// @title StakingVaultsHandler
/// @notice Handler contract for invariant fuzzing of a single staking vault in the Lido protocol.
/// @dev Used by fuzzing contracts to simulate user and protocol actions, track state, and expose relevant variables for invariant checks.
/// The handler enables deep testing of vault logic, including deposits, withdrawals, connection/disconnection, ownership transfers, and time manipulation.
/// It is extensible and designed to help ensure critical invariants always hold, even under adversarial or randomized conditions.
contract StakingVaultsHandler is CommonBase, StdCheats, StdUtils, StdAssertions {
    // Protocol contracts
    ILido public lidoContract;
    LidoLocatorMock public lidoLocator;
    VaultHub public vaultHub;
    StakingVault public stakingVault;
    LazyOracle public lazyOracle;
    ConsensusContractMock public consensusContract;
    VaultReport public lastReport;
    address public accountingOracle;

    struct VaultReport {
        uint256 totalValue;
        uint256 cumulativeLidoFees;
        uint256 liabilityShares;
        uint64 reportTimestamp;
    }

    // Account addresses
    address public userAccount;
    address public rootAccount;

    uint256 public cl_balance = 0; // Amount deposited on beacon chain

    uint256 constant MIN_SHARES = 1;
    uint256 constant MAX_SHARES = 1000;

    uint256 public sv_otcDeposited = 0;
    uint256 public vh_otcDeposited = 0;

    bool public forceRebalanceReverted = false;
    bool public forceValidatorExitReverted = false;

    uint256 public appliedTotalValue = 0;
    uint256 public reportedTotalValue = 0;

    /// @notice Sequence of actions for guided fuzzing
    enum VaultAction {
        CONNECT,
        VOLUNTARY_DISCONNECT,
        UPDATE_VAULT_DATA,
        SV_OTC_DEPOSIT,
        VH_OTC_DEPOSIT,
        FUND,
        VH_WITHDRAW,
        SV_WITHDRAW
    }
    VaultAction[] public actionPath;
    uint256 public actionIndex = 0;

    constructor(address _lidoLocator, address _stakingVault, address _rootAccount, address _userAccount) {
        lidoLocator = LidoLocatorMock(_lidoLocator);
        accountingOracle = lidoLocator.accountingOracle();
        lidoContract = ILido(lidoLocator.lido());
        vaultHub = VaultHub(payable(lidoLocator.vaultHub()));
        stakingVault = StakingVault(payable(_stakingVault));
        lazyOracle = LazyOracle(lidoLocator.lazyOracle());
        consensusContract = ConsensusContractMock(lidoLocator.consensusContract());
        rootAccount = _rootAccount;
        userAccount = _userAccount;
        actionPath = [
            VaultAction.CONNECT, // connect
            VaultAction.SV_OTC_DEPOSIT, // OTC funds
            VaultAction.UPDATE_VAULT_DATA, // trigger quarantine
            VaultAction.VOLUNTARY_DISCONNECT, // pendingDisconnect
            VaultAction.UPDATE_VAULT_DATA, // disconnected
            VaultAction.CONNECT, // reconnect with same TV + wait for fresh report
            VaultAction.VOLUNTARY_DISCONNECT, // pendingDisconnect
            VaultAction.UPDATE_VAULT_DATA, // disconnected (2nd time)
            VaultAction.SV_WITHDRAW, // withdraw from vault
            VaultAction.CONNECT, // reconnect with CONNECT_DEPOSIT
            VaultAction.UPDATE_VAULT_DATA // apply report2 -> quarantine triggered, and lower than the expired one -> expired quarantine considered as accounted
        ];
    }

    /// @notice Modifier to update action index for guided fuzzing
    modifier actionIndexUpdate(VaultAction action) {
        if (actionPath[actionIndex] == action) {
            actionIndex++;
        } else {
            return; // not the correct sequence
        }
        _;
    }

    // --- Getters for invariant checks ---

    function getAppliedTotalValue() public view returns (uint256) {
        return appliedTotalValue;
    }

    function getReportedTotalValue() public view returns (uint256) {
        return reportedTotalValue;
    }

    function didForceRebalanceReverted() public view returns (bool) {
        return forceRebalanceReverted;
    }

    function didForceValidatorExitReverted() public view returns (bool) {
        return forceValidatorExitReverted;
    }

    // --- VaultHub interactions ---
    /// @notice Connects the vault to the VaultHub, funding if needed
    function connectVault() public {
        //check if the vault is already connected
        if (vaultHub.vaultConnection(address(stakingVault)).vaultIndex != 0) {
            return;
        }
        // TODO: PDG.pendingActivations
        if (stakingVault.availableBalance() < Constants.CONNECT_DEPOSIT) {
            deal(address(userAccount), Constants.CONNECT_DEPOSIT);
            vm.prank(userAccount);
            stakingVault.fund{value: Constants.CONNECT_DEPOSIT}();
        }
        vm.prank(userAccount);
        stakingVault.transferOwnership(address(vaultHub));
        vm.prank(userAccount);
        vaultHub.connectVault(address(stakingVault));
    }

    /// @notice Initiates voluntary disconnect for the vault
    function voluntaryDisconnect() public {
        //do nothing if disconnected or already disconnecting
        if (!vaultHub.isVaultConnected(address(stakingVault)) || vaultHub.isPendingDisconnect(address(stakingVault)))
            return;

        //decrease liabilities
        uint256 shares = vaultHub.liabilityShares(address(stakingVault));
        if (shares != 0) {
            vaultHub.burnShares(address(stakingVault), shares);
        }

        vm.prank(userAccount);
        vaultHub.voluntaryDisconnect(address(stakingVault));
    }

    /// @notice Funds the vault via VaultHub
    function fund(uint256 amount) public {
        amount = bound(amount, 1, 1 ether);
        deal(address(userAccount), amount);
        vm.prank(userAccount);
        vaultHub.fund{value: amount}(address(stakingVault));
    }

    /// @notice Withdraws from the vault via VaultHub
    function VHwithdraw(uint256 amount) public {
        amount = bound(amount, 1, vaultHub.withdrawableValue(address(stakingVault)));

        //check that stakingVault is connected
        if (!vaultHub.isVaultConnected(address(stakingVault))) {
            return;
        }
        vm.prank(userAccount);
        vaultHub.withdraw(address(stakingVault), userAccount, amount);
    }

    /// @notice Forces a rebalance if the vault has available balance and obligations
    function forceRebalance() public {
        // if (vaultHub.isVaultHealthy(address(stakingVault))) {
        //     return;
        // }

        uint256 availableBalance = Math256.min(
            stakingVault.availableBalance(),
            vaultHub.totalValue(address(stakingVault))
        );
        if (availableBalance == 0) {
            return;
        }

        (uint256 obligationsShares, ) = vaultHub.obligations(address(stakingVault));
        uint256 sharesToForceRebalance = Math256.min(
            obligationsShares,
            lidoContract.getSharesByPooledEth(availableBalance)
        );
        if (sharesToForceRebalance == 0) {
            return;
        }

        vm.prank(userAccount);
        try vaultHub.forceRebalance(address(stakingVault)) {} catch {
            forceRebalanceReverted = true;
        }
    }

    /// @notice Forces validator exit if vault has obligations shortfall
    function forceValidatorExit() public {
        uint256 obligationsShortfallValue = vaultHub.obligationsShortfallValue(address(stakingVault));
        if (obligationsShortfallValue == 0) {
            return;
        }

        bytes memory pubkeys = new bytes(0);
        vm.prank(rootAccount); //privileged account can force exit
        try vaultHub.forceValidatorExit{value: 3000}(address(stakingVault), pubkeys, userAccount) {
            // If the call succeeds, we do nothing
        } catch {
            forceValidatorExitReverted = true;
        }
    }

    /// @notice Mints shares for the vault
    function mintShares(uint256 shares) public {
        shares = bound(shares, MIN_SHARES, MAX_SHARES);
        vm.prank(userAccount);
        vaultHub.mintShares(address(stakingVault), userAccount, shares);
    }

    /// @notice Burns shares from the vault
    function burnShares(uint256 shares) public {
        shares = bound(shares, MIN_SHARES, MAX_SHARES);
        uint256 currShares = vaultHub.liabilityShares(address(stakingVault));
        uint256 sharesToBurn = Math256.min(currShares, shares);
        if (sharesToBurn == 0) {
            return;
        }
        vm.prank(userAccount);
        vaultHub.burnShares(address(stakingVault), sharesToBurn);
    }

    /// @notice Transfers and burns shares from the vault
    function transferAndBurnShares(uint256 shares) public {
        shares = bound(shares, MIN_SHARES, MAX_SHARES);
        uint256 currShares = vaultHub.liabilityShares(address(stakingVault));
        uint256 sharesToBurn = Math256.min(currShares, shares);
        if (sharesToBurn == 0) {
            return;
        }
        vm.prank(userAccount);
        vaultHub.transferAndBurnShares(address(stakingVault), shares);
    }

    /// @notice Calls rebalance on the staking vault (via VaultHub)
    function rebalance(uint256 amount) public {
        VaultHub.VaultConnection memory vc = vaultHub.vaultConnection(address(stakingVault));
        if (!vaultHub.isVaultConnected(address(stakingVault)) || vaultHub.isPendingDisconnect(address(stakingVault)))
            return;

        uint256 totalValue = vaultHub.totalValue(address(stakingVault));
        amount = bound(amount, 1, totalValue);

        vm.prank(userAccount);
        vaultHub.rebalance(address(stakingVault), amount);
    }

    /// @notice Returns the effective total value of the vault (EL + CL balance)
    function getEffectiveVaultTotalValue() public view returns (uint256) {
        return address(stakingVault).balance + cl_balance;
    }

    /// @notice Returns the reported total value of the vault
    function getVaultTotalValue() public view returns (uint256) {
        return vaultHub.totalValue(address(stakingVault));
    }

    /// @notice Simulates OTC deposit to the staking vault
    function sv_otcDeposit(uint256 amount) public {
        amount = bound(amount, 1 ether, 10 ether);
        sv_otcDeposited += amount;
        deal(address(stakingVault), address(stakingVault).balance + amount);
    }

    /// @notice Simulates OTC deposit to the VaultHub
    function vh_otcDeposit(uint256 amount) public {
        amount = bound(amount, 1 ether, 10 ether);
        vh_otcDeposited += amount;
        deal(address(vaultHub), address(vaultHub).balance + amount);
    }

    // --- LazyOracle interactions ---

    /// @notice Updates vault data, simulating time shifts and quarantine logic
    function updateVaultData(uint256 daysShift) public {
        daysShift = bound(daysShift, 0, 1);
        daysShift *= 3; // 0 or 3 days for quarantine period expiration

        //Check if vault is connected before proceeding
        if (!vaultHub.isVaultConnected(address(stakingVault))) {
            return;
        }

        if (daysShift > 0) {
            vm.warp(block.timestamp + daysShift * 1 days);
            (uint256 refSlot1, ) = consensusContract.getCurrentFrame();
            vm.prank(accountingOracle);
            lazyOracle.updateReportData(uint256(block.timestamp), refSlot1, bytes32(0), "test");

            VaultHub.VaultRecord memory vaultRecord = vaultHub.vaultRecord(address(stakingVault));

            lastReport = VaultReport({
                totalValue: stakingVault.availableBalance() + cl_balance + sv_otcDeposited, //*/ vaultHub.totalValue(address(stakingVault)),// + sv_otcDeposited + cl_balance,
                cumulativeLidoFees: vaultRecord.cumulativeLidoFees + vaultRecord.settledLidoFees + 1,
                liabilityShares: vaultHub.liabilityShares(address(stakingVault)),
                reportTimestamp: uint64(block.timestamp)
            });

            //reset otc deposit value
            sv_otcDeposited = 0;
        }

        // Simulate next ref slot
        (uint256 refSlot, ) = consensusContract.getCurrentFrame();
        if (daysShift > 0) {
            refSlot += daysShift;
            consensusContract.setCurrentFrame(refSlot);
        }
        // If no new report since vault connection, skip
        if (lastReport.totalValue == 0 && lastReport.cumulativeLidoFees == 0) return;

        //we update the reported total Value
        reportedTotalValue = lastReport.totalValue;

        uint256 maxLiabilityShares = vaultHub.vaultRecord(address(stakingVault)).maxLiabilityShares;

        //update the vault data
        lazyOracle.updateVaultData(
            address(stakingVault),
            lastReport.totalValue,
            lastReport.cumulativeLidoFees,
            lastReport.liabilityShares,
            maxLiabilityShares,
            0,
            new bytes32[](0)
        );

        bool isReportFresh = vaultHub.isReportFresh(address(stakingVault));

        //we update the applied total value (TV should go through sanity checks, quarantine, etc.)
        appliedTotalValue = vaultHub.vaultRecord(address(stakingVault)).report.totalValue;
        // Accept ownership if disconnect was successful
        if (stakingVault.pendingOwner() == userAccount) {
            vm.prank(userAccount);
            stakingVault.acceptOwnership();
        }
    }

    // --- StakingVault interactions ---

    /// @notice Withdraws directly from the staking vault (when not managed by VaultHub)
    function SVwithdraw(uint256 amount) public {
        if (stakingVault.owner() != userAccount) {
            return;
        }
        amount = bound(amount, 1, address(stakingVault).balance);

        vm.prank(userAccount);
        stakingVault.withdraw(userAccount, amount);
    }
}
