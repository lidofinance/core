// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.25;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {StdAssertions} from "forge-std/StdAssertions.sol";
import {Vm} from "forge-std/Vm.sol";

import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {LidoLocatorMock, ConsensusContractMock} from "./mocks/CommonMocks.sol";

import {LazyOracleMock} from "./mocks/LazyOracleMock.sol";
import {OperatorGridMock} from "./mocks/OperatorGridMock.sol";
import {Constants} from "./StakingVaultConstants.sol";
import "forge-std/console2.sol";

/// @title MultiStakingVaultHandler
/// @notice Handler contract for invariant fuzzing of multiple staking vaults, tiers, and groups in the Lido protocol.
/// @dev Used by fuzzing contracts to simulate user and protocol actions, track state, and expose relevant variables for invariant checks across multiple vaults.
/// The handler enables deep testing of vault logic, including deposits, withdrawals, connection/disconnection, tier changes, and time manipulation.
/// It is extensible and designed to help ensure critical invariants always hold, even under adversarial or randomized conditions.
contract MultiStakingVaultHandler is CommonBase, StdCheats, StdUtils, StdAssertions {
    // Protocol contracts
    ILido public lidoContract;
    LidoLocatorMock public lidoLocator;
    VaultHub public vaultHub;
    StakingVault[] public stakingVaults;
    LazyOracleMock public lazyOracle;
    OperatorGridMock public operatorGrid;
    ConsensusContractMock public consensusContract;
    VaultReport public lastReport;

    uint256[2] public groupShareLimit;
    uint256[4] public tierShareLimit;

    struct VaultReport {
        uint256 totalValue;
        uint256 cumulativeLidoFees;
        uint256 liabilityShares;
        uint64 reportTimestamp;
    }

    // Account addresses
    address[] public userAccount;
    address public rootAccount;

    uint256 public cl_balance = 0; // Amount deposited on beacon chain

    uint256 constant MIN_SHARES = 1;
    uint256 constant MAX_SHARES = 100;

    uint256[4] public sv_otcDeposited;
    uint256 public vh_otcDeposited = 0;

    bool public forceRebalanceReverted = false;
    bool public forceValidatorExitReverted = false;



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

    constructor(address _lidoLocator, StakingVault[] memory _stakingVaults, address _rootAccount, address[] memory _userAccount) {
        lidoLocator = LidoLocatorMock(_lidoLocator);
        lidoContract = ILido(lidoLocator.lido());
        vaultHub = VaultHub(payable(lidoLocator.vaultHub()));
        stakingVaults = _stakingVaults;
        lazyOracle = LazyOracleMock(lidoLocator.lazyOracle());
        operatorGrid = OperatorGridMock(lidoLocator.operatorGrid());
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
            revert("not the correct sequence");
        }
        _;
    }


    // --- Getters for invariant checks ---
    function getGroupShareLimit(uint256 groupId) public view returns (uint256) {
        return groupShareLimit[groupId];
    }

    function getTierShareLimit(uint256 tierId) public view returns (uint256) {
        return tierShareLimit[tierId];
    }


    // --- VaultHub interactions ---
    /// @notice Connects a vault to the VaultHub, funding if needed
    function connectVault(uint256 id) public {
        id = bound(id, 0, userAccount.length - 1);
        VaultHub.VaultConnection memory vc = vaultHub.vaultConnection(address(stakingVaults[id]));
        if (vc.vaultIndex != 0) return;
        if (address(stakingVaults[id]).balance < Constants.CONNECT_DEPOSIT) {
            deal(address(userAccount[id]), Constants.CONNECT_DEPOSIT);
            vm.prank(userAccount[id]);
            stakingVaults[id].fund{value: Constants.CONNECT_DEPOSIT}();
        }
        vm.prank(userAccount[id]);
        stakingVaults[id].transferOwnership(address(vaultHub));
        vm.prank(userAccount[id]);
        vaultHub.connectVault(address(stakingVaults[id]));
    }

    /// @notice Initiates voluntary disconnect for a vault
    function voluntaryDisconnect(uint256 id) public {
        id = bound(id, 0, userAccount.length - 1);
        VaultHub.VaultConnection memory vc = vaultHub.vaultConnection(address(stakingVaults[id]));
        if (vc.vaultIndex == 0 || vc.pendingDisconnect == true) return;
        uint256 shares = vaultHub.liabilityShares(address(stakingVaults[id]));
        if (shares != 0) {
            vm.prank(userAccount[id]);
            vaultHub.burnShares(address(stakingVaults[id]), shares);
        }
        vm.prank(userAccount[id]);
        vaultHub.voluntaryDisconnect(address(stakingVaults[id]));
    }

    /// @notice Funds a vault via VaultHub
    function fund(uint256 id, uint256 amount) public {
        id = bound(id, 0, userAccount.length - 1);
        amount = bound(amount, 1, 1 ether);
        deal(address(userAccount[id]), address(userAccount[id]).balance + amount);
        vm.prank(userAccount[id]);
        vaultHub.fund{value: amount}(address(stakingVaults[id]));
    }

    /// @notice Withdraws from a vault via VaultHub
    function VHwithdraw(uint256 id, uint256 amount) public {
        id = bound(id, 0, userAccount.length - 1);
        amount = bound(amount, 0, vaultHub.withdrawableValue(address(stakingVaults[id])));
        if (vaultHub.vaultConnection(address(stakingVaults[id])).vaultIndex == 0) {
            return;
        }
        if (amount == 0) {
            return;
        }
        vm.prank(userAccount[id]);
        vaultHub.withdraw(address(stakingVaults[id]), userAccount[id], amount);
    }

    /// @notice Forces a rebalance if the vault is unhealthy
    function forceRebalance(uint256 id) public {
        id = bound(id, 0, userAccount.length - 1);
        if (vaultHub.isVaultHealthy(address(stakingVaults[id]))) {
            return;
        }
        vm.prank(userAccount[id]);
        try vaultHub.forceRebalance(address(stakingVaults[id])) {
        } catch {
            forceRebalanceReverted = true;
        }
    }

    /// @notice Forces validator exit if vault is unhealthy or obligations exceed threshold
    function forceValidatorExit(uint256 id) public {
        id = bound(id, 0, userAccount.length - 1);
        uint256 redemptions = vaultHub.vaultObligations(address(stakingVaults[id])).redemptions;
        if (vaultHub.isVaultHealthy(address(stakingVaults[id])) && redemptions < Math256.max(Constants.UNSETTLED_THRESHOLD, address(stakingVaults[id]).balance)) {
            return;
        }
        bytes memory pubkeys = new bytes(0);
        vm.prank(rootAccount);
        try vaultHub.forceValidatorExit(address(stakingVaults[id]), pubkeys, userAccount[id]) {
        } catch {
            forceValidatorExitReverted = true;
        }
    }

    /// @notice Mints shares for a vault
    function mintShares(uint256 id, uint256 shares) public {
        id = bound(id, 0, userAccount.length - 1);
        shares = bound(shares, MIN_SHARES, MAX_SHARES);
        vm.prank(userAccount[id]);
        vaultHub.mintShares(address(stakingVaults[id]), userAccount[id], shares);
    }

    /// @notice Burns shares from a vault
    function burnShares(uint256 id, uint256 shares) public {
        id = bound(id, 0, userAccount.length - 1);
        shares = bound(shares, MIN_SHARES, MAX_SHARES);
        uint256 currShares = vaultHub.liabilityShares(address(stakingVaults[id]));
        uint256 sharesToBurn = Math256.min(currShares, shares);
        if (sharesToBurn == 0) {
            return;
        }
        vm.prank(userAccount[id]);
        vaultHub.burnShares(address(stakingVaults[id]), sharesToBurn);
    }

    /// @notice Changes the tier of a vault, respecting share limits
    function changeTier(uint256 id, uint256 _requestedTierId, uint256 _requestedShareLimit) public {
        id = bound(id, 0, userAccount.length - 1);
        if (vaultHub.vaultConnection(address(stakingVaults[id])).vaultIndex == 0) {
            return;
        }
        address nodeOperator = stakingVaults[id].nodeOperator();
        OperatorGridMock.Group memory nodeOperatorGroup = operatorGrid.group(nodeOperator);
        _requestedTierId = bound(_requestedTierId, 1, nodeOperatorGroup.tierIds.length - 1); // cannot change to default tier (0)
        (,uint256 vaultTierId,,,,,,) = operatorGrid.vaultInfo(address(stakingVaults[id]));
        if (_requestedTierId == vaultTierId)
            return;
        uint256 requestedTierId = nodeOperatorGroup.tierIds[_requestedTierId];
        uint256 requestedTierShareLimit = operatorGrid.tier(requestedTierId).shareLimit;

        /////// AVOIDS INVARIANT VIOLATION ///////////
        _requestedShareLimit = bound(_requestedShareLimit,  vaultHub.liabilityShares(address(stakingVaults[id])), requestedTierShareLimit); //this caught a finding with a minimum set to 1
        

        vm.prank(userAccount[id]);
        operatorGrid.changeTier(address(stakingVaults[id]), requestedTierId, _requestedShareLimit);
    }


    /// @notice Simulates OTC deposit to a staking vault
    function sv_otcDeposit(uint256 id, uint256 amount) public {
        id = bound(id, 0, userAccount.length-1);
        amount = bound(amount, 1 ether, 10 ether);
        sv_otcDeposited[id] += amount;
        deal(address(stakingVaults[id]), address(stakingVaults[id]).balance + amount);
    }

    /// @notice Simulates OTC deposit to the VaultHub
    function vh_otcDeposit(uint256 amount) public {
        amount = bound(amount, 1 ether, 10 ether);
        vh_otcDeposited += amount;
        deal(address(vaultHub), address(vaultHub).balance + amount);
    }

    // --- LazyOracle interactions ---

    /// @notice Updates vault data, simulating time shifts and quarantine logic
    function updateVaultData(uint256 id, uint256 daysShift) public {
        id = bound(id, 0, userAccount.length - 1);
        if (vaultHub.vaultConnection(address(stakingVaults[id])).vaultIndex == 0) {
            return;
        }
        daysShift = bound(daysShift, 0, 1);
        daysShift *= 3; // 0 or 3 days for quarantine period expiration
        if (daysShift > 0) {
            vm.warp(block.timestamp + daysShift * 1 days);
            lazyOracle.setVaultDataTimestamp(uint64(block.timestamp));
            VaultHub.VaultObligations memory obligations = vaultHub.vaultObligations(address(stakingVaults[id]));

            lastReport = VaultReport({
                totalValue: vaultHub.totalValue(address(stakingVaults[id])) + sv_otcDeposited[id] + cl_balance,
                cumulativeLidoFees: obligations.settledLidoFees + obligations.unsettledLidoFees + 1,
                liabilityShares: vaultHub.liabilityShares(address(stakingVaults[id])),
                reportTimestamp: uint64(block.timestamp)
            });

            //reset otc deposit value
            sv_otcDeposited[id] = 0;
        }
        // Simulate next ref slot
        (uint256 refSlot, ) = consensusContract.getCurrentFrame();
        if (daysShift > 0) {
            refSlot += daysShift;
            consensusContract.setCurrentFrame(refSlot);
        }

        //update the vault data
        lazyOracle.updateVaultData(
            address(stakingVaults[id]),
            lastReport.totalValue,
            lastReport.cumulativeLidoFees,
            lastReport.liabilityShares,
            uint64(block.timestamp)
        );
        // Accept ownership if disconnect was successful
        if (stakingVaults[id].pendingOwner() == userAccount[id]) {
            vm.prank(userAccount[id]);
            stakingVaults[id].acceptOwnership();
        }
    }

    // --- StakingVault interactions ---

    /// @notice Withdraws directly from a staking vault (when not managed by VaultHub)
    function SVwithdraw(uint256 id, uint256 amount) public {
        id = bound(id, 0, userAccount.length - 1);
        if (stakingVaults[id].owner() != userAccount[id]) {
            return;
        }
        amount = bound(amount, 1, address(stakingVaults[id]).balance);

        vm.prank(userAccount[id]);
        stakingVaults[id].withdraw(userAccount[id], amount);
    }
}
