// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import "forge-std/Test.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {DepositContract__MockForStakingVault} from "./contracts/DepositContract__MockForStakingVault.sol";
import {VaultHub__MockForStakingVault} from "./contracts/VaultHub__MockForStakingVault.sol";
import {RandomLib} from "./RandomLib.sol";
import {console2} from "forge-std/console2.sol";

contract StakingVaultTest is Test {
    using RandomLib for RandomLib.Storage;

    enum VaultState {
        NoDepositsToBeaconChain,
        DepositToBeaconChain
    }

    uint256 constant ITERATIONS = 32;
    uint256 constant MIN_REWARD = 0.001 ether;
    uint256 constant MIN_FUND = 0.001 ether;
    uint256 constant APR_MIN = 300; // 3.00% minimum APR
    uint256 constant APR_MAX = 500; // 5.00% maximum APR
    uint256 constant SECONDS_PER_DAY = 86400;
    uint256 constant DAYS_PER_YEAR = 365;
    uint256 constant APR_DENOMINATOR = 10000;

    StakingVault private stakingVault;
    StakingVault private stakingVaultProxy;
    VaultHub__MockForStakingVault private vaultHub;

    address[] private depositors;
    uint256 private deposits;
    uint256 private withdrawals;
    uint256 private validatorBalance;
    uint256 private rewards;

    RandomLib.Storage private rnd = RandomLib.Storage(42);

    address private depositor = address(0x001);
    address private owner = address(0x002);
    address private nodeOperator = address(0x003);
    address private user = address(0x004);

    VaultState private vaultState;
    mapping(VaultState => function() internal[]) internal stateTransitions;

    uint256 private lastRewardTimestamp;
    uint256 private currentAPR;

    function setUp() public {
        rnd.seed = vm.unixTime();
        vaultState = VaultState.NoDepositsToBeaconChain;
        initializeTransitions();
        initializeRewards();
    }

    function testSolvencyAllTransitions() external {
        deploy();

        uint256 initialBalance = address(stakingVaultProxy).balance;
        int256 initialInOutDelta = stakingVaultProxy.inOutDelta();

        for (uint256 iterationIdx = 0; iterationIdx < ITERATIONS; iterationIdx++) {
            randomTransition(VaultState.NoDepositsToBeaconChain);
        }

        transitionDepositToBeaconChain();

        for (uint256 iterationIdx = 0; iterationIdx < ITERATIONS; iterationIdx++) {
            randomTransition(VaultState.DepositToBeaconChain);
        }

        transitionValidatorWithdraw();

        for (uint256 iterationIdx = 0; iterationIdx < ITERATIONS; iterationIdx++) {
            randomTransition(VaultState.NoDepositsToBeaconChain);
        }

        uint256 finalBalance = address(stakingVaultProxy).balance;
        int256 finalInOutDelta = stakingVaultProxy.inOutDelta();
        assertEq(deposits - withdrawals, finalBalance - initialBalance - rewards);

        console2.log("deltaBalance: %s", finalBalance - initialBalance);
        console2.log("deltaDeposits: %s", deposits - withdrawals);
        console2.log("deltaInOutDelta: %s", finalInOutDelta - initialInOutDelta);
    }

    function initializeTransitions() internal {
        function() internal[] memory noValidatorDepositsTransitions = new function() internal[](2);
        noValidatorDepositsTransitions[0] = transitionRandomFund;
        noValidatorDepositsTransitions[1] = transitionRandomWithdraw;
        stateTransitions[VaultState.NoDepositsToBeaconChain] = noValidatorDepositsTransitions;

        function() internal[] memory withValidatorDepositsTransitions = new function() internal[](3);
        withValidatorDepositsTransitions[0] = transitionRandomFund;
        withValidatorDepositsTransitions[1] = transitionRandomWithdraw;
        withValidatorDepositsTransitions[2] = transitionRandomReceiveReward;
        stateTransitions[VaultState.DepositToBeaconChain] = withValidatorDepositsTransitions;
    }

    function initializeRewards() internal {
        lastRewardTimestamp = block.timestamp;
        currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
    }

    function deploy() public {
        DepositContract__MockForStakingVault depositContract = new DepositContract__MockForStakingVault();
        vaultHub = new VaultHub__MockForStakingVault();
        stakingVault = new StakingVault(address(vaultHub), depositor, address(depositContract));
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(stakingVault),
            abi.encodeWithSelector(StakingVault.initialize.selector, owner, nodeOperator, "0x")
        );
        stakingVaultProxy = StakingVault(payable(address(proxy)));
    }

    function randomTransition(VaultState state) internal {
        vm.warp(block.timestamp + rnd.randInt(2 * SECONDS_PER_DAY));
        function() internal[] storage availableTransitions = stateTransitions[state];
        uint256 transitionIndex = rnd.randInt(availableTransitions.length - 1);
        availableTransitions[transitionIndex]();
    }

    function transitionRandomReceive() internal {
        uint256 amount = rnd.randAmountD18();
        if (amount == 0) {
            amount = MIN_FUND;
        }

        uint256 userIndex;
        if (rnd.randBool() || depositors.length == 0) {
            address randomUser = rnd.randAddress();
            depositors.push(randomUser);
            userIndex = depositors.length - 1;
        } else {
            userIndex = rnd.randInt(0, depositors.length - 1);
        }

        address user = depositors[userIndex];
        deal(user, amount);

        vm.prank(user);
        payable(address(stakingVaultProxy)).transfer(amount);
        vm.stopPrank();

        console2.log("transitionRandomReceive: %d", amount);
    }

    function transitionRandomFund() internal {
        uint256 amount = rnd.randAmountD18();
        if (amount == 0) {
            amount = MIN_FUND;
        }

        deal(owner, amount);
        deposits += amount;

        vm.startPrank(owner);
        stakingVaultProxy.fund{value: amount}();
        vm.stopPrank();

        console2.log("transitionRandomFund: %s", amount);
    }

    function transitionRandomWithdraw() internal {
        uint256 availableAmount = stakingVaultProxy.unlocked();
        if (availableAmount == 0) {
            return;
        }
        uint256 withdrawableAmount = rnd.randInt(availableAmount);
        if (withdrawableAmount == 0) {
            withdrawableAmount = availableAmount;
        }

        deal(owner, withdrawableAmount);
        withdrawals += withdrawableAmount;

        vm.prank(owner);
        stakingVaultProxy.withdraw(owner, withdrawableAmount);
        vm.stopPrank();

        console2.log("transitionRandomWithdraw: %d", withdrawableAmount);
    }

    function transitionRandomReceiveReward() internal {
        uint256 timePassed = block.timestamp - lastRewardTimestamp;
        if (timePassed < SECONDS_PER_DAY) {
            return;
        }

        uint256 dailyReward = dailyReward(timePassed);

        if (rnd.randBool()) {
            currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
        }

        rewards += dailyReward;
        vm.deal(address(stakingVaultProxy), address(stakingVaultProxy).balance + dailyReward);
    }

    function dailyReward(uint256 timePassed) internal returns (uint256) {
        uint256 daysPassed = timePassed / SECONDS_PER_DAY;
        lastRewardTimestamp += daysPassed * SECONDS_PER_DAY;

        uint256 validatorBalance = 32 ether;
        uint256 yearlyReward = (validatorBalance * currentAPR) / APR_DENOMINATOR;
        uint256 dailyReward = (yearlyReward * daysPassed) / DAYS_PER_YEAR;

        int256 randomVariation = int256(rnd.randInt(200)) - 100;
        dailyReward = uint256((int256(dailyReward) * (1000 + randomVariation)) / 1000);

        console2.log("transitionRandomReceiveReward: days=%d, apr=%d, reward=%d", daysPassed, currentAPR, dailyReward);

        return dailyReward;
    }

    function transitionDepositToBeaconChain() internal {
        console2.log("-------------------------------- transitionDepositToBeaconChain--------------------------------");

        vm.warp(block.timestamp + rnd.randInt(2 * SECONDS_PER_DAY));

        vm.prank(owner);
        deal(owner, 32 ether);
        stakingVaultProxy.fund{value: 32 ether}();
        deposits += 32 ether;
        vm.stopPrank();

        vm.prank(depositor);
        IStakingVault.Deposit[] memory deposits = new IStakingVault.Deposit[](1);
        deposits[0] = IStakingVault.Deposit({
            pubkey: bytes.concat(bytes32(uint256(1))),
            signature: bytes.concat(bytes32(uint256(2))),
            amount: 32 ether,
            depositDataRoot: bytes32(uint256(3))
        });
        stakingVaultProxy.depositToBeaconChain(deposits);
        withdrawals += 32 ether;
    }

    function transitionValidatorWithdraw() internal {
        console2.log("-------------------------------- transitionValidatorWithdraw--------------------------------");

        vm.warp(block.timestamp + rnd.randInt(2 * SECONDS_PER_DAY));

        vm.deal(address(stakingVaultProxy), address(stakingVaultProxy).balance + 32 ether);
        deposits -= 32 ether;

        vm.prank(owner);
        stakingVaultProxy.withdraw(owner, 32 ether);
        vm.stopPrank();
        withdrawals -= 32 ether;
    }

    function transitionRandomDepositToBeaconChain() internal {
        vm.prank(depositor);
        IStakingVault.Deposit[] memory deposits = new IStakingVault.Deposit[](1);
        deposits[0] = IStakingVault.Deposit({
            pubkey: bytes.concat(bytes32(uint256(1))),
            signature: bytes.concat(bytes32(uint256(2))),
            amount: 0.1 ether,
            depositDataRoot: bytes32(uint256(3))
        });
        stakingVaultProxy.depositToBeaconChain(deposits);
    }
}
