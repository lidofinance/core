import "setup/snippet_memutils.spec";

using EIP712StETH as EIP712StETH;
using Kernel as Kernel;
using LidoLocator as LidoLocator;
using StakingRouter as StakingRouter;
using WithdrawalQueueERC721 as WithdrawalQueue;

methods {
    function name()                                external returns (string) envfree;
    function symbol()                              external returns (string) envfree;
    function decimals()                            external returns (uint8) envfree;
    function totalSupply()                         external returns (uint256) envfree;
    function balanceOf(address)                    external returns (uint256) envfree;
    function allowance(address,address)            external returns (uint256) envfree;
    function approve(address,uint256)              external returns (bool);
    function transfer(address,uint256)             external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
    function increaseAllowance(address, uint256) external returns (bool);
    function decreaseAllowance(address, uint256) external returns (bool);

    function getTotalPooledEther() external returns (uint256) envfree;
    function getTotalShares() external returns (uint256) envfree;
    function sharesOf(address) external returns (uint256) envfree;
    function getSharesByPooledEth(uint256) external returns (uint256) envfree;
    function getPooledEthByShares(uint256) external returns (uint256) envfree;
    function transferShares(address, uint256) external returns (uint256);
    function transferSharesFrom(address, address, uint256) external returns (uint256);

    // Lido
    function pauseStaking() external;
    function resumeStaking() external;
    function setStakingLimit(uint256, uint256) external;
    function removeStakingLimit() external;
    function isStakingPaused() external returns (bool) envfree;
    function getCurrentStakeLimit() external returns (uint256);
    function getStakeLimitFullInfo() external returns (bool, bool, uint256, uint256, uint256, uint256, uint256);
    function submit(address) external returns (uint256); //payable
    function receiveELRewards() external; //payable
    function depositBufferedEther() external;
    function depositBufferedEther(uint256) external;
    function burnShares(address, uint256) external returns (uint256);
    function stop() external;
    function resume() external;
    function setFee(uint16) external;
    function setFeeDistribution(uint16, uint16, uint16) external;
    function setProtocolContracts(address, address, address) external;
    function setWithdrawalCredentials(bytes32) external;
    function setELRewardsVault(address) external;
    function setELRewardsWithdrawalLimit(uint16) external;
    function handleOracleReport(uint256, uint256) external;
    function transferToVault(address) external;
    function getFee() external returns (uint16) envfree;
    function getFeeDistribution() external returns (uint16, uint16, uint16) envfree;
    function getWithdrawalCredentials() external returns (bytes32) envfree;
    function getBufferedEther() external returns (uint256) envfree;
    function getTotalELRewardsCollected() external returns (uint256) envfree;
    // function getELRewardsWithdrawalLimit() external returns (uint256) envfree;
    // getDepositContract() public view returns (IDepositContract)
    // getOperators() public view returns (INodeOperatorsRegistry)
    function getTreasury() external returns (address) envfree;
    // function getInsuranceFund() external returns (address) envfree;
    function getBeaconStat() external returns (uint256, uint256, uint256) envfree;
    // function getELRewardsVault() external returns (address) envfree;

    function Lido._stakingRouter() internal returns (address) => StakingRouter;
    function Lido._withdrawalQueue() internal returns (address) => WithdrawalQueue;
    function Lido._getLidoLocator() internal returns (address) => LidoLocator;
    function LidoHarness.getEIP712StETH() internal returns (address) => EIP712StETH;
    function LidoHarness.kernel() internal returns (address) => Kernel;

    function _.getRecoveryVault() external => CONSTANT;

    function isStopped() external returns (bool) envfree;

    function _.isValidSignature(address, bytes32, uint8, bytes32, bytes32) internal => NONDET;
    function _.getStakingModuleSummary() external => NONDET;
    function _.obtainDepositData(uint256,bytes) external => NONDET;
    function Kernel.hasPermission(address,address,bytes32,bytes) external returns (bool) => NONDET;
    function EVMScriptRunner.runScript(bytes memory,bytes memory,address[] memory) internal returns (bytes memory) => CVL_NONDET_bytes();
    function LidoHarness.getEVMScriptExecutor(bytes memory) internal returns (address) => NONDET;

    // mint(address,uint256)
    // burn(uint256)
    // burn(address,uint256)
    // burnFrom(address,uint256)
    // initialize(address)
}

