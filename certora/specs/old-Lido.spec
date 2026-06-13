import "setup/snippet_memutils.spec";

using Accounting as Accounting;
using NativeTransferFuncs as NTF;
using EIP712StETH as EIP712StETH;
using Kernel as Kernel;
using LidoLocator as LidoLocator;
using StakingRouter as StakingRouter;
using WithdrawalQueueERC721 as WithdrawalQueue;

/**************************************************
*                   Methods                       *
**************************************************/
methods{
    function initialize(address, address) external;
    function finalizeUpgrade_v2(address, address) external;
    function pauseStaking() external;
    function resumeStaking() external;
    function setStakingLimit(uint256, uint256) external;
    function removeStakingLimit() external;
    function isStakingPaused() external returns (bool) envfree;
    function getCurrentStakeLimit() external returns (uint256);
    function getStakeLimitFullInfo() external returns (bool, bool, uint256, uint256, uint256, uint256, uint256); // envfree
    function submit(address) external returns (uint256); //payable
    function receiveELRewards() external; //payable
    function receiveWithdrawals() external; //payable
    function deposit(uint256, uint256, bytes) external;
    function stop() external;
    function resume() external;
    // handle oracle report
    function unsafeChangeDepositedValidators(uint256) external;
    function handleOracleReport(uint256, uint256) external;
    function transferToVault(address) external;
    function getFee() external returns (uint16) envfree;
    function getFeeDistribution() external returns (uint16, uint16, uint16) envfree;
    function getWithdrawalCredentials() external returns (bytes32) envfree;
    function getBufferedEther() external returns (uint256) envfree;
    function getTotalELRewardsCollected() external returns (uint256) envfree;
    function getTreasury() external returns (address) envfree;
    function getBeaconStat() external returns (uint256, uint256, uint256) envfree;
    function canDeposit() external returns (bool) envfree;
    function getDepositableEther() external returns (uint256) envfree;
    function permit(address,address,uint256,uint256,uint8,bytes32,bytes32) external;

    // StEth:
    function getTotalPooledEther() external returns (uint256) envfree;
    function getTotalShares() external returns (uint256) envfree;
    function sharesOf(address) external returns (uint256) envfree;
    function getSharesByPooledEth(uint256) external returns (uint256) envfree;
    function getPooledEthByShares(uint256) external returns (uint256) envfree;
    function transferShares(address, uint256) external returns (uint256);
    function transferSharesFrom(address, address, uint256) external returns (uint256);

    // function getRatio() external returns(uint256) envfree;
    // function getCLbalance() external returns(uint256) envfree;
    //function _.smoothenTokenRebase(uint256, uint256, uint256, uint256, uint256, uint256, uint256) external => DISPATCHER(true);
    //function _.getSharesRequestedToBurn() external => DISPATCHER(true);
    //function _.checkAccountingOracleReport(uint256, uint256, uint256, uint256, uint256, uint256, uint256) external => DISPATCHER(true);

    function LidoLocator.depositSecurityModule() external returns address envfree;
    function LidoLocator.treasury() external returns address envfree;

    // Harness:
    function stakingModuleMaxDepositsCount(uint256, uint256) external returns (uint256) envfree;
    function LidoEthBalance() external returns (uint256) envfree;
    function getEthBalance(address) external returns (uint256) envfree;
    function collectRewardsAndProcessWithdrawals(uint256, uint256, uint256, uint256, uint256) external;

    // Summarizations:

    function Lido._stakingRouter() internal returns (address) => StakingRouter;
    function Lido._withdrawalQueue() internal returns (address) => WithdrawalQueue;
    function Lido._getLidoLocator() internal returns (address) => LidoLocator;
    function LidoHarness.kernel() internal returns (address) => Kernel;

    function _.getStakingModuleSummary() external => CONSTANT;
    function _.obtainDepositData(uint256,bytes) external => NONDET;
    function Kernel.hasPermission(address,address,bytes32,bytes) external returns (bool) => NONDET;
    function EVMScriptRunner.runScript(bytes memory,bytes memory,address[] memory) internal returns (bytes memory) => CVL_NONDET_bytes();
    function LidoHarness.getEVMScriptExecutor(bytes memory) internal returns (address) => NONDET;
    function LidoHarness.getEVMScriptRegistry() internal returns (address) => NONDET;

    // initialize checks for getEIP712StETH() == 0, slashing with first line.
    // thus, we summarize this check in the second line.
    function LidoHarness.getEIP712StETH() internal returns (address) => EIP712StETH;
    function StETHPermit._initializeEIP712StETH(address) internal => NONDET;

    // nativeTransferFuncs:
    function NTF.withdrawRewards(uint256) external returns (uint256);
    function NTF.withdrawWithdrawals(uint256) external;

    function _.withdrawRewards(uint256) external => DISPATCHER(true);
    function _.withdrawWithdrawals(uint256) external => DISPATCHER(true);

    function _.finalize(uint256, uint256) external => DISPATCHER(true);

    function _.isValidSignature(address, bytes32, uint8, bytes32, bytes32) internal => NONDET;

    // burner
    function _.getCoverSharesBurnt() external => DISPATCHER(true);
    function _.getNonCoverSharesBurnt() external => DISPATCHER(true);
    function _.getSharesRequestedToBurn() external => DISPATCHER(true);

    function _.handlePostTokenRebase(uint256, uint256, uint256, uint256, uint256, uint256, uint256) external => NONDET;
    function _.onRewardsMinted(uint256) external  => NONDET;
}

