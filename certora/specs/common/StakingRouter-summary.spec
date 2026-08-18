/* Summarizes main functions of the `StakingRouter` 

Note that most functions are summarized as `NONDET`, but some return values are constant.
NOTE These summaries are not sound in general.
*/

methods {
    function _.getStakingRewardsDistribution(
    ) external => CVLgetStakingRewardsDistribution() expect (
        address[], uint256[], uint96[], uint96, uint256
    );
    function _.getStakingModuleMaxDepositsCount(uint256, uint256) external => NONDET;

    // NOTE: Strictly speaking this summary of `reportRewardsMinted` is not sound. However
    // the only side effects occur via calls to `NodeOperatorsRegistry.onRewardsMinted`.
    function _.reportRewardsMinted(uint256[], uint256[]) external => NONDET;

    // TODO: The summary of `deposit` is not sound, in particular it does not transfer
    // the deposited amount to the `DEPOSIT_CONTRACT`.
    // NOTE: `StakingRouter.deposit` is called by `Lido.deposit`
    function _.deposit(uint256, uint256, bytes) external => NONDET;

    function _.getStakingModuleIds() external => CVLgetStakingModuleIds() expect (uint256[]);
    function _.getStakingModule(
        uint256 moduleId
    ) external => CVLgetStakingModule(moduleId) expect StakingRouter.StakingModule;
}

/// @dev See `StakingRouter.FEE_PRECISION_POINTS`
definition FEE_PRECISION_POINTS() returns uint256 = 10^20;

/// @dev The `totalFee` returned by `StakingRouter.getStakingRewardsDistribution`
ghost uint96 totalFeeGhost;

/// @dev Summary of `StakingRouter.getStakingRewardsDistribution` where `totalFee`
/// and `precisionPoints` are constant and the return values are non-deterministic.
function CVLgetStakingRewardsDistribution() returns (
    address[], // `recipients`
    uint256[], // `stakingModuleIds`
    uint96[], // `stakingModuleFees`
    uint96, // `totalFee`
    uint256 // `precisionPoints`
) {
    address[] recipients;
    address a0;
    address a1;
    require(a0 != 0 && a1 != 0, "Valid non-zero recipient addresses");
    require(
        (recipients.length > 0 => recipients[0] == a0) &&
        (recipients.length > 1 => recipients[1] == a1),
        "Ensure the `recipients` array does not contain non-address values"
    );

    uint256[] stakingModuleIds;
    uint96[] stakingModuleFees;
    require(
        stakingModuleIds.length == stakingModuleFees.length &&
        recipients.length == stakingModuleFees.length,
        "Prevent revert due to lengths mismatch"
    );

    uint96 fee0;
    uint96 fee1;
    require(
        (stakingModuleFees.length > 0 => stakingModuleFees[0] == fee0) &&
        (stakingModuleFees.length > 1 => stakingModuleFees[1] == fee1),
        "Ensure the `stakingModuleFees` array does not contain illegal values"
    );
    uint96 sumFees = require_uint96(fee0 + fee1);
    require(totalFeeGhost >= sumFees, "Total fee is at least sum module fees");

    return (
        recipients,
        stakingModuleIds,
        stakingModuleFees,
        totalFeeGhost,
        FEE_PRECISION_POINTS()
    );
}


ghost uint256 numModules;
ghost uint256 module0Id;
ghost uint256 module1Id;

function CVLgetStakingModuleIds() returns uint256[] {
    uint256[] ret;
    require(ret.length == numModules && numModules <= 2, "Assuming loop_iter <= 2");
    require(numModules > 0 => ret[0] == module0Id, "Fixed zero'th module id");
    require(numModules > 1 => ret[1] == module1Id, "Fixed first module id");
    return ret;
}


ghost mapping(uint256 => uint24) stakingModuleId;
ghost mapping(uint256 => address) stakingModuleAddress;
ghost mapping(uint256 => uint16) stakingModuleFee;
ghost mapping(uint256 => uint16) stakingModuleTreasuryFee;
ghost mapping(uint256 => uint16) stakingModulestakeShareLimit;
ghost mapping(uint256 => uint256) stakingModuleexitedValidatorsCount;

function CVLgetStakingModule(uint256 moduleId) returns StakingRouter.StakingModule {
    StakingRouter.StakingModule ret;
    require(
        ret.id == stakingModuleId[moduleId] &&
        ret.stakingModuleAddress == stakingModuleAddress[moduleId] &&
        ret.stakingModuleFee == stakingModuleFee[moduleId] &&
        ret.treasuryFee == stakingModuleTreasuryFee[moduleId] &&
        ret.stakeShareLimit == stakingModulestakeShareLimit[moduleId] &&
        ret.exitedValidatorsCount == stakingModuleexitedValidatorsCount[moduleId],
        "Staking modules unchanged"
    );
    return ret;
}