function CVL_NONDET_bytes() returns (bytes) {
    bytes ret;
    return ret;
}

/**
Verify that there is no fee on transferFrom.
**/
rule noFeeOnTransferFrom(address alice, address bob, uint256 amount) {
    env e;
    require alice != bob;
    require allowance(alice, e.msg.sender) >= amount;
    uint256 sharesBalanceBeforeBob = sharesOf(bob);
    uint256 sharesBalanceBeforeAlice = sharesOf(alice);

    uint256 actualSharesAmount = getSharesByPooledEth(amount);

    transferFrom(e, alice, bob, amount);

    uint256 sharesBalanceAfterBob = sharesOf(bob);
    uint256 sharesBalanceAfterAlice = sharesOf(alice);

    assert sharesBalanceAfterBob == assert_uint256(sharesBalanceBeforeBob + actualSharesAmount);
    assert sharesBalanceAfterAlice == assert_uint256(sharesBalanceBeforeAlice - actualSharesAmount);
}

/**
Verify that there is no fee on transferSharesFrom.
**/
rule noFeeOnTransferSharesFrom(address alice, address bob, uint256 amount) {
    env e;
    require alice != bob;
    require allowance(alice, e.msg.sender) >= amount;
    uint256 sharesBalanceBeforeBob = sharesOf(bob);
    uint256 sharesBalanceBeforeAlice = sharesOf(alice);

    transferSharesFrom(e, alice, bob, amount);

    uint256 sharesBalanceAfterBob = sharesOf(bob);
    uint256 sharesBalanceAfterAlice = sharesOf(alice);

    assert sharesBalanceAfterBob == assert_uint256(sharesBalanceBeforeBob + amount);
    assert sharesBalanceAfterAlice == assert_uint256(sharesBalanceBeforeAlice - amount);
}

/**
Verify that there is no fee on transfer.
**/
rule noFeeOnTransfer(address bob, uint256 amount) {
    env e;
    require bob != e.msg.sender;
    uint256 balanceSenderBefore = sharesOf(e.msg.sender);
    uint256 balanceBefore = sharesOf(bob);

    uint256 actualSharesAmount = getSharesByPooledEth(amount);

    transfer(e, bob, amount);

    uint256 balanceAfter = sharesOf(bob);
    uint256 balanceSenderAfter = sharesOf(e.msg.sender);
    assert balanceAfter == assert_uint256(balanceBefore + actualSharesAmount);
    assert balanceSenderAfter == assert_uint256(balanceSenderBefore - actualSharesAmount);
}

/**
Verify that there is no fee on transferShares.
**/
rule noFeeOnTransferShares(address bob, uint256 amount) {
    env e;
    require bob != e.msg.sender;
    uint256 balanceSenderBefore = sharesOf(e.msg.sender);
    uint256 balanceBefore = sharesOf(bob);

    transferShares(e, bob, amount);

    uint256 balanceAfter = sharesOf(bob);
    uint256 balanceSenderAfter = sharesOf(e.msg.sender);
    assert balanceAfter == assert_uint256(balanceBefore + amount);
    assert balanceSenderAfter == assert_uint256(balanceSenderBefore - amount);
}

/**
Token transfer works correctly. Balances are updated if not reverted. 
If reverted then the transfer amount was too high, or the recipient either 0, the same as the sender or the currentContract.
**/
rule transferCorrect(address to, uint256 amount) {
    env e;
    require e.msg.value == 0 && e.msg.sender != 0;
    uint256 fromBalanceBefore = sharesOf(e.msg.sender);
    uint256 toBalanceBefore = sharesOf(to);
    require fromBalanceBefore + toBalanceBefore <= max_uint256;
    require isStopped() == false;
    uint256 actualSharesAmount = getSharesByPooledEth(amount);

    transfer@withrevert(e, to, amount);
    bool reverted = lastReverted;
    if (!reverted) {
        if (e.msg.sender == to) {
            assert sharesOf(e.msg.sender) == fromBalanceBefore;
        } else {
            assert sharesOf(e.msg.sender) == assert_uint256(fromBalanceBefore - actualSharesAmount);
            assert sharesOf(to) == assert_uint256(toBalanceBefore + actualSharesAmount);
        }
    } else {
        assert actualSharesAmount > fromBalanceBefore || to == 0 || e.msg.sender == to || to == currentContract;
    }
}

