// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
//                                           ┌────────────────────┐
//                                           │                    │
//                                           │       Owner        │
//                                           │                    │
//                                           └──┬──────────────┬──┘
//                                              │              │
//                                           fund           withdraw
//                                       SV.balance += x  SV.balance -= x
//                                       inOutDelta += x  inOutDelta -= x
//                                              │              │
//                                              │              │
//   ┌──────────────────┐──report(old data)──▶┌─▼──────────────▼─┐    depositToBeaconChain   ┌───────────────────────┐
//   │                  │                     │                  │◀───SV.balance -= deposit──│       Depositor       │
//   │                  │     rebalance       │                  │                           └───────────────────────┘
//   │     VaultHub     │─  SV.balance -= x──▶│   StakingVault   │
//   │                  │   inOutDelta -= x   │                  │           rewards         ┌───────────────────────┐
//   │                  │                     │                  │◀───SV.balance += reward───│       Validator       │
//   └──────────────────┘───────lock─────────▶└──────────────────┘                           └───────────────────────┘

pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {DepositContract__MockForStakingVault} from "./contracts/DepositContract__MockForStakingVault.sol";
import {RandomLib} from "./RandomLib.sol";

contract VaultHubMock is Test {
    using RandomLib for RandomLib.Storage;

    uint256 constant TOTAL_BASIS_POINTS = 10000;
    uint256 constant MAX_MINTABLE_RATIO_BP = 8000; // 80% can be used for minting (100% - reserve ratio)
    uint256 constant RESERVE_RATIO_BP = 1000; // 10% reserve ratio
    uint256 constant REWARD_RATE_MIN_BP = 100; // 1% min reward rate
    uint256 constant REWARD_RATE_MAX_BP = 500; // 5% max reward rate
    uint256 constant TREASURY_FEE_BP = 500; // 5% treasury fee
    uint256 constant REBALANCE_THRESHOLD_BP = 9500; // 95% - vault needs rebalance if valuation drops below this

    RandomLib.Storage private rnd;

    constructor(uint256 _seed) {
        rnd.seed = _seed;
    }

    function getTotalEtherToLock(uint256 vaultValuation) public returns (uint256) {
        uint256 maxMintableEther = (vaultValuation * MAX_MINTABLE_RATIO_BP) / TOTAL_BASIS_POINTS;
        uint256 amountToMint = rnd.randInt(maxMintableEther);
        return (amountToMint * TOTAL_BASIS_POINTS) / MAX_MINTABLE_RATIO_BP;
    }

    function getNewValuation(uint256 currentValuation) public returns (uint256) {
        uint256 rewardRateBP = REWARD_RATE_MIN_BP + rnd.randInt(REWARD_RATE_MAX_BP - REWARD_RATE_MIN_BP);
        uint256 newValuation = currentValuation + (currentValuation * rewardRateBP) / TOTAL_BASIS_POINTS;
        uint256 treasuryFee = ((newValuation - currentValuation) * TREASURY_FEE_BP) / TOTAL_BASIS_POINTS;
        newValuation -= treasuryFee;
        return newValuation;
    }

    function getNewLocked(uint256 currentLocked) public returns (uint256) {
        return rnd.randInt(currentLocked / 2, currentLocked);
    }

    function getAmountToUnlock(uint256 currentValuation, uint256 currentLocked) public pure returns (uint256) {
        uint256 minRequiredValuation = (currentLocked * TOTAL_BASIS_POINTS) / RESERVE_RATIO_BP;
        uint256 rebalanceThreshold = (minRequiredValuation * REBALANCE_THRESHOLD_BP) / TOTAL_BASIS_POINTS;

        if (currentValuation >= rebalanceThreshold) {
            return 0;
        }

        uint256 targetLocked = (currentValuation * RESERVE_RATIO_BP) / TOTAL_BASIS_POINTS;
        return currentLocked - targetLocked;
    }
}

