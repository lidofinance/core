// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
//                                           ┌────────────────────┐
//                                           │                    │
//                                           │       Owner        │
//                                           │                    │
//                                           └──┬──────────────▲──┘
//                                              │              │
//                                           fund           withdraw
//                                       SV.balance += x  SV.balance -= x
//                                       inOutDelta += x  inOutDelta -= x
//                                              │              │
//                                              │              │
//   ┌──────────────────┐──report(old data)──▶┌─▼──────────────┴─┐   depositToBeaconChain    ┌───────────────────────┐
//   │                  │                     │                  │───SV.balance -= deposit──▶│       Depositor       │
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
import {StakingVaultDeposit} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {DepositContract__MockForStakingVault} from "./contracts/DepositContract__MockForStakingVault.sol";
import {RandomLib} from "./RandomLib.sol";

contract LidoLocatorMock is Test {
    address private depositor;

    constructor(address _depositor) {
        depositor = _depositor;
    }

    function predepositGuarantee() public view returns (address) {
        return depositor;
    }
}

contract VaultHubMock is Test {
    event Mock__Rebalanced(address indexed vault, uint256 amount);

    using RandomLib for RandomLib.Storage;

    uint256 constant TOTAL_BASIS_POINTS = 10000;
    uint256 constant RESERVE_RATIO_BP = 1000; // 10% reserve ratio
    uint256 constant REWARD_RATE_MIN_BP = 100; // 1% min reward rate
    uint256 constant REWARD_RATE_MAX_BP = 500; // 5% max reward rate
    uint256 constant TREASURY_FEE_BP = 500; // 5% treasury fee
    uint256 constant REBALANCE_THRESHOLD_BP = 9500; // 95% - vault needs rebalance if valuation drops below this
    uint256 constant CONNECT_DEPOSIT = 1 ether;
    uint256 constant SECONDS_PER_DAY = 86400;
    uint256 constant DAYS_PER_YEAR = 365;

    LidoLocatorMock private lidoLocator;
    RandomLib.Storage private rnd;

    uint256 private lastRewardTimestamp;
    uint256 private currentAPR;

    constructor(uint256 _seed, address _lidoLocator) {
        rnd.seed = _seed;
        lidoLocator = LidoLocatorMock(_lidoLocator);
        lastRewardTimestamp = block.timestamp;
        currentAPR = REWARD_RATE_MIN_BP + rnd.randInt(REWARD_RATE_MAX_BP - REWARD_RATE_MIN_BP);
    }

    function LIDO_LOCATOR() public view returns (LidoLocatorMock) {
        return lidoLocator;
    }

    function REPORT_FRESHNESS_DELTA() public pure returns (uint256) {
        return 1 days;
    }

    function maxMintableEther(uint256 vaultValuation) public returns (uint256) {
        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - RESERVE_RATIO_BP;
        return (vaultValuation * maxMintableRatioBP) / TOTAL_BASIS_POINTS;
    }

    function protocolDaylyReward() public returns (uint256) {
        uint256 timePassed = block.timestamp - lastRewardTimestamp;
        if (timePassed < SECONDS_PER_DAY) {
            return 0;
        }

        uint256 daysPassed = timePassed / SECONDS_PER_DAY;
        lastRewardTimestamp += daysPassed * SECONDS_PER_DAY;
        uint256 dailyReward = (CONNECT_DEPOSIT * currentAPR * daysPassed) / (TOTAL_BASIS_POINTS * DAYS_PER_YEAR);
        int256 randomVariation = int256(rnd.randInt(200)) - 100;
        dailyReward = uint256((int256(dailyReward) * (1000 + randomVariation)) / 1000);
        currentAPR = REWARD_RATE_MIN_BP + rnd.randInt(REWARD_RATE_MAX_BP - REWARD_RATE_MIN_BP);

        return dailyReward;
    }

    function newLockedEther(uint256 valuation) public returns (uint256) {
        uint256 maxMintableEther = maxMintableEther(valuation);
        uint256 protocolDaylyReward = protocolDaylyReward();
        return Math.max(CONNECT_DEPOSIT, maxMintableEther + protocolDaylyReward);
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

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.sender, msg.value);
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

    error NewLockedNotGreaterThanCurrent();
    error NotAuthorized(string operation, address sender);
    error ZeroArgument(string name);
    error InsufficientBalance(uint256 balance);
    error RebalanceAmountExceedsTotalValue(uint256 valuation, uint256 rebalanceAmount);

    uint256 constant ITERATIONS = 32;
    uint256 constant MAJOR_STATE_TRANSITIONS = 32;
    uint256 constant VALIDATOR_DEPOSIT = 32 ether;
    uint256 constant CONNECT_DEPOSIT = 1 ether;
    uint256 constant SECONDS_PER_DAY = 86400;
    uint256 constant MIN_DEPOSIT = 0.3 ether;
    uint256 constant MIN_FUND_AMOUNT = 0.2 ether;
    uint256 constant MIN_WITHDRAWAL = 0.1 ether;

    StakingVault private stakingVault;
    StakingVault private stakingVaultProxy;
    VaultHubMock private vaultHub;
    ValidatorMock private validator;

    uint256 private deposits;
    uint256 private withdrawals;
    uint256 private rewards;
    uint256 private randomUserDeposits;
    uint256 private depositsToBeaconChain;
    uint256 private vaultHubBalance;

    address private depositor = address(0x001);
    address private owner = address(0x002);
    address private nodeOperator = address(0x003);
    address private user = address(0x004);

    RandomLib.Storage private rnd;

    bool private isConnectedToHub;
    bool private hasValidator;

    function testSolvencyAllTransitions() external {
        runTests(18351848893136264927531209265109202837);
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
                logVaultState();
            }
        }

        uint256 finalBalance = address(stakingVaultProxy).balance;
        int256 finalInOutDelta = stakingVaultProxy.inOutDelta();

        console2.log("VaultHub balance: %d", vaultHubBalance);
        assertEq(
            deposits + initialBalance + rewards + randomUserDeposits,
            finalBalance + withdrawals + depositsToBeaconChain + vaultHubBalance
        );
        assertEq(initialInOutDelta + int256(deposits), finalInOutDelta + int256(withdrawals) + int256(vaultHubBalance));
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
        vaultHubBalance = 0;

        LidoLocatorMock lidoLocator = new LidoLocatorMock(depositor);
        DepositContract__MockForStakingVault depositContract = new DepositContract__MockForStakingVault();
        vaultHub = new VaultHubMock(_seed, address(lidoLocator));
        validator = new ValidatorMock(_seed);
        stakingVault = new StakingVault(address(vaultHub), address(depositContract));

        ERC1967Proxy proxy = new ERC1967Proxy(
            address(stakingVault),
            abi.encodeWithSelector(StakingVault.initialize.selector, owner, nodeOperator, depositor, "0x")
        );
        stakingVaultProxy = StakingVault(payable(address(proxy)));

        vm.prank(owner);
        stakingVaultProxy.authorizeLidoVaultHub();
    }

    function performMajorStateTransition(bool _hasValidator, bool _isConnectedToHub) internal {
        vm.warp(block.timestamp + rnd.randInt(SECONDS_PER_DAY));

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
        vm.warp(block.timestamp + rnd.randInt(SECONDS_PER_DAY));
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
        uint256 amount = rnd.randAmountD18();
        if (amount == 0) {
            amount = MIN_DEPOSIT;
        }
        console2.log("Deposit by random user with random amount %s", formatEth(amount));

        address randomUser = rnd.randAddress();
        deal(randomUser, amount);
        vm.prank(randomUser);
        payable(address(stakingVaultProxy)).transfer(amount);
        randomUserDeposits += amount;
    }

    function transitionRandomFund() internal {
        uint256 amount = rnd.randAmountD18();
        if (amount == 0) {
            amount = MIN_FUND_AMOUNT;
        }
        console2.log("Fund vault with random amount of funds %s", formatEth(amount));

        int256 inOutDeltaBefore = stakingVaultProxy.inOutDelta();
        uint256 valuationBefore = stakingVaultProxy.totalValue();
        uint256 balanceBefore = address(stakingVaultProxy).balance;

        deal(owner, amount);

        vm.prank(owner);
        stakingVaultProxy.fund{value: amount}();
        deposits += amount;

        assertEq(stakingVaultProxy.inOutDelta(), inOutDeltaBefore + int256(amount));
        assertEq(stakingVaultProxy.totalValue(), valuationBefore + amount);
        assertEq(address(stakingVaultProxy).balance, balanceBefore + amount);
    }

    function transitionRandomWithdraw() internal {
        uint256 unlocked = stakingVaultProxy.unlocked();
        uint256 vaultBalance = address(stakingVaultProxy).balance;
        if (vaultBalance < stakingVaultProxy.locked()) {
            return;
        }
        uint256 minWithdrawal = Math.min(unlocked, vaultBalance - stakingVaultProxy.locked());
        if (minWithdrawal == 0) {
            return;
        }
        uint256 withdrawableAmount = rnd.randInt(minWithdrawal);
        if (withdrawableAmount == 0) {
            withdrawableAmount = minWithdrawal;
        }
        console2.log("Withdraw random amount of funds %s", formatEth(withdrawableAmount));

        int256 inOutDeltaBefore = stakingVaultProxy.inOutDelta();
        uint256 valuationBefore = stakingVaultProxy.totalValue();
        uint256 balanceBefore = address(stakingVaultProxy).balance;

        deal(owner, withdrawableAmount);

        vm.prank(owner);
        stakingVaultProxy.withdraw(owner, withdrawableAmount);
        withdrawals += withdrawableAmount;

        assertEq(inOutDeltaBefore, stakingVaultProxy.inOutDelta() + int256(withdrawableAmount));
        assertEq(valuationBefore, stakingVaultProxy.totalValue() + withdrawableAmount);
        assertEq(balanceBefore, address(stakingVaultProxy).balance + withdrawableAmount);
    }

    function transitionRandomReceiveReward() internal {
        uint256 dailyReward = validator.getDailyReward();
        console2.log("Receive random reward %s", formatEth(dailyReward));

        uint256 valuationBefore = stakingVaultProxy.totalValue();
        uint256 balanceBefore = address(stakingVaultProxy).balance;

        vm.deal(address(stakingVaultProxy), address(stakingVaultProxy).balance + dailyReward);
        rewards += dailyReward;

        assertEq(valuationBefore, stakingVaultProxy.totalValue());
        assertEq(address(stakingVaultProxy).balance, balanceBefore + dailyReward);
    }

    function transitionDepositToBeaconChain() internal {
        console2.log("------Deposit to Beacon Chain and start simulating validator------");

        deal(owner, VALIDATOR_DEPOSIT);
        vm.prank(owner);
        stakingVaultProxy.fund{value: VALIDATOR_DEPOSIT}();
        deposits += VALIDATOR_DEPOSIT;

        int256 inOutDeltaBefore = stakingVaultProxy.inOutDelta();
        uint256 valuationBefore = stakingVaultProxy.totalValue();
        uint256 balanceBefore = address(stakingVaultProxy).balance;

        StakingVaultDeposit[] memory newDeposits = new StakingVaultDeposit[](1);
        bytes memory pubkey = new bytes(48);
        bytes32 firstPart = bytes32(uint256(1));
        bytes16 secondPart = bytes16(bytes32(uint256(2)));
        assembly {
            mstore(add(pubkey, 32), firstPart)
            mstore(add(pubkey, 64), secondPart)
        }
        newDeposits[0] = StakingVaultDeposit({
            pubkey: pubkey,
            signature: bytes.concat(bytes32(uint256(2))),
            amount: VALIDATOR_DEPOSIT,
            depositDataRoot: bytes32(uint256(3))
        });

        vm.prank(depositor);
        stakingVaultProxy.depositToBeaconChain(newDeposits);
        depositsToBeaconChain += VALIDATOR_DEPOSIT;

        assertEq(inOutDeltaBefore, stakingVaultProxy.inOutDelta());
        assertEq(valuationBefore, stakingVaultProxy.totalValue());
        assertEq(balanceBefore, address(stakingVaultProxy).balance + VALIDATOR_DEPOSIT);
    }

    function transitionValidatorExitAndReturnDeposit() internal {
        console2.log("------Validator exit and return deposit------");

        uint256 balanceBefore = address(stakingVaultProxy).balance;
        uint256 valuationBefore = stakingVaultProxy.totalValue();

        deal(address(stakingVaultProxy), address(stakingVaultProxy).balance + VALIDATOR_DEPOSIT);
        depositsToBeaconChain -= VALIDATOR_DEPOSIT;

        assertEq(address(stakingVaultProxy).balance, balanceBefore + VALIDATOR_DEPOSIT);
        assertEq(valuationBefore, stakingVaultProxy.totalValue());
    }

    function transitionRandomDepositToBeaconChain() internal {
        console2.log("Deposit to Beacon Chain with random amount");

        uint256 amount = rnd.randAmountD18();
        int256 inOutDeltaBefore = stakingVaultProxy.inOutDelta();
        uint256 valuationBefore = stakingVaultProxy.totalValue();
        uint256 balanceBefore = address(stakingVaultProxy).balance;

        bytes memory pubkey = new bytes(48);
        bytes32 firstPart = bytes32(uint256(1));
        bytes16 secondPart = bytes16(bytes32(uint256(2)));

        assembly {
            mstore(add(pubkey, 32), firstPart)
            mstore(add(pubkey, 64), secondPart)
        }

        StakingVaultDeposit[] memory newDeposits = new StakingVaultDeposit[](1);
        newDeposits[0] = StakingVaultDeposit({
            pubkey: pubkey,
            signature: bytes.concat(bytes32(uint256(2))),
            amount: amount,
            depositDataRoot: bytes32(uint256(3))
        });

        vm.prank(depositor);
        stakingVaultProxy.depositToBeaconChain(newDeposits);
        depositsToBeaconChain += amount;

        assertEq(inOutDeltaBefore, stakingVaultProxy.inOutDelta());
        assertEq(valuationBefore, stakingVaultProxy.totalValue());
        assertEq(balanceBefore, address(stakingVaultProxy).balance + amount);
    }

    function transitionConnectVaultToHub() internal {
        console2.log("------Connect Vault to Hub------");

        if (address(stakingVaultProxy).balance < CONNECT_DEPOSIT) {
            uint256 amountToFund = CONNECT_DEPOSIT - address(stakingVaultProxy).balance;
            deal(owner, amountToFund);
            vm.prank(owner);
            stakingVaultProxy.fund{value: amountToFund}();
            deposits += amountToFund;
        }

        if (stakingVaultProxy.locked() < CONNECT_DEPOSIT) {
            vm.prank(owner);
            stakingVaultProxy.lock(CONNECT_DEPOSIT);
        }

        assertEq(stakingVaultProxy.locked(), CONNECT_DEPOSIT);

        uint256 currentValuation = stakingVaultProxy.totalValue();
        int256 currentInOutDelta = stakingVaultProxy.inOutDelta();
        uint256 currentLocked = stakingVaultProxy.locked();

        uint256 newValuation = address(stakingVaultProxy).balance;
        uint256 newLocked = vaultHub.newLockedEther(currentValuation);
        console2.log(
            "Receive report oldLocked: %s newLocked: %s currentValuation: %s",
            formatEth(currentLocked),
            formatEth(newLocked),
            formatEth(currentValuation)
        );

        vm.prank(address(vaultHub));
        stakingVaultProxy.report(uint64(block.timestamp), newValuation, currentInOutDelta, newLocked);
    }

    function transitionDisconnectVaultFromHub() internal {
        console2.log("------Disconnect Vault from Hub------");

        uint256 valuation = stakingVaultProxy.totalValue();
        int256 inOutDelta = stakingVaultProxy.inOutDelta();

        vm.prank(address(vaultHub));
        stakingVaultProxy.report(uint64(block.timestamp), valuation, inOutDelta, 0);

        assertEq(stakingVaultProxy.locked(), 0);
        assertEq(inOutDelta, stakingVaultProxy.inOutDelta());
        assertEq(
            int256(stakingVaultProxy.totalValue()) + inOutDelta,
            int256(valuation) + stakingVaultProxy.inOutDelta()
        );
    }

    function transitionRandomMintShares() internal {
        uint256 vaultResources = Math.min(stakingVaultProxy.totalValue(), address(stakingVaultProxy).balance);
        uint256 maxMintableEther = vaultHub.maxMintableEther(vaultResources);
        uint256 currentLocked = stakingVaultProxy.locked();

        if (maxMintableEther <= currentLocked) {
            return;
        }

        uint256 etherToLock = currentLocked + rnd.randInt(maxMintableEther - currentLocked);
        console2.log("Mint shares with random amount %s", formatEth(etherToLock));

        vm.prank(owner);
        stakingVaultProxy.lock(etherToLock);

        assertEq(stakingVaultProxy.locked(), etherToLock < currentLocked ? currentLocked : etherToLock);
    }

    function transitionRandomReport() internal {
        uint256 currentValuation = stakingVaultProxy.totalValue();
        int256 currentInOutDelta = stakingVaultProxy.inOutDelta();
        uint256 currentLocked = stakingVaultProxy.locked();

        uint256 newValuation = address(stakingVaultProxy).balance;
        uint256 newLocked = vaultHub.newLockedEther(currentValuation);
        console2.log(
            "Receive report oldLocked: %s newLocked: %s currentValuation: %s",
            formatEth(currentLocked),
            formatEth(newLocked),
            formatEth(currentValuation)
        );

        vm.prank(address(vaultHub));
        stakingVaultProxy.report(uint64(block.timestamp), newValuation, currentInOutDelta, newLocked);

        assertEq(stakingVaultProxy.locked(), newLocked);
        assertEq(currentInOutDelta, stakingVaultProxy.inOutDelta());
        assertEq(
            int256(stakingVaultProxy.totalValue()) + currentInOutDelta,
            int256(newValuation) + stakingVaultProxy.inOutDelta()
        );
    }

    function transitionRandomRebalance() internal {
        int256 inOutDelta = stakingVaultProxy.inOutDelta();
        uint256 valuation = stakingVaultProxy.totalValue();
        uint256 balance = address(stakingVaultProxy).balance;
        uint256 locked = stakingVaultProxy.locked();
        uint256 etherToRebalance = vaultHub.getAmountToUnlock(valuation, locked);
        bool isRebalanceAllowed = false;

        if (etherToRebalance == 0) {
            vm.expectRevert(abi.encodeWithSelector(ZeroArgument.selector, "_ether"));
        } else if (etherToRebalance > balance) {
            vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, balance));
        } else if (etherToRebalance > valuation) {
            vm.expectRevert(
                abi.encodeWithSelector(RebalanceAmountExceedsTotalValue.selector, valuation, etherToRebalance)
            );
        } else if (valuation >= locked) {
            vm.expectRevert(abi.encodeWithSelector(NotAuthorized.selector, "rebalance", address(vaultHub)));
        } else {
            isRebalanceAllowed = true;
            vaultHubBalance += etherToRebalance;
        }
        console2.log("Rebalance with random amount %s", formatEth(etherToRebalance));

        vm.prank(address(vaultHub));
        stakingVaultProxy.rebalance(etherToRebalance);

        if (isRebalanceAllowed) {
            assertEq(inOutDelta, stakingVaultProxy.inOutDelta() + int256(etherToRebalance));
            assertEq(valuation, stakingVaultProxy.totalValue() + etherToRebalance);
            assertEq(balance, address(stakingVaultProxy).balance + etherToRebalance);
        } else {
            assertEq(inOutDelta, stakingVaultProxy.inOutDelta());
            assertEq(valuation, stakingVaultProxy.totalValue());
            assertEq(balance, address(stakingVaultProxy).balance);
        }
    }

    function formatEth(uint256 weiAmount) internal pure returns (string memory) {
        uint256 ether_value = weiAmount / 1e18;
        uint256 decimal_part = weiAmount % 1e18;

        uint256 decimals4 = (decimal_part / 1e14);

        if (ether_value == 0 && decimals4 == 0) {
            return string.concat(vm.toString(weiAmount), " wei");
        }

        string memory etherStr = vm.toString(ether_value);
        string memory decimalStr = vm.toString(decimals4);

        while (bytes(decimalStr).length < 4) {
            decimalStr = string.concat("0", decimalStr);
        }

        return string.concat(etherStr, ".", decimalStr, " ETH");
    }

    function logVaultState() internal {
        if (address(stakingVaultProxy).balance < stakingVaultProxy.locked()) {
            console2.log("-----vault state: %s", "balance < locked");
        } else {
            console2.log("-----vault state: %s", "balance >= locked");
        }
    }
}