/**
Test that transferFrom works correctly. Balances are updated if not reverted.
**/
rule transferFromCorrect(address from, address to, uint256 amount) {
    env e;
    require e.msg.value == 0;
    uint256 fromBalanceBefore = sharesOf(from);
    uint256 toBalanceBefore = sharesOf(to);
    uint256 allowanceBefore = allowance(from, e.msg.sender);
    require fromBalanceBefore + toBalanceBefore <= max_uint256;
    uint256 actualSharesAmount = getSharesByPooledEth(amount);

    transferFrom(e, from, to, amount);

    assert from != to =>
        sharesOf(from) == assert_uint256(fromBalanceBefore - actualSharesAmount) &&
        sharesOf(to) == assert_uint256(toBalanceBefore + actualSharesAmount);
}

/**
Test that transferSharesFrom works correctly. Balances are updated if not reverted.
**/
rule transferSharesFromCorrect(address from, address to, uint256 amount) {
    env e;
    require e.msg.value == 0;
    uint256 fromBalanceBefore = sharesOf(from);
    uint256 toBalanceBefore = sharesOf(to);
    uint256 allowanceBefore = allowance(from, e.msg.sender);
    require fromBalanceBefore + toBalanceBefore <= max_uint256;
    uint256 tokenAmount = getPooledEthByShares(amount);

    transferSharesFrom(e, from, to, amount);

    assert from != to =>
        sharesOf(from) == assert_uint256(fromBalanceBefore - amount) &&
        sharesOf(to) == assert_uint256(toBalanceBefore + amount);
}

/**
transferFrom should revert if and only if the amount is too high or the recipient is 0 or the contract itself.
**/
rule transferFromReverts(address from, address to, uint256 amount) {
    env e;
    uint256 allowanceBefore = allowance(from, e.msg.sender);
    uint256 fromBalanceBefore = sharesOf(from);
    require from != 0 && e.msg.sender != 0;
    require e.msg.value == 0;
    require fromBalanceBefore + sharesOf(to) <= max_uint256;
    require isStopped() == false;
    uint256 actualSharesAmount = getSharesByPooledEth(amount);

    transferFrom@withrevert(e, from, to, amount);

    assert lastReverted <=> (allowanceBefore < amount || actualSharesAmount > fromBalanceBefore || to == 0 || to == currentContract);
}

/**
transferFrom should revert if and only if the amount is too high or the recipient is 0 or the contract itself.
**/
rule transferSharesFromReverts(address from, address to, uint256 amount) {
    env e;
    uint256 allowanceBefore = allowance(from, e.msg.sender);
    uint256 fromBalanceBefore = sharesOf(from);
    require from != 0 && e.msg.sender != 0;
    require e.msg.value == 0;
    require fromBalanceBefore + sharesOf(to) <= max_uint256;
    require isStopped() == false;
    uint256 tokenAmount = getPooledEthByShares(amount);

    transferSharesFrom@withrevert(e, from, to, amount);

    assert lastReverted <=> (allowanceBefore < tokenAmount || amount > fromBalanceBefore || to == 0 || to == currentContract);
}

