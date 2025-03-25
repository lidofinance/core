// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {DepositContract__MockForStakingVault} from "./contracts/DepositContract__MockForStakingVault.sol";
import {VaultHub__MockForStakingVault} from "./contracts/VaultHub__MockForStakingVault.sol";
import {RandomLib} from "./RandomLib.sol";

contract VaultHubMock is Test {
    using RandomLib for RandomLib.Storage;

    uint256 constant MAX_MINTABLE_RATIO_BP = 9000; // 90% can be used for minting (100% - reserve ratio)
    uint256 constant TOTAL_BASIS_POINTS = 10000;
    uint256 constant RESERVE_RATIO_BP = 1000; // 10% reserve ratio
    uint256 constant REWARD_RATE_MIN_BP = 100; // 1% min reward rate
    uint256 constant REWARD_RATE_MAX_BP = 500; // 5% max reward rate
    uint256 constant TREASURY_FEE_BP = 500; // 5% treasury fee
    uint256 constant REBALANCE_THRESHOLD_BP = 9500; // 95% - vault needs rebalance if valuation drops below this

    RandomLib.Storage private rnd;

    constructor(uint256 _seed) {
        rnd.seed = _seed;
    }

    function totalEtherToLock(uint256 vaultValuation) public returns (uint256) {
        uint256 maxMintableEther = (vaultValuation * MAX_MINTABLE_RATIO_BP) / TOTAL_BASIS_POINTS;
        uint256 amountToMint = rnd.randInt(maxMintableEther);
        if (amountToMint == 0) {
            amountToMint = maxMintableEther;
        }
        return (amountToMint * TOTAL_BASIS_POINTS) / MAX_MINTABLE_RATIO_BP;
    }

    function newValuation(uint256 currentValuation) public returns (uint256) {
        uint256 rewardRateBP = REWARD_RATE_MIN_BP + rnd.randInt(REWARD_RATE_MAX_BP - REWARD_RATE_MIN_BP);
        uint256 newValuation = currentValuation + (currentValuation * rewardRateBP) / TOTAL_BASIS_POINTS;
        uint256 treasuryFee = ((newValuation - currentValuation) * TREASURY_FEE_BP) / TOTAL_BASIS_POINTS;
        newValuation -= treasuryFee;
        return newValuation;
    }

    function newLocked(uint256 currentLocked) public returns (uint256) {
        return rnd.randInt(currentLocked / 2, currentLocked);
    }

    function amountToUnlock(uint256 currentValuation, uint256 currentLocked) public returns (uint256) {
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
    uint256 private validatorBalance;

    uint256 private currentAPR;
    uint256 private lastRewardTimestamp;
    RandomLib.Storage private rnd;

    constructor(uint256 _seed) {
        rnd.seed = _seed;
        lastRewardTimestamp = block.timestamp;
        currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
    }

    function dailyReward() public returns (uint256) {
        uint256 timePassed = block.timestamp - lastRewardTimestamp;
        if (timePassed < SECONDS_PER_DAY) {
            return 0;
        }

        uint256 daysPassed = timePassed / SECONDS_PER_DAY;
        lastRewardTimestamp += daysPassed * SECONDS_PER_DAY;

        uint256 validatorBalance = 32 ether;
        uint256 yearlyReward = (validatorBalance * currentAPR) / APR_DENOMINATOR;
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

    bool private isConnectedToHub;
    bool private hasValidator;

    error LockedCannotDecreaseOutsideOfReport(uint256 currentlyLocked, uint256 attemptedLocked);
    error NotAuthorized(string operation, address sender);

    uint256 constant ITERATIONS = 32;
    uint256 constant MIN_REWARD = 0.001 ether;
    uint256 constant MIN_FUND = 0.00001 ether;
    uint256 constant VALIDATOR_DEPOSIT = 32 ether;
    uint256 constant CONNECT_DEPOSIT = 1 ether;
    uint256 constant SECONDS_PER_DAY = 86400;

    StakingVault private stakingVault;
    StakingVault private stakingVaultProxy;
    VaultHubMock private vaultHub;
    ValidatorMock private validator;

    address[] private depositors;
    uint256 private deposits;
    uint256 private withdrawals;
    uint256 private rewards;

    RandomLib.Storage private rnd = RandomLib.Storage(42);

    address private depositor = address(0x001);
    address private owner = address(0x002);
    address private nodeOperator = address(0x003);
    address private user = address(0x004);

    function testSolvencyAllTransitions() external {
        runTests(vm.unixTime());
    }

    function testFuzz_SolvencyAllTransitions(uint256 _seed) external {
        runTests(_seed);
    }

    function runTests(uint256 _seed) internal {
        deploy(_seed);

        uint256 initialBalance = address(stakingVaultProxy).balance;
        int256 initialInOutDelta = stakingVaultProxy.inOutDelta();

        uint256 STATE_TRANSITIONS = 32;
        for (uint256 i = 0; i < STATE_TRANSITIONS; i++) {
            doTransitionToNewVaultState(hasValidator, isConnectedToHub);
            for (uint256 iterationIdx = 0; iterationIdx < ITERATIONS; iterationIdx++) {
                randomTransition(hasValidator, isConnectedToHub);
            }
        }

        uint256 finalBalance = address(stakingVaultProxy).balance;
        int256 finalInOutDelta = stakingVaultProxy.inOutDelta();
        assertEq(deposits - withdrawals, finalBalance - initialBalance - rewards);

        console2.log("deltaBalance: %s", finalBalance - initialBalance);
        console2.log("deltaDeposits: %s", deposits - withdrawals);
        console2.log("deltaInOutDelta: %s", finalInOutDelta - initialInOutDelta);
    }

    function deploy(uint256 _seed) public {
        rnd.seed = _seed;
        isConnectedToHub = false;
        hasValidator = false;
        deposits = 0;
        withdrawals = 0;
        rewards = 0;
        delete depositors;

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

    function doTransitionToNewVaultState(bool _hasValidator, bool _isConnectedToHub) internal {
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
                transitionValidatorWithdraw();
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
        function() internal[] memory transitions = new function() internal[](2);
        transitions[0] = transitionRandomFund;
        transitions[1] = transitionRandomWithdraw;
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
    ) internal returns (function() internal[] memory) {
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

    function transitionRandomReceive() internal {
        uint256 amount = rnd.randAmountD18();
        if (amount == 0) {
            amount = MIN_FUND;
        }

        address user = randomDepositor();
        deal(user, amount);

        vm.prank(user);
        payable(address(stakingVaultProxy)).transfer(amount);
        vm.stopPrank();

        console2.log("transitionRandomReceive: %d", amount);
    }

    function randomDepositor() internal returns (address) {
        uint256 userIndex;
        if (rnd.randBool() || depositors.length == 0) {
            address randomUser = rnd.randAddress();
            depositors.push(randomUser);
            userIndex = depositors.length - 1;
        } else {
            userIndex = rnd.randInt(0, depositors.length - 1);
        }
        return depositors[userIndex];
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
        uint256 unlocked = stakingVaultProxy.unlocked();
        uint256 vaultBalance = address(stakingVaultProxy).balance;
        uint256 minWithdrawal = Math.min(unlocked, vaultBalance);
        uint256 withdrawableAmount = rnd.randInt(minWithdrawal);
        if (withdrawableAmount == 0) {
            return;
        }

        deal(owner, withdrawableAmount);
        withdrawals += withdrawableAmount;

        vm.prank(owner);
        stakingVaultProxy.withdraw(owner, withdrawableAmount);
        vm.stopPrank();

        console2.log("transitionRandomWithdraw: %d", withdrawableAmount);
    }

    function transitionRandomReceiveReward() internal {
        uint256 dailyReward = validator.dailyReward();
        rewards += dailyReward;
        vm.deal(address(stakingVaultProxy), address(stakingVaultProxy).balance + dailyReward);

        console2.log("transitionRandomReceiveReward: %d", dailyReward);
    }

    function transitionDepositToBeaconChain() internal {
        console2.log("-------------------------------- transitionDepositToBeaconChain--------------------------------");

        vm.warp(block.timestamp + rnd.randInt(2 * SECONDS_PER_DAY));

        deal(owner, VALIDATOR_DEPOSIT);
        vm.prank(owner);
        stakingVaultProxy.fund{value: VALIDATOR_DEPOSIT}();
        vm.stopPrank();
        deposits += VALIDATOR_DEPOSIT;

        IStakingVault.Deposit[] memory deposits = new IStakingVault.Deposit[](1);

        // Create 48-byte pubkey by concatenating two parts
        bytes memory pubkey = new bytes(48);
        bytes32 firstPart = bytes32(uint256(1));
        bytes16 secondPart = bytes16(bytes32(uint256(2)));

        assembly {
            mstore(add(pubkey, 32), firstPart)
            mstore(add(pubkey, 64), secondPart)
        }

        deposits[0] = IStakingVault.Deposit({
            pubkey: pubkey,
            signature: bytes.concat(bytes32(uint256(2))),
            amount: VALIDATOR_DEPOSIT,
            depositDataRoot: bytes32(uint256(3))
        });
        vm.prank(depositor);
        stakingVaultProxy.depositToBeaconChain(deposits);
        vm.stopPrank();

        withdrawals += VALIDATOR_DEPOSIT;
    }

    function transitionValidatorWithdraw() internal {
        console2.log("-------------------------------- transitionValidatorWithdraw--------------------------------");
        vm.warp(block.timestamp + rnd.randInt(2 * SECONDS_PER_DAY));

        deal(owner, VALIDATOR_DEPOSIT);
        vm.startPrank(owner);
        stakingVaultProxy.fund{value: VALIDATOR_DEPOSIT}();
        vm.stopPrank();
        deposits -= VALIDATOR_DEPOSIT;

        vm.prank(owner);
        stakingVaultProxy.withdraw(owner, VALIDATOR_DEPOSIT);
        vm.stopPrank();
        withdrawals -= VALIDATOR_DEPOSIT;
    }

    function transitionRandomDepositToBeaconChain() internal {
        vm.prank(depositor);

        bytes memory pubkey = new bytes(48);
        bytes32 firstPart = bytes32(uint256(1));
        bytes16 secondPart = bytes16(bytes32(uint256(2)));

        assembly {
            mstore(add(pubkey, 32), firstPart)
            mstore(add(pubkey, 64), secondPart)
        }

        IStakingVault.Deposit[] memory deposits = new IStakingVault.Deposit[](1);
        deposits[0] = IStakingVault.Deposit({
            pubkey: pubkey,
            signature: bytes.concat(bytes32(uint256(2))),
            amount: 0.1 ether,
            depositDataRoot: bytes32(uint256(3))
        });
        stakingVaultProxy.depositToBeaconChain(deposits);
    }

    function transitionConnectVaultToHub() internal {
        console2.log("-------------------------------- transitionConnectVaultToHub--------------------------------");
        vm.prank(address(vaultHub));
        stakingVaultProxy.lock(CONNECT_DEPOSIT);
        vm.stopPrank();
    }

    function transitionDisconnectVaultFromHub() internal {
        console2.log(
            "-------------------------------- transitionDisconnectVaultFromHub--------------------------------"
        );
        uint256 valuation = stakingVaultProxy.valuation();
        int256 inOutDelta = stakingVaultProxy.inOutDelta();
        vm.prank(address(vaultHub));
        stakingVaultProxy.report(valuation, inOutDelta, 0);
        vm.stopPrank();
    }

    function transitionRandomMintShares() internal {
        uint256 vaultValuation = stakingVaultProxy.valuation();
        uint256 totalEtherToLock = vaultHub.totalEtherToLock(vaultValuation);
        uint256 currentLocked = stakingVaultProxy.locked();
        vm.prank(address(vaultHub));
        if (totalEtherToLock < currentLocked) {
            vm.expectRevert(
                abi.encodeWithSelector(LockedCannotDecreaseOutsideOfReport.selector, currentLocked, totalEtherToLock)
            );
        }
        stakingVaultProxy.lock(totalEtherToLock);
        vm.stopPrank();

        console2.log(
            "transitionRandomMintShares: valuation=%f ETH, amount=%f ETH, locked=%f ETH",
            vaultValuation / 1e18,
            totalEtherToLock / 1e18,
            currentLocked / 1e18
        );
    }

    function transitionRandomReport() internal {
        uint256 currentValuation = stakingVaultProxy.valuation();
        int256 currentInOutDelta = stakingVaultProxy.inOutDelta();
        uint256 currentLocked = stakingVaultProxy.locked();

        uint256 newValuation = vaultHub.newValuation(currentValuation);
        uint256 newLocked = vaultHub.newLocked(currentLocked);

        vm.prank(address(vaultHub));
        stakingVaultProxy.report(newValuation, currentInOutDelta, newLocked);
        vm.stopPrank();
    }

    function transitionRandomRebalance() internal {
        uint256 currentValuation = stakingVaultProxy.valuation();
        uint256 currentLocked = stakingVaultProxy.locked();
        uint256 currentBalance = address(stakingVaultProxy).balance;
        uint256 etherToRebalance = vaultHub.amountToUnlock(currentValuation, currentLocked);
        if (etherToRebalance == 0 || etherToRebalance > currentBalance) {
            return;
        }

        if (etherToRebalance < currentLocked) {
            vm.expectRevert(abi.encodeWithSelector(NotAuthorized.selector, "rebalance", address(vaultHub)));
        }
        vm.prank(address(vaultHub));
        stakingVaultProxy.rebalance(etherToRebalance);
        vm.stopPrank();

        console2.log("address(vaultHub): %s", address(vaultHub));
    }
}
