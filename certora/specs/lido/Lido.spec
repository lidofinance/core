/* Spec for Lido contract properties */
using Accounting as _Accounting;
using LidoHarness as _Lido;
using LidoLocator as _LidoLocator;
using LidoExecutionLayerRewardsVault as _ELRewardsVault;
using WithdrawalVault as _WithdrawalVault;
using WithdrawalQueueERC721 as _WithdrawalQueue;


methods {
    // `LidoLocator`
    function _.lido() external => _Lido expect address;
    function _.withdrawalQueue() external => _WithdrawalQueue expect address;
    function _.withdrawalVault() external => _WithdrawalVault expect address;
    function _.elRewardsVault() external => _ELRewardsVault expect address;
    function _.depositSecurityModule() external => NONDET;
    function _.stakingRouter() external => NONDET;
    function _.accounting() external => _Accounting expect address;
    function _.vaultHub() external => NONDET;
    function _.burner() external => NONDET;
    function _.accountingOracle() external => NONDET;

    // `LidoHarness`
    function Lido._getLidoLocator() internal returns (address) => _LidoLocator;
    function LidoHarness.getTotalShares() external returns (uint256) envfree;
    function LidoHarness.getExternalShares() external returns (uint256) envfree;
    function LidoHarness.getInternalEther() external returns (uint256) envfree;
    function LidoHarness.getShareRateNumerator() external returns (uint256) envfree;
    function LidoHarness.getShareRateDenominator() external returns (uint256) envfree;
    function LidoHarness.getBufferedEther() external returns (uint256) envfree;
    function LidoHarness.getDepositedValidators() external returns (uint256) envfree;
    function LidoHarness.getPrevStakeLimit() external returns (uint96) envfree;
    function LidoHarness.getPrevStakeBlockNumber() external returns (uint32) envfree;
    function LidoHarness.getMaxStakeLimit() external returns (uint96) envfree;
    function LidoHarness.getMaxStakeLimitGrowthBlocks() external returns (uint32) envfree;
    function LidoHarness.eip712Domain() external returns (
        string, string, uint256, address
    ) => CVLeip712Domain();

    function LidoHarness.getSharesByPooledEth(
        uint256 _ethAmount
    ) external returns (uint256) => CVLgetSharesByPooledEth(_ethAmount);
    function LidoHarness.getPooledEthBySharesRoundUp(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthBySharesRoundUp(_sharesAmount);

    // `IKernel` (`@aragon/os/contracts/kernel/IKernel.sol`) called by `AragonApp`
    function _.hasPermission(address, address, bytes32, bytes) external => NONDET;

    // `VaultHub`
    function _.badDebtToInternalizeAsOfLastRefSlot() external => NONDET;
    function _.decreaseInternalizedBadDebt(uint256) external => NONDET;

    // `OracleReportSanityChecker`
    function _.smoothenTokenRebase(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => DISPATCHER(true);
    function _.checkAccountingOracleReport(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => DISPATCHER(true);
    function _.checkWithdrawalQueueOracleReport(uint256, uint256) external => DISPATCHER(true);

    // `AccountingOracle`
    function _.getLastProcessingRefSlot() external => NONDET;

    // `Burner`
    // NOTE: These two summaries completely ignore and disable any side effects
    function _.commitSharesToBurn(uint256) external => NONDET;
    function _.requestBurnShares(address, uint256) external => NONDET;
    function _.getSharesRequestedToBurn() external => NONDET;

    // `ConversionHelpers` Lib (`node_modules/@aragon/os/contracts/common/ConversionHelpers.sol`
    // called by `AragonApp`
    // The summary below is not sound since we return a reference type, however it is
    // only used as parameter for `hasPermission` above, which is summarized as `NONDET`.
    function ConversionHelpers.dangerouslyCastUintArrayToBytes(
        uint256[] memory
    ) internal returns (bytes memory) => CVLNondetBytes();

    // The following is a view function in `@aragon/os/contracts/kernel/Kernel.sol`
    function _.getRecoveryVault() external => NONDET;

    // `StakingRouter` (called by `Accounting`)
    function _.getStakingRewardsDistribution() external => NONDET;
    function _.getStakingModuleMaxDepositsCount(uint256, uint256) external => NONDET;
    // NOTE: The summary of `reportRewardsMinted` is not sound - returns NONDET
    function _.reportRewardsMinted(uint256[], uint256[]) external => NONDET;
    // NOTE: The summary of `deposit` is not sound - returns NONDET
    function _.deposit(uint256, uint256, bytes) external => NONDET;
    function _.getStakingModuleIds() external => CVLNondetUint() expect (uint256[]);
    function _.getStakingModule(uint256) external => NONDET;

    // `ISecondOpinionOracle`
    function _.getReport(uint256) external => NONDET;

    // `WithdrawalQueueERC721`
    function _.isPaused() external => NONDET;
    function _.prefinalize(uint256[], uint256) external => NONDET;
    function _.isBunkerModeActive() external => NONDET;
    function _.unfinalizedStETH() external => NONDET;
    // NOTE: The summary of `finalize` is not sound - returns NONDET
    function _.finalize(uint256, uint256) external => NONDET;

    // `LidoExecutionLayerRewardsVault`
    function _.withdrawRewards(uint256) external => DISPATCHER(true);

    // `WithdrawalVault`
    function _.withdrawWithdrawals(uint256) external => DISPATCHER(true);

    // `WithdrawalQueue`
    function _.getWithdrawalStatus(uint256[]) external => DISPATCHER(true);

    // `IPostTokenRebaseReceiver`
    // This interface has a single function. Its only implementation is in
    // `test/0.4.24/contracts/PostTokenRebaseReceiver__MockForAccounting.sol` where it
    // does nothing apart from emitting an event.
    function _.handlePostTokenRebase(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256
    ) external => NONDET;
}

// -- Summary functions --------------------------------------------------------

/// @dev Summarize the multiplication and division to reduce chances of timeout.
/// @notice While the original function will revert if `_ethAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetSharesByPooledEth(uint256 _ethAmount) returns uint256 {
    uint256 numeratorInEther = _Lido.getShareRateNumerator();
    uint256 denominatorInShares = _Lido.getShareRateDenominator();

    require(
        numeratorInEther > 0, "Avoid division by zero in getSharesByPooledEth summary"
    );
    require(
        denominatorInShares < 2^128, 
        "Cannot be higher than 2^128 due to the way it is stored"
    );

    return require_uint256((_ethAmount * denominatorInShares) / numeratorInEther);
}


/// @dev Summarize the multiplication and division to reduce chances of timeout.
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthBySharesRoundUp(uint256 _sharesAmount) returns uint256 {
    uint256 numeratorInEther = _Lido.getShareRateNumerator();
    uint256 denominatorInShares = _Lido.getShareRateDenominator();

    require(
        denominatorInShares > 0,
        "Avoid division by zero in getPooledEthBySharesRoundUp summary"
    );
    require(
        numeratorInEther < 2^128,
        "Prevent numeratorInEther * _shareAmount from overflowing in getPooledEthBySharesRoundUp"
    );
    require(
        denominatorInShares < 2^128, 
        "Cannot be higher than 2^128 due to the way it is stored"
    );

    return require_uint256(
        // Add `denominatorInShares - 1` to round up
        (_sharesAmount * numeratorInEther + denominatorInShares - 1)
        / denominatorInShares
    );
}


/// @dev Summarize `Lido.eip712Domain` as non-deterministic
function CVLeip712Domain() returns (string, string, uint256, address) {
    string name;
    string version;
    uint256 chainId;
    address verifyingContract;
    return (name, version, chainId, verifyingContract);
}


/// @dev A non-deterministic bytes array
function CVLNondetBytes() returns bytes {
    bytes ret;
    return ret;
}


/// @dev A non-deterministic `uint256` array
function CVLNondetUint() returns uint256[] {
    uint256[] ret;
    return ret;
}

// ---- Utility functions ------------------------------------------------------

definition isDepracatedFunc(method f) returns bool = (
    f.selector == sig:LidoHarness.transferToVault(address).selector
);

/// @dev The `finalizeUpgrade_v3` function copies the old storage data into a new
/// unstructured storage, which makes it hard to verify
definition isUpgradeFunc(method f) returns bool = (
    f.selector == sig:LidoHarness.finalizeUpgrade_v3(address,address[],uint256).selector
);

// ---- Rules: verifying summaries ---------------------------------------------

/// @title Verifies summary of `getSharesByPooledEthSummary`
rule verifygetSharesByPooledEthSummary(uint256 _ethAmount) {
    env e;
    assert _Lido.getSharesByPooledEth(e, _ethAmount) == CVLgetSharesByPooledEth(_ethAmount);
}


/// @title Verifies summary of `getPooledEthBySharesRoundUp`
rule verifygetPooledEthBySharesRoundUp(uint256 _sharesAmount) {
    env e;
    assert (
        _Lido.getPooledEthBySharesRoundUp(e, _sharesAmount) ==
        CVLgetPooledEthBySharesRoundUp(_sharesAmount)
    );
}

// ---- Utility rules ----------------------------------------------------------

/// @dev A method that can only be called by `Accounting`
definition isOnlyCalledByAccounting(method f) returns bool = (
    f.selector == sig:LidoHarness.collectRewardsAndProcessWithdrawals(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256 
    ).selector
);

rule canOnlyBeCalledByAccounting(method f) filtered {
    f -> f.contract == _Lido && isOnlyCalledByAccounting(f)
} {
    env e;
    calldataarg args;
    f(e, args);
    assert(e.msg.sender == _Accounting, "Only called by Accounting");
}

// ---- Property: solvency -----------------------------------------------------

invariant bufferedEthBackedByBalance()
    _Lido.getBufferedEther() <= nativeBalances[_Lido]
    filtered {
        // This function is disabled
        f -> (
            !isOnlyCalledByAccounting(f) &&  // This will be verified via Accounting
            !isDepracatedFunc(f) &&
            !isUpgradeFunc(f)
        )
    }
    {
        preserved with (env e) {
            require(
                e.msg.value > 0 => (e.msg.sender != _Lido),
                "Assume Lido does not transfer ETH to self"
            );
        }
    }


// ---- Variable transitions ---------------------------------------------------

/// @dev Returns whether a method mints shares
definition isMintingFunc(method f) returns bool = (
    f.selector == sig:LidoHarness.mintExternalShares(address,uint256).selector ||
    f.selector == sig:LidoHarness.mintShares(address,uint256).selector
);

definition maxReasonableValue() returns mathint = 2^100;

/// @title Relations between total, external and internal shares
rule sharesTransition(method f) filtered {
    f -> (
        !f.isView &&
        f.contract == _Lido && !isDepracatedFunc(f) &&
        // NOTE: Skipping version 3 upgrade as it's not relevant for current verification
        f.selector != sig:LidoHarness.finalizeUpgrade_v3(address, address[],uint256).selector &&
        // Skipping initialization (assuming already initialized)
        f.selector != sig:LidoHarness.initialize(address, address).selector
    )
} {
    uint256 totalPre = _Lido.getTotalShares();
    uint256 extPre = _Lido.getExternalShares();
    uint256 buffPre = _Lido.getBufferedEther();

    require(
        totalPre <= maxReasonableValue() &&
        extPre <= maxReasonableValue() &&
        buffPre <= maxReasonableValue(),
        "Assume reasonable values to avoid overflows"
    );

    env e;
    require(
        e.msg.value < maxReasonableValue() &&
        CVLgetSharesByPooledEth(e.msg.value) < maxReasonableValue(),
        "Assume reasonable ETH transfer value to avoid overflows"
    );

    if (isMintingFunc(f)) {
        address recipient;
        uint256 amountOfShares;
        require(
            amountOfShares < maxReasonableValue(),
            "Assume reasonable values to avoid overflows"
        );
        if (f.selector == sig:LidoHarness.mintExternalShares(address,uint256).selector) {
            _Lido.mintExternalShares(e, recipient, amountOfShares);
        } else if (f.selector == sig:LidoHarness.mintShares(address,uint256).selector) {
            _Lido.mintShares(e, recipient, amountOfShares);
        }
    } else {
        calldataarg args;
        f(e, args);
    }

    uint256 totalPost = _Lido.getTotalShares();
    uint256 extPost = _Lido.getExternalShares();
    uint256 buffPost = _Lido.getBufferedEther();

    assert(
        extPost > extPre => totalPost - totalPre == extPost - extPre,
        "Increase in external shares implies the same increase in total shares"
    );
    assert(
        (extPost == extPre && totalPost > totalPre) => (
            buffPost > buffPre ||  // Someone deposited ETH for shares
            f.selector == sig:LidoHarness.mintShares(address, uint256).selector
        ),
        "When internal shares are minted"
    );
    assert(
        extPost < extPre => (
            (totalPost == totalPre && buffPost > buffPre) ||
            (totalPre - totalPost == extPre - extPost) ||
            (
                totalPost == totalPre &&
                buffPost == buffPre &&
                f.selector == sig:LidoHarness.internalizeExternalBadDebt(uint256).selector
            )
        ),
        "Either rebalanced externa or burned external shares or internalized bad debt"
    );
    assert(
        (totalPost < totalPre && extPost == extPre) =>
        f.selector == sig:LidoHarness.burnShares(uint256).selector,
        "Only burning internal shares can reduce the total but not the external shares"
    );
}

// ---- Staking limits ---------------------------------------------------------

/// @dev Returns true of the function pauses staking
definition isPausingStakingFunc(method f) returns bool = (
    f.selector == sig:LidoHarness.pauseStaking().selector ||
    f.selector == sig:LidoHarness.stop().selector
);

/// @title Previous staking block number is weakly monotonically increasing
rule prevStakingBlockNumberIncreasing(method f) filtered {
    f -> !isDepracatedFunc(f) && !f.isView
} {
    uint32 prevStakeBlockNumber = _Lido.getPrevStakeBlockNumber();

    env e;
    require(
        e.block.number <= max_uint32,
        "Assume reasonable number, avoid overflow when casting to uint32"
    );
    calldataarg args;
    f(e, args);
    
    uint32 curStakeBlockNumber = _Lido.getPrevStakeBlockNumber();

    assert(
        curStakeBlockNumber == prevStakeBlockNumber ||
        curStakeBlockNumber == e.block.number ||
        (curStakeBlockNumber == 0 && isPausingStakingFunc(f)),
        "Value is either the current block number or previous value or zero and staking paused"
    );
}


/// @title Staking limits cannot change in the same function that stakes
rule stakingLimitsUnchangedIfStaking(method f) filtered {
    f -> !isDepracatedFunc(f) && !f.isView
} {
    uint256 internalEthPre = _Lido.getInternalEther();

    uint96 maxStakeLimitPre = _Lido.getMaxStakeLimit();
    uint32 maxStakeLimitGrowthBlocksPre = _Lido.getMaxStakeLimitGrowthBlocks();

    env e;
    calldataarg args;
    f(e, args);

    uint256 internalEthPost = _Lido.getInternalEther();
    
    uint96 maxStakeLimitPost = _Lido.getMaxStakeLimit();
    uint32 maxStakeLimitGrowthBlocksPost = _Lido.getMaxStakeLimitGrowthBlocks();

    assert(
        internalEthPost != internalEthPre => (
            maxStakeLimitPre == maxStakeLimitPost &&
            maxStakeLimitGrowthBlocksPre == maxStakeLimitGrowthBlocksPost
        )
    );
    assert(
        (
            maxStakeLimitPre != maxStakeLimitPost ||
            maxStakeLimitGrowthBlocksPre != maxStakeLimitGrowthBlocksPost
        ) => internalEthPost == internalEthPre
    );
}


definition internalShares() returns mathint = (
    _Lido.getTotalShares() - _Lido.getExternalShares()
);

/// @title Internal ETH and shares increase cannot violate the staking limits
rule stakingLimitsAreKept(method f) filtered {
    f -> (
        !isDepracatedFunc(f) && !f.isView && !isUpgradeFunc(f) &&
        // Initialize function can bypass the staking limits
        f.selector != sig:LidoHarness.initialize(address,address).selector &&
        // rebalanceExternalEtherToInternal does not check for staking limit, it's an accepted behavior from Lido
        f.selector != sig:LidoHarness.rebalanceExternalEtherToInternal(uint256).selector &&
        // resumeStaking is vacuous due to `require(isStakingPaused())`
        f.selector != sig:LidoHarness.resumeStaking().selector &&
        // Ignore `Accounting.handleOracleReport` since it mints shares as fees
        f.contract != _Accounting
    )
} {
    env eInfo;  // Needed since `e.msg.value` might not be zero
    bool isStakingPaused;
    bool isStakingLimitSet;
    (isStakingPaused, isStakingLimitSet, _, _, _, _, _) = _Lido.getStakeLimitFullInfo(eInfo);
    require(!isStakingPaused && isStakingLimitSet, "Assume staking is possible");


    uint96 prevStakeLimit = _Lido.getPrevStakeLimit();
    uint32 prevStakeBlockNumber = _Lido.getPrevStakeBlockNumber();
    uint96 maxStakeLimit = _Lido.getMaxStakeLimit();
    uint32 maxStakeLimitGrowthBlocks = _Lido.getMaxStakeLimitGrowthBlocks();

    mathint bufferedEthPre = _Lido.getBufferedEther();
    mathint initernalSharesPre = internalShares();

    env e;
    require(e.block.number >= prevStakeBlockNumber, "Assume block numbers increase");
    require(e.block.number <= max_uint32,"Assume reasonable number, avoid overflow when casting to uint32");
    calldataarg args;
    f(e, args);

    uint256 bufferedEthPost = _Lido.getBufferedEther();
    mathint initernalSharesPost = internalShares();

    mathint ethDiff = bufferedEthPost - bufferedEthPre;
    mathint sharesDiff = initernalSharesPost - initernalSharesPre;
    mathint blockDiff = e.block.number - prevStakeBlockNumber;

    assert(
        (sharesDiff > 0 && maxStakeLimitGrowthBlocks != 0) => (
            ethDiff <=
            prevStakeLimit + (maxStakeLimit / maxStakeLimitGrowthBlocks) * blockDiff
        ),
        "Maximal staking per block must not be breached"
    );
}

// ---- Variable transitions ---------------------------------------------------

definition isIncreasingTotalShares(method f) returns bool = (
    f.selector == sig:LidoHarness.submit(address).selector ||
    f.selector == sig:LidoHarness.mintShares(address,uint256).selector ||
    f.selector == sig:LidoHarness.mintExternalShares(address,uint256).selector ||
    f.isFallback ||
    // The initialize function mints one share
    f.selector == sig:LidoHarness.initialize(address,address).selector ||
    (f.contract == _Accounting && !f.isView)  // Accounting mints fee shares
);

definition isDecreasingTotalShares(method f) returns bool = (
    f.selector == sig:LidoHarness.burnShares(uint256).selector ||
    f.selector == sig:LidoHarness.burnExternalShares(uint256).selector ||
    (f.contract == _Accounting && !f.isView)  // Accounting burns shares
);

/// @title Determines the functions that can increase or decrease the total shares
rule totalSharesCanOnlyBeChangedBy(method f) filtered {
    f -> !isDepracatedFunc(f) && !f.isView && !isUpgradeFunc(f)

} {
    uint256 sharesPre = _Lido.getTotalShares();

    env e;
    require(
        sharesPre <= 2^100 &&
        _Lido.getExternalShares() < 2^100 &&
        CVLgetSharesByPooledEth(e.msg.value) <= 2^100,
        "Prevent overflow of shares"
    );
    if (f.selector == sig:LidoHarness.mintShares(address,uint256).selector) {
        // Special handling to avoid overflow
        address _recipient;
        uint256 _amountOfShares;
        require(_amountOfShares < 100, "Prevent overflow of shares");
        _Lido.mintShares(e, _recipient, _amountOfShares);
    } else if (f.selector == sig:LidoHarness.mintExternalShares(address,uint256).selector) {
        // Special handling to avoid overflow
        address _recipient;
        uint256 _amountOfShares;
        require(_amountOfShares < 100, "Prevent overflow of shares");
        _Lido.mintExternalShares(e, _recipient, _amountOfShares);
    } else {
        calldataarg args;
        f(e, args);
    }

    uint256 sharesPost = _Lido.getTotalShares();
    assert(sharesPost > sharesPre => isIncreasingTotalShares(f));
    assert(sharesPost < sharesPre => isDecreasingTotalShares(f));
}


definition isChangingBufferedEth(method f) returns bool = (
    f.selector == sig:LidoHarness.deposit(uint256,uint256,bytes).selector ||
    f.selector == sig:LidoHarness.submit(address).selector ||
    f.selector == sig:LidoHarness.mintShares(address,uint256).selector ||
    f.selector == sig:LidoHarness.rebalanceExternalEtherToInternal(uint256).selector ||
    f.selector == sig:LidoHarness.collectRewardsAndProcessWithdrawals(
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256 
    ).selector ||
    f.selector == sig:LidoHarness.initialize(address,address).selector ||
    f.isFallback ||
    (f.contract == _Accounting && !f.isView)
);

/// @title Determines the functions that can change the buffered ETH
rule bufferedEthCanOnlyBeChangedBy(method f) filtered {
    f -> !isDepracatedFunc(f) && !f.isView && !isUpgradeFunc(f)

} {
    uint256 bufferedEthPre = _Lido.getBufferedEther();

    env e;
    calldataarg args;
    f(e, args);

    uint256 bufferedEthPost = _Lido.getBufferedEther();
    assert(bufferedEthPre != bufferedEthPost => isChangingBufferedEth(f));
}


definition isChangingDepositedValidators(method f) returns bool = (
    f.selector == sig:LidoHarness.deposit(uint256,uint256,bytes).selector ||
    f.selector == sig:LidoHarness.unsafeChangeDepositedValidators(uint256).selector
);


rule depositedValidatorsOnlyIncreasing(method f) filtered {
    f -> (
        !isDepracatedFunc(f) && !f.isView &&
        // `finalizeUpgrade_v3` initializes the `depositedValidators`
        f.selector != sig:LidoHarness.finalizeUpgrade_v3(address,address[],uint256).selector &&
        // This method can change the number to anything
        f.selector != sig:LidoHarness.unsafeChangeDepositedValidators(uint256).selector
    )

} {
    uint256 validatorsPre = _Lido.getDepositedValidators(); 
    uint256 bufferedEthPre = _Lido.getBufferedEther();

    env e;
    if (f.selector == sig:LidoHarness.deposit(uint256,uint256,bytes).selector) {
        uint256 _maxDepositsCount;
        uint256 _stakingModuleId;
        bytes _depositCalldata;
        require(
            validatorsPre + _maxDepositsCount <= max_uint128, "Avoid overflow"
        );
        _Lido.deposit(e, _maxDepositsCount, _stakingModuleId, _depositCalldata);
    } else {
        calldataarg args;
        f(e, args);
    }

    uint256 validatorsPost = _Lido.getDepositedValidators(); 
    uint256 bufferedEthPost = _Lido.getBufferedEther();
    assert(validatorsPost >= validatorsPre, "deposited validators only increase");
    assert(
        validatorsPost > validatorsPre => (
            bufferedEthPost < bufferedEthPre && isChangingDepositedValidators(f)
        ),
        "adding validators by depositing ETH"
    );
}

// ---- Changing internal ETH --------------------------------------------------
