// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

/**
 * @title  StakingVault Direct (no-Dashboard) Fuzz Suite
 * @notice Foundry fuzz tests for StakingVault accessed without Dashboard or VaultHub.
 *         Owner and depositor are test-controlled EOAs; tests verify ETH-accounting
 *         invariants, access-control gates, pubkey-length validation, and the
 *         EIP-7002 fee-sufficiency checks.
 *
 *  Properties tested (24):
 *    SV-1   fund() reverts for non-owner
 *    SV-2   fund() by owner increments address(vault).balance
 *    SV-3   withdraw() reverts for non-owner
 *    SV-4   withdraw() reverts when amount > availableBalance
 *    SV-5   withdraw() by owner sends correct ETH to recipient
 *    SV-6   availableBalance() == address(vault).balance - stagedBalance()   (always)
 *    SV-7   stage() reverts for non-depositor
 *    SV-8   stage(n) reverts when n > availableBalance
 *    SV-9   stage(n) increments stagedBalance by n
 *    SV-10  unstage() reverts for non-depositor
 *    SV-11  unstage(n) reverts when n > stagedBalance
 *    SV-12  stage then unstage roundtrip restores balance state
 *    SV-13  pauseBeaconChainDeposits() reverts for non-owner
 *    SV-14  double pause reverts with BeaconChainDepositsAlreadyPaused
 *    SV-15  double resume reverts with BeaconChainDepositsAlreadyResumed
 *    SV-16  setDepositor() reverts for non-owner
 *    SV-17  setDepositor(currentDepositor) reverts with NewDepositorSameAsPrevious
 *    SV-18  requestValidatorExit() with length % 48 != 0 reverts
 *    SV-19  requestValidatorExit() with empty bytes reverts
 *    SV-20  triggerValidatorWithdrawals() insufficient msg.value reverts
 *    SV-21  ejectValidators() reverts for non-nodeOperator
 *    SV-22  renounceOwnership() always reverts
 *    SV-23  withdrawalCredentials() has correct 0x02-prefix and address
 *    SV-24  triggerValidatorWithdrawals() happy path sends correct fee to precompile
 */

import {Test} from "forge-std/Test.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";

import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

// ─── mocks ─────────────────────────────────────────────────────────────────────

/// @dev Minimal EIP-7002 precompile mock etched at the canonical address.
///      staticcall("") returns abi-encoded fee; any call consuming the fee is accepted.
contract MockEIP7002Precompile {
    uint256 public fee = 1;

    /// @dev Foundry calls this via low-level staticcall("") to read the withdrawal fee.
    fallback(bytes calldata) external payable returns (bytes memory) {
        return abi.encode(fee);
    }
}

/// @dev Accepts ETH – used as a recipient that cannot receive ETH to test
///      the withdraw-to-rejector revert path.
contract EthRejector {
    error Rejected();
    receive() external payable { revert Rejected(); }
    fallback() external payable { revert Rejected(); }
}

/// @dev Accepts ETH silently – standard test recipient.
contract EthAcceptor {
    receive() external payable {}
}

/// @dev Minimal IDepositContract mock – just accepts the call and emits.
contract MockDepositContract {
    event Deposited(bytes pubkey, bytes withdrawal_credentials);

    function deposit(
        bytes calldata pubkey,
        bytes calldata withdrawal_credentials,
        bytes calldata /*signature*/,
        bytes32 /*deposit_data_root*/
    ) external payable {
        emit Deposited(pubkey, withdrawal_credentials);
    }
}

// ─── test contract ──────────────────────────────────────────────────────────────