contract ValidatorMock is Test {
    using RandomLib for RandomLib.Storage;

    uint256 constant SECONDS_PER_DAY = 86400;
    uint256 constant APR_DENOMINATOR = 10000;
    uint256 constant DAYS_PER_YEAR = 365;
    uint256 constant APR_MIN = 300; // 3.00% minimum APR
    uint256 constant APR_MAX = 500; // 5.00% maximum APR
    uint256 constant MIN_VALIDATOR_BALANCE = 32 ether;

    uint256 private currentAPR;
    uint256 private lastRewardTimestamp;

    RandomLib.Storage private rnd;

    constructor(uint256 _seed) {
        rnd.seed = _seed;
        lastRewardTimestamp = block.timestamp;
        currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
    }

    function getDailyReward() public returns (uint256) {
        uint256 timePassed = block.timestamp - lastRewardTimestamp;
        if (timePassed < SECONDS_PER_DAY) {
            return 0;
        }

        uint256 daysPassed = timePassed / SECONDS_PER_DAY;
        lastRewardTimestamp += daysPassed * SECONDS_PER_DAY;

        uint256 yearlyReward = (MIN_VALIDATOR_BALANCE * currentAPR) / APR_DENOMINATOR;
        uint256 dailyReward = (yearlyReward * daysPassed) / DAYS_PER_YEAR;

        int256 randomVariation = int256(rnd.randInt(200)) - 100;
        dailyReward = uint256((int256(dailyReward) * (1000 + randomVariation)) / 1000);

        if (rnd.randBool()) {
            currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
        }

        return dailyReward;
    }
}

