// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.25;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {Vm} from "forge-std/Vm.sol";

import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {LidoLocatorMock, ConsensusContractMock} from "./mocks/CommonMocks.sol";

import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";
import {OperatorGridMock} from "./mocks/OperatorGridMock.sol";
import {Constants} from "./StakingVaultConstants.sol";

/// @title MultiStakingVaultHandler
/// @notice Handler contract for invariant fuzzing of multiple staking vaults, tiers, and groups in the Lido protocol.
/// @dev Ensures fresh oracle reports before state-changing operations to avoid trivial VaultReportStale reverts.
/// Tracks per-vault report data and handles the full lifecycle: connect, fund, mint, burn, withdraw, disconnect, tier changes.
contract MultiStakingVaultHandler is CommonBase, StdCheats, StdUtils, StdAssertions {
    // Protocol contracts
    ILido public lidoContract;
    LidoLocatorMock public lidoLocator;
    VaultHub public vaultHub;
    StakingVault[] public stakingVaults;
    LazyOracle public lazyOracle;
    OperatorGridMock public operatorGrid;
    ConsensusContractMock public consensusContract;
    address public accountingOracle;

    struct VaultReport {
        uint256 totalValue;
        uint256 cumulativeLidoFees;
        uint256 liabilityShares;
        uint256 maxLiabilityShares;
        uint64 reportTimestamp;
    }

    // Per-vault report tracking
    mapping(uint256 => VaultReport) public vaultReports;

    // Account addresses
    address[] public userAccount;
    address public rootAccount;

    uint256 constant MIN_SHARES = 1;
    uint256 constant QUARANTINE_DAYS = 3;

    mapping(uint256 => uint256) public sv_otcDeposited;
    uint256 public vh_otcDeposited = 0;

    bool public forceRebalanceReverted = false;
    bool public forceValidatorExitReverted = false;

    constructor(
        address _lidoLocator,
        StakingVault[] memory _stakingVaults,
        address _rootAccount,
        address[] memory _userAccount
    ) {
        lidoLocator = LidoLocatorMock(_lidoLocator);
        accountingOracle = lidoLocator.accountingOracle();
        lidoContract = ILido(lidoLocator.lido());
        vaultHub = VaultHub(payable(lidoLocator.vaultHub()));
        stakingVaults = _stakingVaults;
        lazyOracle = LazyOracle(lidoLocator.lazyOracle());
        operatorGrid = OperatorGridMock(lidoLocator.operatorGrid());
        consensusContract = ConsensusContractMock(lidoLocator.consensusContract());
        rootAccount = _rootAccount;
        userAccount = _userAccount;
    }

    // ========== Internal Helpers ==========

    /// @dev Submits a single oracle report for a specific vault, advancing time by daysShift days.
    ///      Computes a proper merkle leaf from vaultReports[id] and sets it as the tree root,
    ///      then calls updateVaultData with an empty proof (leaf == root).
    function _reportForVault(uint256 id, uint256 daysShift) internal {
        address _vault = address(stakingVaults[id]);
        VaultReport storage report = vaultReports[id];

        bytes32 leaf = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        _vault,
                        report.totalValue,
                        report.cumulativeLidoFees,
                        report.liabilityShares,
                        report.maxLiabilityShares,
                        uint256(0) // slashingReserve
                    )
                )
            )
        );

        (uint256 refSlot, ) = consensusContract.getCurrentFrame();
        uint256 nextRefSlot = refSlot + daysShift;
        consensusContract.setCurrentFrame(nextRefSlot);

        vm.warp(block.timestamp + daysShift * 1 days);

        vm.prank(accountingOracle);
        lazyOracle.updateReportData(uint256(block.timestamp), nextRefSlot, leaf, "test");

        lazyOracle.updateVaultData(
            _vault,
            report.totalValue,
            report.cumulativeLidoFees,
            report.liabilityShares,
            report.maxLiabilityShares,
            0,
            new bytes32[](0) // empty proof: leaf == root
        );
    }

    /// @dev Performs a full vault data update with 2 reports:
    ///      1st bypasses the fresh report check, 2nd bypasses quarantine expiration.
    function _updateVaultDataForId(uint256 id) internal {
        address _vault = address(stakingVaults[id]);
        VaultHub.VaultRecord memory vaultRecord = vaultHub.vaultRecord(_vault);

        uint256 liabilityShares = vaultHub.liabilityShares(_vault);

        vaultReports[id] = VaultReport({
            totalValue: address(stakingVaults[id]).balance,
            cumulativeLidoFees: vaultRecord.cumulativeLidoFees + vaultRecord.settledLidoFees + 1,
            liabilityShares: liabilityShares,
            maxLiabilityShares: Math256.max(vaultRecord.maxLiabilityShares, liabilityShares),
            reportTimestamp: uint64(block.timestamp)
        });

        _reportForVault(id, 2); // bypass fresh report

        vaultReports[id].maxLiabilityShares = liabilityShares; // no minting between reports

        _reportForVault(id, QUARANTINE_DAYS); // bypass quarantine period

        sv_otcDeposited[id] = 0;
    }

    /// @dev Ensures the vault has a fresh oracle report. Skips if already fresh.
    function _ensureFreshReport(uint256 id) internal {
        uint256 latestReportTs = lazyOracle.latestReportTimestamp();
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(address(stakingVaults[id]));
        bool isFresh = uint48(latestReportTs) <= record.report.timestamp && block.timestamp - latestReportTs < 2 days;
        if (!isFresh) {
            _updateVaultDataForId(id);
        }
    }

    /// @dev Returns true if the vault is connected and not pending disconnect.
    function _isConnectedAndActive(uint256 id) internal view returns (bool) {
        return
            vaultHub.isVaultConnected(address(stakingVaults[id])) &&
            !vaultHub.isPendingDisconnect(address(stakingVaults[id]));
    }

    // ========== VaultHub Interactions ==========

    /// @notice Connects a vault to the VaultHub, funding if needed
    function connectVault(uint256 id) public {
        id = bound(id, 0, userAccount.length - 1);
        VaultHub.VaultConnection memory vc = vaultHub.vaultConnection(address(stakingVaults[id]));
        if (vc.vaultIndex != 0) return; // already connected

        if (stakingVaults[id].availableBalance() < Constants.CONNECT_DEPOSIT) {
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
        if (!_isConnectedAndActive(id)) return;

        _ensureFreshReport(id);

        // Burn all liability shares first
        uint256 shares = vaultHub.liabilityShares(address(stakingVaults[id]));
        if (shares != 0) {
            vm.prank(userAccount[id]);
            vaultHub.burnShares(address(stakingVaults[id]), shares);
        }

        // Check if enough balance for unsettled fees
        (, uint256 unsettledFees) = vaultHub.obligations(address(stakingVaults[id]));
        uint256 availableBalance = Math256.min(
            stakingVaults[id].availableBalance(),
            vaultHub.totalValue(address(stakingVaults[id]))
        );
        if (availableBalance < unsettledFees) return;

        vm.prank(userAccount[id]);
        try vaultHub.voluntaryDisconnect(address(stakingVaults[id])) {
            // Complete disconnect by submitting one more report
            _reportForVault(id, 1);

            if (stakingVaults[id].pendingOwner() == userAccount[id]) {
                vm.prank(userAccount[id]);
                stakingVaults[id].acceptOwnership();
            }
        } catch {}
    }

    /// @notice Funds a vault via VaultHub
    function fund(uint256 id, uint256 amount) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!_isConnectedAndActive(id)) return;

        amount = bound(amount, 1, 1 ether);
        deal(address(userAccount[id]), address(userAccount[id]).balance + amount);

        vm.prank(userAccount[id]);
        vaultHub.fund{value: amount}(address(stakingVaults[id]));
    }

    /// @notice Withdraws from a vault via VaultHub
    function VHwithdraw(uint256 id, uint256 amount) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!_isConnectedAndActive(id)) return;

        _ensureFreshReport(id);

        uint256 withdrawable = vaultHub.withdrawableValue(address(stakingVaults[id]));
        if (withdrawable == 0) return;

        amount = bound(amount, 1, withdrawable);

        vm.prank(userAccount[id]);
        vaultHub.withdraw(address(stakingVaults[id]), userAccount[id], amount);
    }

    /// @notice Forces a rebalance if the vault is unhealthy
    function forceRebalance(uint256 id) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!_isConnectedAndActive(id)) return;

        _ensureFreshReport(id);

        if (vaultHub.isVaultHealthy(address(stakingVaults[id]))) return;

        vm.prank(userAccount[id]);
        try vaultHub.forceRebalance(address(stakingVaults[id])) {} catch {
            forceRebalanceReverted = true;
        }
    }

    /// @notice Forces validator exit if vault has obligations shortfall
    function forceValidatorExit(uint256 id) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!vaultHub.isVaultConnected(address(stakingVaults[id]))) return;

        uint256 obligationsShortfall = vaultHub.obligationsShortfallValue(address(stakingVaults[id]));
        if (obligationsShortfall == 0) return;

        bytes memory pubkeys = new bytes(0);
        vm.prank(rootAccount);
        try vaultHub.forceValidatorExit(address(stakingVaults[id]), pubkeys, userAccount[id]) {} catch {
            forceValidatorExitReverted = true;
        }
    }

    /// @notice Mints shares for a vault, respecting actual minting capacity
    function mintShares(uint256 id, uint256 shares) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!_isConnectedAndActive(id)) return;

        _ensureFreshReport(id);

        uint256 maxCapacity = vaultHub.totalMintingCapacityShares(address(stakingVaults[id]), 0);
        uint256 currentLiability = vaultHub.liabilityShares(address(stakingVaults[id]));
        uint256 available = maxCapacity > currentLiability ? maxCapacity - currentLiability : 0;
        if (available == 0) return;

        shares = bound(shares, MIN_SHARES, available);

        vm.prank(userAccount[id]);
        vaultHub.mintShares(address(stakingVaults[id]), userAccount[id], shares);
    }

    /// @notice Burns shares from a vault
    function burnShares(uint256 id, uint256 shares) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!vaultHub.isVaultConnected(address(stakingVaults[id]))) return;

        uint256 currShares = vaultHub.liabilityShares(address(stakingVaults[id]));
        if (currShares == 0) return;

        shares = bound(shares, MIN_SHARES, currShares);

        vm.prank(userAccount[id]);
        vaultHub.burnShares(address(stakingVaults[id]), shares);
    }

    /// @notice Changes the tier of a vault, respecting share limits
    function changeTier(uint256 id, uint256 _requestedTierId, uint256 _requestedShareLimit) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!_isConnectedAndActive(id)) return;

        _ensureFreshReport(id);

        address nodeOperator = stakingVaults[id].nodeOperator();
        OperatorGridMock.Group memory nodeOperatorGroup = operatorGrid.group(nodeOperator);
        if (nodeOperatorGroup.tierIds.length <= 1) return;

        _requestedTierId = bound(_requestedTierId, 1, nodeOperatorGroup.tierIds.length - 1);
        uint256 requestedTierId = nodeOperatorGroup.tierIds[_requestedTierId];

        (, uint256 vaultTierId, , , , , , ) = operatorGrid.vaultInfo(address(stakingVaults[id]));
        if (requestedTierId == vaultTierId) return;

        uint256 requestedTierShareLimit = operatorGrid.tier(requestedTierId).shareLimit;

        _requestedShareLimit = bound(
            _requestedShareLimit,
            vaultHub.liabilityShares(address(stakingVaults[id])),
            requestedTierShareLimit
        );

        // changeTier can revert if the new tier's reserve ratio makes the vault unhealthy
        // (VaultMintingCapacityExceeded), or if tier/group limits are exceeded
        vm.prank(userAccount[id]);
        try operatorGrid.changeTier(address(stakingVaults[id]), requestedTierId, _requestedShareLimit) {} catch {}
    }

    /// @notice Simulates OTC deposit to a staking vault
    function sv_otcDeposit(uint256 id, uint256 amount) public {
        id = bound(id, 0, userAccount.length - 1);
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

    /// @notice Updates vault data, simulating time shifts and quarantine logic
    function updateVaultData(uint256 id, uint256 /* daysShift */) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!_isConnectedAndActive(id)) return;

        _updateVaultDataForId(id);
    }

    // --- StakingVault interactions ---

    /// @notice Withdraws directly from a staking vault (when not managed by VaultHub)
    function SVwithdraw(uint256 id, uint256 amount) public {
        id = bound(id, 0, userAccount.length - 1);
        if (stakingVaults[id].owner() != userAccount[id]) return;

        uint256 balance = address(stakingVaults[id]).balance;
        if (balance == 0) return;

        amount = bound(amount, 1, balance);

        vm.prank(userAccount[id]);
        stakingVaults[id].withdraw(userAccount[id], amount);
    }
}
