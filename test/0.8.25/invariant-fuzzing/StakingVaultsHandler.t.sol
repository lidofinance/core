// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

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
        uint256 maxLiabilityShares;
        uint64 reportTimestamp;
    }

    // Account addresses
    address public userAccount;
    address public rootAccount;

    uint256 constant MIN_SHARES = 1;
    uint256 constant QUARANTINE_PERIOD = 3; // days

    uint256 public sv_otcDeposited = 0;

    bool public forceRebalanceReverted = false;
    bool public forceValidatorExitReverted = false;

    uint256 public appliedTotalValue = 0;
    uint256 public reportedTotalValue = 0;

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
    }

    modifier withFreshReport() {
        _ensureFreshReport();
        _;
    }

    modifier withConnectedVault() {
        bool isConnected = vaultHub.isVaultConnected(address(stakingVault));
        if (!isConnected) {
            connectVault();
            return;
        }
        _;
    }

    modifier withDisconnectedVault() {
        if (vaultHub.vaultConnection(address(stakingVault)).vaultIndex != 0) return;
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
    function connectVault() public withDisconnectedVault {
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
    function voluntaryDisconnect(uint256 shouldDisconnect) public withConnectedVault withFreshReport {
        shouldDisconnect = bound(shouldDisconnect, 0, 100);
        if (shouldDisconnect < 90) return; // 10% chance to disconnect

        (, uint256 unsettledFees) = vaultHub.obligations(address(stakingVault));
        uint256 availableBalance = Math256.min(
            stakingVault.availableBalance(),
            vaultHub.totalValue(address(stakingVault))
        );
        if (availableBalance < unsettledFees) {
            return;
        }

        uint256 shares = vaultHub.liabilityShares(address(stakingVault));
        if (shares != 0) {
            vm.prank(userAccount);
            vaultHub.burnShares(address(stakingVault), shares);
        }

        vm.prank(userAccount);
        try vaultHub.voluntaryDisconnect(address(stakingVault)) {
            // Prepare fresh report data for the post-disconnect report
            address _vault = address(stakingVault);
            VaultHub.VaultRecord memory vr = vaultHub.vaultRecord(_vault);
            uint256 ls = vaultHub.liabilityShares(_vault);
            lastReport = VaultReport({
                totalValue: _vault.balance,
                cumulativeLidoFees: vr.cumulativeLidoFees + vr.settledLidoFees + 1, // +1 to ensure non-zero fee delta even when settledLidoFees is 0
                liabilityShares: ls,
                maxLiabilityShares: Math256.max(vr.maxLiabilityShares, ls),
                reportTimestamp: uint64(block.timestamp)
            });
            _report(1);

            if (stakingVault.pendingOwner() == userAccount) {
                vm.prank(userAccount);
                stakingVault.acceptOwnership();
            }
        } catch {}
    }

    /// @notice Funds the vault via VaultHub
    function fund(uint256 amount) public withConnectedVault {
        amount = bound(amount, 1, 10 ether);
        deal(address(userAccount), address(userAccount).balance + amount);

        vm.prank(userAccount);
        vaultHub.fund{value: amount}(address(stakingVault));
    }

    /// @notice Withdraws from the vault via VaultHub
    function withdraw(uint256 amount) public withConnectedVault withFreshReport {
        uint256 withdrawableValue = vaultHub.withdrawableValue(address(stakingVault));
        if (withdrawableValue == 0) return;

        amount = bound(amount, 1, withdrawableValue);

        vm.prank(userAccount);
        vaultHub.withdraw(address(stakingVault), userAccount, amount);
    }

    /// @notice Forces a rebalance if the vault has available balance and obligations
    function forceRebalance() public withConnectedVault withFreshReport {
        uint256 availableBalance = Math256.min(
            stakingVault.availableBalance(),
            vaultHub.totalValue(address(stakingVault))
        );
        if (availableBalance == 0) return;

        (uint256 obligationsShares, ) = vaultHub.obligations(address(stakingVault));
        uint256 sharesToForceRebalance = Math256.min(
            obligationsShares,
            lidoContract.getSharesByPooledEth(availableBalance)
        );
        if (sharesToForceRebalance == 0) return;

        vm.prank(userAccount);
        try vaultHub.forceRebalance(address(stakingVault)) {} catch {
            forceRebalanceReverted = true;
        }
    }

    /// @notice Forces validator exit if vault has obligations shortfall
    function forceValidatorExit() public withConnectedVault withFreshReport {
        uint256 obligationsShortfallValue = vaultHub.obligationsShortfallValue(address(stakingVault));
        if (obligationsShortfallValue == 0) return;

        // 48-byte dummy pubkey for a single validator
        bytes memory pubkeys = new bytes(48);
        vm.prank(rootAccount);
        try
            vaultHub.forceValidatorExit{value: Constants.WITHDRAWAL_FEE}(address(stakingVault), pubkeys, userAccount)
        {} catch {
            forceValidatorExitReverted = true;
        }
    }

    /// @notice Mints shares for the vault
    function mintShares(uint256 shares) public withConnectedVault withFreshReport {
        uint256 maxLiabilityShares = vaultHub.totalMintingCapacityShares(address(stakingVault), 0);
        uint256 currShares = vaultHub.liabilityShares(address(stakingVault));
        uint256 sharesToMint = maxLiabilityShares > currShares ? maxLiabilityShares - currShares : 0;
        if (sharesToMint == 0) {
            return;
        }

        shares = bound(shares, MIN_SHARES, sharesToMint);

        vm.prank(userAccount);
        vaultHub.mintShares(address(stakingVault), userAccount, shares);
    }

    /// @notice Burns shares from the vault
    function burnShares(uint256 shares) public withConnectedVault {
        uint256 currShares = vaultHub.liabilityShares(address(stakingVault));
        if (currShares == 0) return;

        uint256 sharesToBurn = currShares <= MIN_SHARES ? currShares : bound(shares, MIN_SHARES, currShares);

        vm.prank(userAccount);
        vaultHub.burnShares(address(stakingVault), sharesToBurn);
    }

    /// @notice Calls rebalance on the staking vault (via VaultHub)
    function rebalance(uint256 amount) public withConnectedVault withFreshReport {
        uint256 maxSharesToRebalance = vaultHub.liabilityShares(address(stakingVault));
        if (maxSharesToRebalance == 0) {
            return;
        }

        uint256 availableBalance = stakingVault.availableBalance();
        uint256 sharesToRebalance = lidoContract.getSharesByPooledEth(availableBalance);
        uint256 maxRebalanceShares = Math256.min(maxSharesToRebalance, sharesToRebalance);
        if (maxRebalanceShares < MIN_SHARES) {
            return;
        }

        amount = bound(amount, MIN_SHARES, maxRebalanceShares);

        vm.prank(userAccount);
        vaultHub.rebalance(address(stakingVault), amount);
    }

    /// @notice Returns the effective total value of the vault (EL + CL balance)
    function getEffectiveVaultTotalValue() public view returns (uint256) {
        return address(stakingVault).balance;
    }

    /// @notice Returns the reported total value of the vault
    function getVaultTotalValue() public view returns (uint256) {
        return vaultHub.totalValue(address(stakingVault));
    }

    /// @notice Simulates OTC deposit to the staking vault
    function otcDepositToStakingVault(uint256 amount) public {
        amount = bound(amount, 1 ether, 10 ether);
        sv_otcDeposited += amount;
        deal(address(stakingVault), address(stakingVault).balance + amount);
    }

    // --- LazyOracle interactions ---

    /// @notice Updates vault data, simulating time shifts and quarantine logic
    function updateVaultData() public withConnectedVault {
        _updateVaultData();
    }

    // --- StakingVault interactions ---

    /// @notice Withdraws directly from the staking vault (when not managed by VaultHub)
    function withdrawFromStakingVault(uint256 amount) public withDisconnectedVault {
        if (stakingVault.owner() != userAccount) {
            return;
        }

        if (address(stakingVault).balance == 0) {
            return;
        }

        amount = bound(amount, 1, address(stakingVault).balance);

        vm.prank(userAccount);
        stakingVault.withdraw(userAccount, amount);
    }

    function _ensureFreshReport() internal {
        uint256 latestReportTs = lazyOracle.latestReportTimestamp();
        VaultHub.VaultRecord memory record = vaultHub.vaultRecord(address(stakingVault));
        bool isFresh = uint48(latestReportTs) <= record.report.timestamp && block.timestamp - latestReportTs < 2 days;
        if (!isFresh) {
            _updateVaultData();
        }
    }

    function _updateVaultData() internal {
        address _vault = address(stakingVault);

        // prepare the next report
        VaultHub.VaultRecord memory vaultRecord = vaultHub.vaultRecord(_vault);

        uint256 liabilityShares = vaultHub.liabilityShares(_vault);
        lastReport = VaultReport({
            // Use the actual vault balance for the report to avoid double-counting inOutDelta.
            totalValue: address(stakingVault).balance,
            cumulativeLidoFees: vaultRecord.cumulativeLidoFees + vaultRecord.settledLidoFees + 1, // +1 to ensure non-zero fee delta even when settledLidoFees is 0
            liabilityShares: liabilityShares,
            maxLiabilityShares: Math256.max(vaultRecord.maxLiabilityShares, liabilityShares),
            reportTimestamp: uint64(block.timestamp)
        });

        reportedTotalValue = lastReport.totalValue;

        _report(2); // bypassing fresh report

        lastReport.maxLiabilityShares = liabilityShares; // no minting between reports

        _report(QUARANTINE_PERIOD); // bypassing quarantine period expiration

        // we update the applied total value (TV should go through sanity checks, quarantine, etc.)
        appliedTotalValue = vaultHub.vaultRecord(_vault).report.totalValue;

        //reset otc deposit value
        sv_otcDeposited = 0;

        // Accept ownership if disconnect was successful
        if (stakingVault.pendingOwner() == userAccount) {
            vm.prank(userAccount);
            stakingVault.acceptOwnership();
        }
    }

    function _report(uint256 daysShift) internal {
        address _vault = address(stakingVault);

        // create the leaf for the new report
        bytes32 leaf = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        _vault,
                        lastReport.totalValue,
                        lastReport.cumulativeLidoFees,
                        lastReport.liabilityShares,
                        lastReport.maxLiabilityShares,
                        0 // slashingReserve
                    )
                )
            )
        );

        (uint256 refSlot1, ) = consensusContract.getCurrentFrame();
        uint256 nextRefSlot = refSlot1 + daysShift;
        consensusContract.setCurrentFrame(nextRefSlot);

        vm.warp(block.timestamp + daysShift * 1 days);

        vm.prank(accountingOracle);
        lazyOracle.updateReportData(uint256(block.timestamp), nextRefSlot, leaf, "test");

        // update the vault data after bypassing the quarantine period expiration
        lazyOracle.updateVaultData(
            _vault,
            lastReport.totalValue,
            lastReport.cumulativeLidoFees,
            lastReport.liabilityShares,
            lastReport.maxLiabilityShares,
            0,
            new bytes32[](0) // empty proof, as we are not updating the report data
        );
    }
}