/**
Allowance changes correctly as a result of calls to approve, transferFrom, transferSharesFrom, increaseAllowance, decreaseAllowance.
**/
rule ChangingAllowance(method f, address from, address spender) 
    filtered{ f ->
        f.selector != sig:initialize(address, address).selector &&
        f.selector != sig:finalizeUpgrade_v3(address,address[]).selector &&
        f.selector != sig:transferToVault(address).selector
    } {
    uint256 allowanceBefore = allowance(from, spender);
    env e;
    if (f.selector == sig:approve(address, uint256).selector) {
        address spender_;
        uint256 amount;
        approve(e, spender_, amount);
        if (from == e.msg.sender && spender == spender_) {
            assert allowance(from, spender) == amount;
        } else {
            assert allowance(from, spender) == allowanceBefore;
        }
    } else if (f.selector == sig:transferFrom(address,address,uint256).selector || f.selector == sig:transferSharesFrom(address,address,uint256).selector) {
        address from_;
        address to;
        uint256 amount;
        transferFrom(e, from_, to, amount);
        uint256 allowanceAfter = allowance(from, spender);
        if (from == from_ && spender == e.msg.sender) {
            assert from == to || allowanceBefore == max_uint256 || allowanceAfter == assert_uint256(allowanceBefore - amount);
        } else {
            assert allowance(from, spender) == allowanceBefore;
        }
    } else if (f.selector == sig:decreaseAllowance(address, uint256).selector) {
        address spender_;
        uint256 amount;
        require amount <= allowanceBefore;
        decreaseAllowance(e, spender_, amount);
        if (from == e.msg.sender && spender == spender_) {
            assert allowance(from, spender) == assert_uint256(allowanceBefore - amount);
        } else {
            assert allowance(from, spender) == allowanceBefore;
        }
    } else if (f.selector == sig:increaseAllowance(address, uint256).selector) {
        address spender_;
        uint256 amount;
        require amount + allowanceBefore < max_uint256;
        increaseAllowance(e, spender_, amount);
        if (from == e.msg.sender && spender == spender_) {
            assert allowance(from, spender) == assert_uint256(allowanceBefore + amount);
        } else {
            assert allowance(from, spender) == allowanceBefore;
        }
    } else if (f.selector == sig:permit(address, address, uint256, uint256, uint8, bytes32, bytes32).selector) {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
        permit(e, from, spender, value, deadline, v, r, s);
        assert allowance(from, spender) == value;
    } else {
        calldataarg args;
        f(e, args);
        assert allowance(from, spender) == allowanceBefore;
    }
}

/**
Transfer from msg.sender to recipient doesn't change the balance of other addresses.
**/
rule TransferDoesntChangeOtherBalance(address to, uint256 amount, address other) {
    env e;
    require other != e.msg.sender;
    require other != to && other != currentContract;
    uint256 balanceBefore = sharesOf(other);
    transfer(e, to, amount); 
    assert balanceBefore == sharesOf(other);
}

/**
Transfer from sender to recipient using transferFrom doesn't change the balance of other addresses.
**/
rule TransferFromDoesntChangeOtherBalance(address from, address to, uint256 amount, address other) {
    env e;
    require other != from;
    require other != to;
    uint256 balanceBefore = sharesOf(other);
    transferFrom(e, from, to, amount); 
    assert balanceBefore == sharesOf(other);
}

/**
Transfer shares from sender to recipient using transferFrom doesn't change the balance of other addresses.
**/
rule TransferSharesFromDoesntChangeOtherBalance(address from, address to, uint256 amount, address other) {
    env e;
    require other != from;
    require other != to;
    uint256 balanceBefore = sharesOf(other);
    transferSharesFrom(e, from, to, amount); 
    assert balanceBefore == sharesOf(other);
}

/**************************************************
 *                METHOD INTEGRITY                *
 **************************************************/

/**************************************************
 *                   HIGH LEVEL                   *
 **************************************************/

/**************************************************
 *                   INVARIANTS                   *
 **************************************************/

// invariant balanceOfCanrExceedTotalSuply(address user) 
//     balanceOf(user) <= totalSupply()

// invariant sharesOfCantExceedTotalShares(address user)
//     sharesOf(user) <= getTotalShares()

// /**
// This rule finds which functions are privileged.
// A function is privileged if only one address can call it.
// The rule identifies this by checking which functions can be called by two different users.
// **/
// rule privilegedOperation(method f, address privileged){
// 	env e1;
// 	calldataarg arg;
// 	require e1.msg.sender == privileged;

// 	storage initialStorage = lastStorage;
// 	f@withrevert(e1, arg); // privileged succeeds executing candidate privileged operation.
// 	bool firstSucceeded = !lastReverted;

// 	env e2;
// 	calldataarg arg2;
// 	require e2.msg.sender != privileged;
// 	f@withrevert(e2, arg2) at initialStorage; // unprivileged
// 	bool secondSucceeded = !lastReverted;

// 	assert  !(firstSucceeded && secondSucceeded), "${f.selector} can be called by both ${e1.msg.sender} and ${e2.msg.sender}, so it is not privileged";
// }


// rule sanity(method f)
// {
// 	env e;
// 	calldataarg arg;
// 	f(e, arg);
// 	assert false;
// }