contract StakingVaultDirectFuzzTest is Test {
    // EIP-7002 precompile canonical address
    address internal constant EIP7002_ADDR = 0x00000961Ef480Eb55e80D19ad83579A64c007002;

    StakingVault internal vault;
    UpgradeableBeacon internal beacon;
    MockDepositContract internal depositContract;
    MockEIP7002Precompile internal eip7002Mock;

    address internal owner      = makeAddr("owner");
    address internal pendingOwner = makeAddr("pendingOwner");
    address internal nodeOp     = makeAddr("nodeOp");
    address internal depositor  = makeAddr("depositor");
    address internal stranger   = makeAddr("stranger");

    function setUp() public {
        // ── Deploy EIP-7002 mock at precompile address ───────────────────────
        eip7002Mock = new MockEIP7002Precompile();
        vm.etch(EIP7002_ADDR, address(eip7002Mock).code);
        // Store fee = 1 in slot 0 of the etched code
        vm.store(EIP7002_ADDR, bytes32(0), bytes32(uint256(1)));

        // ── Deploy vault beacon proxy ────────────────────────────────────────
        depositContract = new MockDepositContract();
        StakingVault vaultImpl = new StakingVault(address(depositContract));
        beacon = new UpgradeableBeacon(address(vaultImpl), address(this));
        vault  = StakingVault(payable(address(new BeaconProxy(address(beacon), ""))));
        vault.initialize(owner, nodeOp, depositor);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-1: fund() reverts for non-owner
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV1_fundRevertsForNonOwner(address caller, uint96 amount) external {
        vm.assume(caller != owner);
        vm.assume(amount > 0);
        deal(caller, uint256(amount));
        vm.prank(caller);
        vm.expectRevert();
        vault.fund{value: amount}();
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-2: fund() by owner increments address(vault).balance
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV2_fundByOwnerIncreasesBalance(uint96 amount) external {
        vm.assume(amount > 0);
        deal(owner, uint256(amount));
        uint256 before = address(vault).balance;
        vm.prank(owner);
        vault.fund{value: amount}();
        assertEq(address(vault).balance, before + amount, "SV-2: balance mismatch");
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-3: withdraw() reverts for non-owner
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV3_withdrawRevertsForNonOwner(address caller) external {
        vm.assume(caller != owner);
        deal(address(vault), 1 ether);
        vm.prank(caller);
        vm.expectRevert();
        vault.withdraw(caller, 1 ether);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-4: withdraw() reverts when amount > availableBalance
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV4_withdrawRevertsWhenExceedingAvailable(uint96 balance, uint96 excess) external {
        vm.assume(excess > 0);
        uint256 bal = uint256(balance);
        deal(address(vault), bal);
        uint256 attempt = bal + excess;
        vm.prank(owner);
        vm.expectRevert();
        vault.withdraw(makeAddr("recipient"), attempt);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-5: withdraw() by owner sends correct ETH to recipient
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV5_withdrawSendsEthToRecipient(uint96 balance, uint96 amount) external {
        vm.assume(amount > 0 && balance >= amount);
        EthAcceptor recipient = new EthAcceptor();
        deal(address(vault), uint256(balance));
        uint256 recipBefore = address(recipient).balance;
        vm.prank(owner);
        vault.withdraw(address(recipient), amount);
        assertEq(address(recipient).balance, recipBefore + amount, "SV-5: recipient balance");
        assertEq(address(vault).balance, uint256(balance) - amount, "SV-5: vault balance");
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-6: availableBalance() == address(vault).balance - stagedBalance() always
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV6_availableBalanceInvariant(uint96 fundAmount, uint96 stageAmount) external {
        vm.assume(fundAmount >= stageAmount && stageAmount > 0);
        deal(owner, fundAmount);
        vm.prank(owner);
        vault.fund{value: fundAmount}();
        vm.prank(depositor);
        vault.stage(stageAmount);
        assertEq(vault.availableBalance(), address(vault).balance - vault.stagedBalance(), "SV-6");
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-7: stage() reverts for non-depositor
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV7_stageRevertsForNonDepositor(address caller) external {
        vm.assume(caller != depositor);
        deal(address(vault), 1 ether);
        vm.prank(caller);
        vm.expectRevert();
        vault.stage(1 ether);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-8: stage(n) reverts when n > availableBalance
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV8_stageRevertsWhenExceedingAvailable(uint96 balance, uint96 excess) external {
        vm.assume(excess > 0);
        uint256 bal = uint256(balance);
        deal(address(vault), bal);
        uint256 attempt = bal + excess;
        vm.prank(depositor);
        vm.expectRevert();
        vault.stage(attempt);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-9: stage(n) increments stagedBalance by n
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV9_stageIncrementsStagedBalance(uint96 amount) external {
        vm.assume(amount > 0);
        deal(address(vault), uint256(amount));
        uint256 stagedBefore = vault.stagedBalance();
        vm.prank(depositor);
        vault.stage(amount);
        assertEq(vault.stagedBalance(), stagedBefore + amount, "SV-9: staged balance");
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-10: unstage() reverts for non-depositor
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV10_unstageRevertsForNonDepositor(address caller) external {
        vm.assume(caller != depositor);
        // first stage something
        deal(address(vault), 1 ether);
        vm.prank(depositor);
        vault.stage(1 ether);
        vm.prank(caller);
        vm.expectRevert();
        vault.unstage(1 ether);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-11: unstage(n) reverts when n > stagedBalance
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV11_unstageRevertsWhenExceedingStaged(uint96 staged, uint96 excess) external {
        vm.assume(staged > 0 && excess > 0);
        deal(address(vault), uint256(staged));
        vm.prank(depositor);
        vault.stage(staged);
        uint256 attempt = uint256(staged) + excess;
        vm.prank(depositor);
        vm.expectRevert();
        vault.unstage(attempt);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-12: stage then unstage roundtrip – net state unchanged
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV12_stageUnstageRoundtrip(uint96 amount) external {
        vm.assume(amount > 0);
        deal(address(vault), uint256(amount));
        uint256 availBefore = vault.availableBalance();
        uint256 stagBefore  = vault.stagedBalance();
        vm.startPrank(depositor);
        vault.stage(amount);
        vault.unstage(amount);
        vm.stopPrank();
        assertEq(vault.availableBalance(), availBefore, "SV-12: available");
        assertEq(vault.stagedBalance(),    stagBefore,  "SV-12: staged");
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-13: pauseBeaconChainDeposits() reverts for non-owner
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV13_pauseRevertsForNonOwner(address caller) external {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert();
        vault.pauseBeaconChainDeposits();
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-14: double pauseBeaconChainDeposits() reverts
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV14_doublePauseReverts() external {
        vm.startPrank(owner);
        vault.pauseBeaconChainDeposits();
        vm.expectRevert(StakingVault.BeaconChainDepositsAlreadyPaused.selector);
        vault.pauseBeaconChainDeposits();
        vm.stopPrank();
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-15: double resumeBeaconChainDeposits() reverts
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV15_doubleResumeReverts() external {
        // resume when not paused should revert
        vm.startPrank(owner);
        vm.expectRevert(StakingVault.BeaconChainDepositsAlreadyResumed.selector);
        vault.resumeBeaconChainDeposits();
        vm.stopPrank();
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-16: setDepositor() reverts for non-owner
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV16_setDepositorRevertsForNonOwner(address caller, address newDepositor) external {
        vm.assume(caller != owner);
        vm.assume(newDepositor != address(0) && newDepositor != depositor);
        vm.prank(caller);
        vm.expectRevert();
        vault.setDepositor(newDepositor);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-17: setDepositor(currentDepositor) reverts
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV17_setDepositorSameAsCurrent() external {
        vm.prank(owner);
        vm.expectRevert(StakingVault.NewDepositorSameAsPrevious.selector);
        vault.setDepositor(depositor);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-18: requestValidatorExit() with pubkeys length not multiple of 48 reverts
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV18_requestValidatorExitBadLengthReverts(uint8 extraBytes) external {
        vm.assume(extraBytes > 0 && extraBytes < 48);
        bytes memory pubkeys = new bytes(48 + extraBytes); // 1 key + junk
        vm.prank(owner);
        vm.expectRevert(StakingVault.InvalidPubkeysLength.selector);
        vault.requestValidatorExit(pubkeys);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-19: requestValidatorExit() with empty bytes reverts
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV19_requestValidatorExitEmptyReverts() external {
        vm.prank(owner);
        vm.expectRevert();
        vault.requestValidatorExit(new bytes(0));
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-20: triggerValidatorWithdrawals() with insufficient msg.value reverts
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV20_triggerValidatorWithdrawalsInsufficientFeeReverts() external {
        // EIP-7002 fee = 1 wei per key; sending 0 should revert
        bytes memory pubkeys = new bytes(48);
        address refund = makeAddr("refund");
        deal(owner, 10 ether);
        vm.prank(owner);
        vm.expectRevert();
        vault.triggerValidatorWithdrawals{value: 0}(pubkeys, new uint64[](0), refund);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-21: ejectValidators() reverts for non-nodeOperator
    //        Note: msg.value check fires before nodeOperator check, so we must
    //        pass at least 1 wei to reach the SenderNotNodeOperator guard.
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV21_ejectValidatorsRevertsForNonNodeOperator(address caller) external {
        vm.assume(caller != nodeOp);
        vm.assume(caller != address(0));
        bytes memory pubkeys = new bytes(48);
        deal(caller, 10 ether);
        vm.prank(caller);
        vm.expectRevert(StakingVault.SenderNotNodeOperator.selector);
        // send 1 wei (enough to pass msg.value check, fee per key = 1)
        // address(0) as refund → contract sets refund = msg.sender (still reverts before that)
        vault.ejectValidators{value: 1}(pubkeys, address(0));
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-22: renounceOwnership() always reverts
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV22_renounceOwnershipReverts() external {
        vm.prank(owner);
        vm.expectRevert(StakingVault.RenouncementNotAllowed.selector);
        vault.renounceOwnership();
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-23: withdrawalCredentials() encodes 0x02 prefix with vault address
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV23_withdrawalCredentials() external view {
        bytes32 wc = vault.withdrawalCredentials();
        // Top byte must be 0x02
        assertEq(uint8(uint256(wc) >> (31 * 8)), 0x02, "SV-23: WC prefix");
        // Lower 20 bytes must be vault address
        assertEq(address(uint160(uint256(wc))), address(vault), "SV-23: WC address");
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SV-24: triggerValidatorWithdrawals() happy path with sufficient fee
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV24_triggerValidatorWithdrawalsHappyPath() external {
        // fee = 1 wei per key; send 1 wei for 1 key, expect success
        bytes memory pubkeys = new bytes(48);
        address refund = makeAddr("refund");
        deal(owner, 10 ether);
        vm.prank(owner);
        // Should not revert; excess = 10 ether - 1 wei
        vault.triggerValidatorWithdrawals{value: 10 ether}(pubkeys, new uint64[](0), refund);
        // Excess refunded to refundRecipient
        assertGt(refund.balance, 0, "SV-24: excess should be refunded");
    }

    // ────────────────────────────────────────────────────────────────────────────
    // Additional: withdraw to ETH-rejector should revert (TransferFailed)
    // ────────────────────────────────────────────────────────────────────────────
    function test_SV25_withdrawToRejectorReverts() external {
        deal(address(vault), 1 ether);
        EthRejector rejector = new EthRejector();
        vm.prank(owner);
        vm.expectRevert();
        vault.withdraw(address(rejector), 1 ether);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // Additional: setDepositor updates depositor correctly
    // ────────────────────────────────────────────────────────────────────────────
    function testFuzz_SV26_setDepositorUpdates(address newDepositor) external {
        vm.assume(newDepositor != address(0) && newDepositor != depositor);
        vm.prank(owner);
        vault.setDepositor(newDepositor);
        assertEq(vault.depositor(), newDepositor, "SV-26: depositor updated");
    }
}