function CVL_NONDET_bytes() returns (bytes) {
    bytes ret;
    return ret;
}

/**************************************************
*             Ghosts summaries                    *
**************************************************/

ghost ghostBurner() returns address {
    axiom ghostBurner() != currentContract;
    axiom ghostBurner() != 0;
}

ghost ghostLegacyOracle() returns address {
    axiom ghostLegacyOracle() != currentContract;
    axiom ghostLegacyOracle() != 0;
}

ghost ghostEIP712StETH() returns address;

ghost ghostWithdrawalCredentials() returns bytes32;

ghost ghostTotalFeeE4Precision() returns uint16 {
    axiom to_mathint(ghostTotalFeeE4Precision()) <= 10000;
}

ghost getAppGhost(bytes32, bytes32) returns address {
    axiom forall bytes32 a . forall bytes32 b . 
        getAppGhost(a, b) != 0 && 
        getAppGhost(a, b) != currentContract;
}

ghost ghostHashTypedDataV4(address, bytes32) returns bytes32 {
    axiom forall address steth. forall bytes32 a .forall bytes32 b . 
        a != b => 
        ghostHashTypedDataV4(steth, a) != ghostHashTypedDataV4(steth, b);
}

ghost MaxDepositsCount(uint256, uint256) returns uint256 {
    axiom forall uint256 ID. forall uint256 maxValue.
        to_mathint(MaxDepositsCount(ID, maxValue)) <= (maxValue / DEPOSIT_SIZE());
}

ghost uint256 ghostUnfinalizedStETH;

function UnfinalizedStETH() returns uint256 {
    /// Needs to be havoc'd after some call (figure out when and how)
    return ghostUnfinalizedStETH;
}

ghost bool WQPaused;

function isWithdrawalQueuePaused() returns bool {
    return WQPaused;
}

/**************************************************
*                    CVL Helpers                 *
**************************************************/
/**
To avoid overflow
**/
function SumOfETHBalancesLEMax(address someUser) returns bool {
    mathint s = 
        LidoEthBalance() + 
        getTotalELRewardsCollected() +
        getTotalPooledEther() +
        getEthBalance(StakingRouter) +
        getEthBalance(WithdrawalQueue) + 
        getEthBalance(LidoLocator.treasury()) + 
        getEthBalance(LidoLocator.depositSecurityModule()) +
        getEthBalance(someUser);
    return s <= to_mathint(Uint128());
}

/**
To avoid overflow
**/
function SumOfSharesLEMax(address someUser) returns bool {
    mathint s = 
        sharesOf(currentContract) + 
        sharesOf(StakingRouter) +
        sharesOf(WithdrawalQueue) + 
        sharesOf(LidoLocator.treasury()) + 
        sharesOf(LidoLocator.depositSecurityModule()) +
        sharesOf(someUser);
    return s <= to_mathint(Uint128());
}

/**
To avoid overflow
**/
function ReasonableAmountOfShares() returns bool {
    return getTotalShares() < Uint128() && getTotalPooledEther() < Uint128();
}

/**************************************************
*                    Definitions                 *
**************************************************/
definition DEPOSIT_SIZE() returns uint256 = 32000000000000000000;
definition Uint128() returns uint256 = (1 << 128);  

definition isSubmit(method f) returns bool = 
    f.selector == sig:submit(address).selector;

definition handleReportStepsMethods(method f) returns bool = 
    f.selector == sig:collectRewardsAndProcessWithdrawals(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256).selector ||
    f.selector == sig:processClStateUpdate(uint256,uint256,uint256,uint256).selector;

/**************************************************
*                    Rules                 *
**************************************************/
invariant BufferedEthIsAtMostLidoBalance()
    getBufferedEther() <= LidoEthBalance()
    filtered{ f ->
        f.selector != sig:permit(address,address,uint256,uint256,uint8,bytes32,bytes32).selector &&
        f.selector != sig:transferToVault(address).selector
    }
    {
        preserved with (env e) {
            require e.msg.sender != currentContract;
            require SumOfETHBalancesLEMax(e.msg.sender);
            require ReasonableAmountOfShares();
        }
    }

// /// Fails due to overflows.
// /// Need to come up with a condition on the total shares to prevent the overflows cases.
// rule getSharesByPooledEthDoesntRevert(uint256 amount, method f) 
// filtered{f -> !f.isView } {
//     env e;
//     calldataarg args;
//     require SumOfETHBalancesLEMax(e.msg.sender);
//     require SumOfSharesLEMax(e.msg.sender);
//     require ReasonableAmountOfShares();
//     require amount < Uint128();

//     getSharesByPooledEth(amount);
//         f(e, args);
//     getSharesByPooledEth@withrevert(amount);

