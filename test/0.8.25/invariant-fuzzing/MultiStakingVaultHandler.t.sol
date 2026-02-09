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

    /// @dev Sorts two hashes and hashes them together (matches OpenZeppelin's commutativeKeccak256).
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Computes the double-hashed merkle leaf for a vault from its report data.
    function _computeLeaf(uint256 id) internal view returns (bytes32) {
        VaultReport storage report = vaultReports[id];
        return
            keccak256(
                bytes.concat(
                    keccak256(
                        abi.encode(
                            address(stakingVaults[id]),
                            report.totalValue,
                            report.cumulativeLidoFees,
                            report.liabilityShares,
                            report.maxLiabilityShares,
                            uint256(0)
                        )
                    )
                )
            );
    }

    /// @dev Builds a complete binary merkle tree from leaves and returns (root, per-leaf proofs).
    ///      Uses 1-indexed flat array: tree[1] = root, leaves at tree[P..2P-1].
    ///      Pads to power-of-2 with bytes32(0).
    function _buildMerkleTree(bytes32[] memory leaves) internal pure returns (bytes32 root, bytes32[][] memory proofs) {
        uint256 n = leaves.length;
        if (n == 0) return (bytes32(0), new bytes32[][](0));
        if (n == 1) {
            proofs = new bytes32[][](1);
            proofs[0] = new bytes32[](0);
            return (leaves[0], proofs);
        }

        // Round up to next power of 2
        uint256 p = 1;
        while (p < n) p <<= 1;

        // Flat 1-indexed tree: indices [1..2p-1], leaves at [p..2p-1]
        bytes32[] memory tree = new bytes32[](2 * p);
        for (uint256 i = 0; i < n; i++) {
            tree[p + i] = leaves[i];
        }
        // Padding slots are already bytes32(0)

        // Build tree bottom-up
        for (uint256 i = p - 1; i >= 1; i--) {
            tree[i] = _hashPair(tree[2 * i], tree[2 * i + 1]);
        }
        root = tree[1];

        // Extract proofs for each original leaf
        proofs = new bytes32[][](n);
        uint256 depth = 0;
        {
            uint256 tmp = p;
            while (tmp > 1) {
                depth++;
                tmp >>= 1;
            }
        }

        for (uint256 i = 0; i < n; i++) {
            proofs[i] = new bytes32[](depth);
            uint256 idx = p + i;
            for (uint256 d = 0; d < depth; d++) {
                // Sibling is idx ^ 1
                proofs[i][d] = tree[idx ^ 1];
                idx >>= 1;
            }
        }
    }

    /// @dev Returns array of vault indices that are currently connected to VaultHub
    ///      (including pending-disconnect vaults, since they still need oracle reports).
    function _getConnectedVaultIds() internal view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < stakingVaults.length; i++) {
            if (vaultHub.isVaultConnected(address(stakingVaults[i]))) {
                count++;
            }
        }
        uint256[] memory ids = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < stakingVaults.length; i++) {
            if (vaultHub.isVaultConnected(address(stakingVaults[i]))) {
                ids[idx++] = i;
            }
        }
        return ids;
    }

    /// @dev Submits one oracle report covering all given vault IDs with a proper merkle tree.
    function _batchReport(uint256[] memory ids, uint256 daysShift) internal {
        uint256 n = ids.length;
        if (n == 0) return;

        // 1. Compute leaves
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = _computeLeaf(ids[i]);
        }

        // 2. Build merkle tree
        (bytes32 root, bytes32[][] memory proofs) = _buildMerkleTree(leaves);

        // 3. Advance time and update consensus frame
        (uint256 refSlot, ) = consensusContract.getCurrentFrame();
        uint256 nextRefSlot = refSlot + daysShift;
        consensusContract.setCurrentFrame(nextRefSlot);
        vm.warp(block.timestamp + daysShift * 1 days);

        // 4. Submit report data
        vm.prank(accountingOracle);
        lazyOracle.updateReportData(uint256(block.timestamp), nextRefSlot, root, "test");

        // 5. Update each vault's data with its proof
        for (uint256 i = 0; i < n; i++) {
            VaultReport storage report = vaultReports[ids[i]];
            lazyOracle.updateVaultData(
                address(stakingVaults[ids[i]]),
                report.totalValue,
                report.cumulativeLidoFees,
                report.liabilityShares,
                report.maxLiabilityShares,
                0,
                proofs[i]
            );
        }
    }

    /// @dev Performs a full batch update for ALL connected vaults with the two-report pattern:
    ///      1st report bypasses fresh check, 2nd bypasses quarantine.
    function _batchUpdateAllVaults() internal {
        uint256[] memory ids = _getConnectedVaultIds();
        if (ids.length == 0) return;

        // 1. Prepare report data for each vault
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            address _vault = address(stakingVaults[id]);
            VaultHub.VaultRecord memory vaultRecord = vaultHub.vaultRecord(_vault);
            uint256 liabilityShares = vaultHub.liabilityShares(_vault);

            vaultReports[id] = VaultReport({
                totalValue: _vault.balance,
                cumulativeLidoFees: vaultRecord.cumulativeLidoFees + vaultRecord.settledLidoFees + 1, // +1 to ensure non-zero fee delta even when settledLidoFees is 0
                liabilityShares: liabilityShares,
                maxLiabilityShares: Math256.max(vaultRecord.maxLiabilityShares, liabilityShares),
                reportTimestamp: uint64(block.timestamp)
            });
        }

        // 2. First batch report (bypass fresh check)
        _batchReport(ids, 2);

        // 3. Update maxLiabilityShares for each vault (no minting between reports)
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            vaultReports[id].maxLiabilityShares = vaultHub.liabilityShares(address(stakingVaults[id]));
        }

        // 4. Second batch report (bypass quarantine)
        _batchReport(ids, QUARANTINE_DAYS);

        // 5. Reset otcDeposited for each vault
        for (uint256 i = 0; i < ids.length; i++) {
            sv_otcDeposited[ids[i]] = 0;
        }
    }

    /// @dev Ensures the vault has a fresh oracle report. If stale, updates ALL connected vaults in one batch.
    function _ensureFreshReport(uint256 id) internal {
        uint256 latestReportTs = lazyOracle.latestReportTimestamp();
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(address(stakingVaults[id]));
        bool isFresh = uint48(latestReportTs) <= record.report.timestamp && block.timestamp - latestReportTs < 2 days;
        if (!isFresh) {
            _batchUpdateAllVaults();
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
            // Complete disconnect by submitting one more report (single vault)
            uint256[] memory singleId = new uint256[](1);
            singleId[0] = id;
            _batchReport(singleId, 1);

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

    /// @notice Updates vault data for all connected vaults in a single batch report
    function updateVaultData(uint256 id, uint256 /* daysShift */) public {
        id = bound(id, 0, userAccount.length - 1);
        if (!_isConnectedAndActive(id)) return;

        _batchUpdateAllVaults();
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