contract StakingVaultTest is Test {
    using RandomLib for RandomLib.Storage;

    error LockedCannotDecreaseOutsideOfReport(uint256 currentlyLocked, uint256 attemptedLocked);
    error NotAuthorized(string operation, address sender);
    error ZeroArgument(string name);
    error InsufficientBalance(uint256 balance);
    error RebalanceAmountExceedsValuation(uint256 valuation, uint256 rebalanceAmount);

    uint256 constant ITERATIONS = 32;
    uint256 constant MAJOR_STATE_TRANSITIONS = 32;
    uint256 constant VALIDATOR_DEPOSIT = 32 ether;
    uint256 constant CONNECT_DEPOSIT = 1 ether;
    uint256 constant SECONDS_PER_DAY = 86400;

    StakingVault private stakingVault;
    StakingVault private stakingVaultProxy;
    VaultHubMock private vaultHub;
    ValidatorMock private validator;

    uint256 private deposits;
    uint256 private withdrawals;
    uint256 private rewards;
    uint256 private randomUserDeposits;
    uint256 private depositsToBeaconChain;

    address private depositor = address(0x001);
    address private owner = address(0x002);
    address private nodeOperator = address(0x003);
    address private user = address(0x004);

    RandomLib.Storage private rnd;

    bool private isConnectedToHub;
    bool private hasValidator;

    function testSolvencyAllTransitions() external {
        runTests(42);
    }

    function testFuzz_SolvencyAllTransitions(uint256 _seed) external {
        runTests(_seed);
    }

    function runTests(uint256 _seed) internal {
        require(
            MAJOR_STATE_TRANSITIONS * ITERATIONS * 10 ** 25 * 2 <= type(uint256).max,
            "MAJOR_STATE_TRANSITIONS * ITERATIONS overflow"
        );
        deploy(_seed);

        uint256 initialBalance = address(stakingVaultProxy).balance;
        int256 initialInOutDelta = stakingVaultProxy.inOutDelta();

        for (uint256 i = 0; i < MAJOR_STATE_TRANSITIONS; i++) {
            performMajorStateTransition(hasValidator, isConnectedToHub);
            for (uint256 iterationIdx = 0; iterationIdx < ITERATIONS; iterationIdx++) {
                randomTransition(hasValidator, isConnectedToHub);
            }
        }

        uint256 finalBalance = address(stakingVaultProxy).balance;
        int256 finalInOutDelta = stakingVaultProxy.inOutDelta();

        assertEq(
            deposits + initialBalance + rewards + randomUserDeposits,
            finalBalance + withdrawals + depositsToBeaconChain
        );
        assertEq(initialInOutDelta + int256(deposits), finalInOutDelta + int256(withdrawals));
    }

    function deploy(uint256 _seed) public {
        rnd.seed = _seed;
        isConnectedToHub = false;
        hasValidator = false;
        deposits = 0;
        withdrawals = 0;
        rewards = 0;
        randomUserDeposits = 0;
        depositsToBeaconChain = 0;

        DepositContract__MockForStakingVault depositContract = new DepositContract__MockForStakingVault();
        vaultHub = new VaultHubMock(_seed);
        validator = new ValidatorMock(_seed);
        stakingVault = new StakingVault(address(vaultHub), depositor, address(depositContract));

        ERC1967Proxy proxy = new ERC1967Proxy(
            address(stakingVault),
            abi.encodeWithSelector(StakingVault.initialize.selector, owner, nodeOperator, "0x")
        );
        stakingVaultProxy = StakingVault(payable(address(proxy)));
    }

    function performMajorStateTransition(bool _hasValidator, bool _isConnectedToHub) internal {
        bool oldIsConnectedToHub = _isConnectedToHub;
        bool oldHasValidator = _hasValidator;

        hasValidator = rnd.randBool();
        isConnectedToHub = rnd.randBool();

        if (oldIsConnectedToHub != isConnectedToHub) {
            if (isConnectedToHub) {
                transitionConnectVaultToHub();
            } else if (!isConnectedToHub) {
                transitionDisconnectVaultFromHub();
            }
        }

        if (oldHasValidator != hasValidator) {
            if (hasValidator) {
                transitionDepositToBeaconChain();
            } else if (!hasValidator) {
                transitionValidatorExitAndReturnDeposit();
            }
        }
    }

    function randomTransition(bool _hasValidator, bool _isConnectedToHub) internal {
        vm.warp(block.timestamp + rnd.randInt(2 * SECONDS_PER_DAY));
        function() internal[] memory availableTransitions = getAvailableTransitions(_hasValidator, _isConnectedToHub);
        uint256 transitionIndex = rnd.randInt(availableTransitions.length - 1);
        availableTransitions[transitionIndex]();
    }

    function baseTransitions() internal pure returns (function() internal[] memory) {
        function() internal[] memory transitions = new function() internal[](3);
        transitions[0] = transitionRandomFund;
        transitions[1] = transitionRandomWithdraw;
        transitions[2] = transitionRandomUserDeposit;
        return transitions;
    }

    function validatorTransitions() internal pure returns (function() internal[] memory) {
        function() internal[] memory transitions = new function() internal[](1);
        transitions[0] = transitionRandomReceiveReward;
        return transitions;
    }

    function vaultHubTransitions() internal pure returns (function() internal[] memory) {
        function() internal[] memory transitions = new function() internal[](3);
        transitions[0] = transitionRandomMintShares;
        transitions[1] = transitionRandomReport;
        transitions[2] = transitionRandomRebalance;
        return transitions;
    }

    function mergeTransitions(
        function() internal[] memory _transitionsA,
        function() internal[] memory _transitionsB
    ) internal pure returns (function() internal[] memory) {
        function() internal[] memory result = new function() internal[](_transitionsA.length + _transitionsB.length);
        for (uint256 txIdx = 0; txIdx < _transitionsA.length; txIdx++) {
            result[txIdx] = _transitionsA[txIdx];
        }
        for (uint256 txIdx = 0; txIdx < _transitionsB.length; txIdx++) {
            result[_transitionsA.length + txIdx] = _transitionsB[txIdx];
        }
        return result;
    }

    function getAvailableTransitions(
        bool _hasValidator,
        bool _isConnectedToHub
    ) internal pure returns (function() internal[] memory) {
        if (_hasValidator && _isConnectedToHub) {
            return mergeTransitions(baseTransitions(), mergeTransitions(validatorTransitions(), vaultHubTransitions()));
        } else if (_hasValidator && !_isConnectedToHub) {
            return mergeTransitions(validatorTransitions(), baseTransitions());
        } else if (!_hasValidator && _isConnectedToHub) {
            return mergeTransitions(baseTransitions(), vaultHubTransitions());
        } else {
            return baseTransitions();
        }
    }

    function transitionRandomUserDeposit() internal {
        console2.log("------Deposit by random user------");

        uint256 amount = rnd.randAmountD18();
        console2.log("Deposit by random user %d", amount);

        address randomUser = rnd.randAddress();
        deal(randomUser, amount);
        if (amount == 0) {
            vm.expectRevert(abi.encodeWithSelector(ZeroArgument.selector, "msg.value"));
        }
        vm.prank(randomUser);
        payable(address(stakingVaultProxy)).transfer(amount);
        vm.stopPrank();
        randomUserDeposits += amount;
    }

    function transitionRandomFund() internal {
        console2.log("------Fund vault------");

        uint256 amount = rnd.randAmountD18();
        console2.log("Fund vault %d", amount);

        deal(owner, amount);
        if (amount == 0) {
            vm.expectRevert(abi.encodeWithSelector(ZeroArgument.selector, "msg.value"));
        }
        vm.startPrank(owner);
        stakingVaultProxy.fund{value: amount}();
        vm.stopPrank();
        deposits += amount;
    }

    function transitionRandomWithdraw() internal {
        console2.log("------Withdraw funds------");

        uint256 unlocked = stakingVaultProxy.unlocked();
        uint256 vaultBalance = address(stakingVaultProxy).balance;
        uint256 minWithdrawal = Math.min(unlocked, vaultBalance);
        uint256 withdrawableAmount = rnd.randInt(minWithdrawal);
        console2.log("Withdraw funds %d", withdrawableAmount);

        deal(owner, withdrawableAmount);
        if (withdrawableAmount == 0) {
            vm.expectRevert(abi.encodeWithSelector(ZeroArgument.selector, "_ether"));
        }
        vm.prank(owner);
        stakingVaultProxy.withdraw(owner, withdrawableAmount);
        vm.stopPrank();
        withdrawals += withdrawableAmount;
    }

    function transitionRandomReceiveReward() internal {
        console2.log("------Receive reward------");

        uint256 dailyReward = validator.getDailyReward();
        console2.log("Receive reward %d", dailyReward);
        vm.deal(address(stakingVaultProxy), address(stakingVaultProxy).balance + dailyReward);
        rewards += dailyReward;
    }

    function transitionDepositToBeaconChain() internal {
        console2.log("------Deposit to Beacon Chain and start simulating validator------");

        deal(owner, VALIDATOR_DEPOSIT);
        vm.prank(owner);
        stakingVaultProxy.fund{value: VALIDATOR_DEPOSIT}();
        vm.stopPrank();
        deposits += VALIDATOR_DEPOSIT;

        IStakingVault.Deposit[] memory newDeposits = new IStakingVault.Deposit[](1);

        bytes memory pubkey = new bytes(48);
        bytes32 firstPart = bytes32(uint256(1));
        bytes16 secondPart = bytes16(bytes32(uint256(2)));

        assembly {
            mstore(add(pubkey, 32), firstPart)
            mstore(add(pubkey, 64), secondPart)
        }

        newDeposits[0] = IStakingVault.Deposit({
            pubkey: pubkey,
            signature: bytes.concat(bytes32(uint256(2))),
            amount: VALIDATOR_DEPOSIT,
            depositDataRoot: bytes32(uint256(3))
        });
        vm.prank(depositor);
        stakingVaultProxy.depositToBeaconChain(newDeposits);
        vm.stopPrank();

        depositsToBeaconChain += VALIDATOR_DEPOSIT;
    }

    function transitionValidatorExitAndReturnDeposit() internal {
        console2.log("------Validator exit and return deposit------");

        deal(address(stakingVaultProxy), address(stakingVaultProxy).balance + VALIDATOR_DEPOSIT);
        depositsToBeaconChain -= VALIDATOR_DEPOSIT;
    }

    function transitionRandomDepositToBeaconChain() internal {
        console2.log("------Deposit to Beacon Chain------");

        uint256 amount = rnd.randAmountD18();
        console2.log("Deposit to Beacon Chain %d", amount);

        bytes memory pubkey = new bytes(48);
        bytes32 firstPart = bytes32(uint256(1));
        bytes16 secondPart = bytes16(bytes32(uint256(2)));

        assembly {
            mstore(add(pubkey, 32), firstPart)
            mstore(add(pubkey, 64), secondPart)
        }

        IStakingVault.Deposit[] memory newDeposits = new IStakingVault.Deposit[](1);
        newDeposits[0] = IStakingVault.Deposit({
            pubkey: pubkey,
            signature: bytes.concat(bytes32(uint256(2))),
            amount: amount,
            depositDataRoot: bytes32(uint256(3))
        });

        vm.prank(depositor);
        stakingVaultProxy.depositToBeaconChain(newDeposits);
        vm.stopPrank();

        depositsToBeaconChain += amount;
    }

    function transitionConnectVaultToHub() internal {
        console2.log("------Connect Vault to Hub------");

        vm.prank(address(vaultHub));
        stakingVaultProxy.lock(CONNECT_DEPOSIT);

        assertEq(stakingVaultProxy.locked(), CONNECT_DEPOSIT);
    }

    function transitionDisconnectVaultFromHub() internal {
        console2.log("------Disconnect Vault from Hub------");

        uint256 valuation = stakingVaultProxy.valuation();
        int256 inOutDelta = stakingVaultProxy.inOutDelta();

        vm.prank(address(vaultHub));
        stakingVaultProxy.report(valuation, inOutDelta, 0);

        assertEq(stakingVaultProxy.locked(), 0);
    }

    function transitionRandomMintShares() internal {
        console2.log("------Mint shares------");

        uint256 vaultValuation = stakingVaultProxy.valuation();
        uint256 totalEtherToLock = vaultHub.getTotalEtherToLock(vaultValuation);
        console2.log("Mint shares %d", totalEtherToLock);

        uint256 currentLocked = stakingVaultProxy.locked();
        if (totalEtherToLock < currentLocked) {
            vm.expectRevert(
                abi.encodeWithSelector(LockedCannotDecreaseOutsideOfReport.selector, currentLocked, totalEtherToLock)
            );
        }

        vm.prank(address(vaultHub));
        stakingVaultProxy.lock(totalEtherToLock);
    }

    function transitionRandomReport() internal {
        console2.log("------Receive report------");

        uint256 currentValuation = stakingVaultProxy.valuation();
        int256 currentInOutDelta = stakingVaultProxy.inOutDelta();
        uint256 currentLocked = stakingVaultProxy.locked();

        uint256 newValuation = vaultHub.getNewValuation(currentValuation);
        uint256 newLocked = vaultHub.getNewLocked(currentLocked);

        vm.prank(address(vaultHub));
        stakingVaultProxy.report(newValuation, currentInOutDelta, newLocked);
    }

    function transitionRandomRebalance() internal {
        console2.log("------Rebalance------");

        uint256 currentValuation = stakingVaultProxy.valuation();
        uint256 currentBalance = address(stakingVaultProxy).balance;
        uint256 currentLocked = stakingVaultProxy.locked();
        uint256 etherToRebalance = vaultHub.getAmountToUnlock(currentValuation, currentLocked);
        console2.log("Rebalance %d", etherToRebalance);

        if (etherToRebalance == 0) {
            vm.expectRevert(abi.encodeWithSelector(ZeroArgument.selector, "_ether"));
        } else if (etherToRebalance > currentBalance) {
            vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, currentBalance));
        } else if (etherToRebalance > currentValuation) {
            vm.expectRevert(
                abi.encodeWithSelector(RebalanceAmountExceedsValuation.selector, currentValuation, etherToRebalance)
            );
        } else if (currentValuation >= currentLocked) {
            vm.expectRevert(abi.encodeWithSelector(NotAuthorized.selector, "rebalance", address(vaultHub)));
        }
        vm.prank(address(vaultHub));
        stakingVaultProxy.rebalance(etherToRebalance);
        vm.stopPrank();
    }
}