//     assert !lastReverted;
// }

// rule submitCannotDoSFunctions(method f) 
// filtered{f -> !(handleReportStepsMethods(f) || isSubmit(f))} {
//     env e1; 
//     env e2;
//     require e2.msg.sender != currentContract;
//     calldataarg args;
//     address referral;
//     uint256 amount;

//     storage initState = lastStorage;
//     require SumOfETHBalancesLEMax(e2.msg.sender);
//     require ReasonableAmountOfShares();
    
//     f(e1, args);
    
//     submit(e2, referral) at initState;

//     f@withrevert(e1, args);

//     assert !lastReverted;
// }

/**
After calling submit:
    1. If there is a stake limit then it must decrease by the submitted eth amount.
    2. The user gets the expected amount of shares.
    3. Total shares is increased as expected.
**/
rule integrityOfSubmit(address _referral) {
    env e;
    env e2; // to avoid vacuity due to payable / non-payable methods
    require(e.msg.sender == e2.msg.sender);
    require(e.block == e2.block);
    require(0 < e.block.number && e.block.number < 2^32); // staking is paused when preBlockNumber is zero
    uint256 ethToSubmit = e.msg.value;
    uint256 old_stakeLimit = getCurrentStakeLimit(e2);
    uint256 expectedShares = getSharesByPooledEth(ethToSubmit);
    
    uint256 shareAmount = submit(e, _referral);

    uint256 new_stakeLimit = getCurrentStakeLimit(e2);

    assert (old_stakeLimit < max_uint256) => (new_stakeLimit == assert_uint256(old_stakeLimit - ethToSubmit));
    assert expectedShares == shareAmount;
}

/**
After a successful call for deposit:
    1. Bunker mode is inactive and the protocol is not stopped
    2. If any of max deposits is greater than zero then the buffered ETH must decrease.
    3. The buffered ETH must not increase.
**/
rule integrityOfDeposit(uint256 _maxDepositsCount, uint256 _stakingModuleId, bytes _depositCalldata) {
    env e;

    bool canDeposit = canDeposit();
    uint256 stakeLimit = getCurrentStakeLimit(e);
    uint256 bufferedEthBefore = getBufferedEther();

    uint256 maxDepositsCountSR = stakingModuleMaxDepositsCount(_stakingModuleId, getDepositableEther());

    deposit(e, _maxDepositsCount, _stakingModuleId, _depositCalldata);

    uint256 bufferedEthAfter = getBufferedEther();

    assert canDeposit;
    assert (_maxDepositsCount > 0 && maxDepositsCountSR > 0) => bufferedEthBefore > bufferedEthAfter;
    assert assert_uint256(bufferedEthBefore - bufferedEthAfter) <= bufferedEthBefore;
}

/**
After a successful call for collectRewardsAndProcessWithdrawals:
    1. TOTAL_EL_REWARDS_COLLECTED_POSITION increase by
    2. contracts ETH balance must increase by elRewardsToWithdraw + withdrawalsToWithdraw - etherToLockOnWithdrawalQueue
    3. The buffered ETH must increase elRewardsToWithdraw + withdrawalsToWithdraw - etherToLockOnWithdrawalQueue
**/
rule integrityOfCollectRewardsAndProcessWithdrawals(uint256 withdrawalsToWithdraw, uint256 elRewardsToWithdraw, uint256 withdrawalFinalizationBatch, uint256 simulatedShareRate, uint256 etherToLockOnWithdrawalQueue) {
    env e;
    require SumOfETHBalancesLEMax(e.msg.sender);
    require ReasonableAmountOfShares();

    uint256 contractEthBalanceBefore = LidoEthBalance();
    uint256 totalElRewardsBefore = getTotalELRewardsCollected();
    uint256 bufferedEthBefore = getBufferedEther();

    Accounting.ReportValues report;
    //require(contractEthBalanceBefore == 2);
    //require(report.withdrawalVaultBalance == 0);
    //require(report.elRewardsVaultBalance == 0);

    Accounting.handleOracleReport(e, report);

    uint256 contractEthBalanceAfter = LidoEthBalance();
    uint256 totalElRewardsAfter = getTotalELRewardsCollected();
    uint256 bufferedEthAfter = getBufferedEther();

    assert assert_uint256(contractEthBalanceBefore + withdrawalsToWithdraw + elRewardsToWithdraw - etherToLockOnWithdrawalQueue) == contractEthBalanceAfter;
    assert assert_uint256(totalElRewardsBefore + elRewardsToWithdraw) == totalElRewardsAfter;
    assert assert_uint256(bufferedEthBefore + withdrawalsToWithdraw + elRewardsToWithdraw - etherToLockOnWithdrawalQueue) == bufferedEthAfter;
}

/**************************************************
 *                   MISC Rules                   *
 **************************************************/
use builtin rule sanity filtered { f ->
    f.contract == currentContract &&
    f.selector != sig:transferToVault(address).selector
}

rule transferToVaultAlwaysReverts() {
    env e;
    address a;

    transferToVault@withrevert(e, a);

    assert(lastReverted);
}