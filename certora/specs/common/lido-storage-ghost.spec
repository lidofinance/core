/* Summarizes some of `Lido` storage slots as ghosts */
using LidoHarness as _Lido;

methods {
    // Total and external shares
    function Lido._getExternalShares() internal returns (uint256) => externalSharesGhost;
    function Lido._setExternalShares(
        uint256 _externalShares
    ) internal => CVLsetExternalShares(_externalShares);
    function Lido._getTotalAndExternalShares(
    ) internal returns (uint256, uint256) => CVLgetTotalAndExternalShares();
    function StETH._getTotalShares() internal returns (uint256) => totalSharesGhost;
    
    // MUNGING RELATED
    function StETH._setTotalShares(uint256 newTotalShares) internal => CVLsetTotalShares(newTotalShares);

    // `LidoLocator` and `MaxExternalRatioBP`
    function Lido._setMaxExternalRatioBP(
        uint256 _newMaxExternalRatioBP
    ) internal => CVLsetMaxExternalRatioBP(_newMaxExternalRatioBP);
    function Lido._getMaxExternalRatioBP() internal returns (uint256) => maxExternalRationGhost;

    // `BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION`
    function Lido._getBufferedEther() internal returns (uint256) => buffredEtherGhost;
    function Lido._setBufferedEther(
        uint256 _newBufferedEther
    ) internal => CVLsetBufferedEther(_newBufferedEther);
    function Lido._getDepositedValidators(
    ) internal returns (uint256) => depositredValidatorsGhost;
    function Lido._setDepositedValidators(
        uint256 _newDepositedValidators
    ) internal => CVLsetDepositedValidators(_newDepositedValidators);
    function Lido._getBufferedEtherAndDepositedValidators(
    ) internal returns (uint256, uint256) => CVLgetBufferedEtherAndDepositedValidators();

    // `CL_BALANCE_AND_CL_VALIDATORS_POSITION`
    function Lido._getClBalanceAndClValidators(
    ) internal returns (uint256, uint256) => CVLgetClBalanceAndClValidators();
    function Lido._setClBalanceAndClValidators(
        uint256 _newClBalance, uint256 _newClValidators
    ) internal => CVLsetClBalanceAndClValidators(_newClBalance, _newClValidators);

    // `STAKING_STATE_POSITION`
    // `StakeLimitUnstructuredStorage`
    function StakeLimitUnstructuredStorage.getStorageStakeLimitStruct(
        bytes32
    ) internal returns (StakeLimitState.Data memory) => CVLgetStorageStakeLimitStruct();
    function StakeLimitUnstructuredStorage.setStorageStakeLimitStruct(
        bytes32 _position, StakeLimitState.Data memory _data
    ) internal => CVLsetStorageStakeLimitStruct(_data);
}

// ---- Ghost storage ----------------------------------------------------------
// NOTE The ghost variables here follow the storage described in `Lido.sol`
// Lines 97-128

// `TOTAL_AND_EXTERNAL_SHARES_POSITION`
ghost uint128 externalSharesGhost;
ghost uint128 totalSharesGhost;

// `LOCATOR_AND_MAX_EXTERNAL_RATIO_POSITION`
ghost uint96 maxExternalRationGhost;

// `BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION`
ghost uint128 buffredEtherGhost;
ghost uint128 depositredValidatorsGhost;

// `CL_BALANCE_AND_CL_VALIDATORS_POSITION`
ghost uint128 clBalanceGhost;
ghost uint128 clValidatorsGhost;

// `STAKING_STATE_POSITION`
// Contains four variables packed into `uint256`:
ghost uint32 prevStakeBlockNumberGhost; 
ghost uint96 prevStakeLimitGhost;
ghost uint32 maxStakeLimitGrowthBlocksGhost;
ghost uint96 maxStakeLimitGhost;


// ---- Summaries --------------------------------------------------------------

function CVLsetExternalShares(uint256 _externalShares) {
    // NOTE: This is unsound - truncates to uint128 without validation
    externalSharesGhost = require_uint128(_externalShares);
}


function CVLgetTotalAndExternalShares() returns (uint256, uint256) {
    return (totalSharesGhost, externalSharesGhost);
}


function CVLsetTotalShares(uint256 newTotalShares) {
    // NOTE: This is unsound - truncates to uint128 without validation
    totalSharesGhost = require_uint128(newTotalShares);
}


function CVLsetMaxExternalRatioBP(uint256 _newMaxExternalRatioBP) {
    // NOTE: This is unsound - truncates to uint96 without validation
    maxExternalRationGhost = require_uint96(_newMaxExternalRatioBP);
}


function CVLsetBufferedEther(uint256 _newBufferedEther) {
    // NOTE: This is unsound - truncates to uint128 without validation
    buffredEtherGhost = require_uint128(_newBufferedEther);
}


function CVLsetDepositedValidators(uint256 _newDepositedValidators) {
    // NOTE: This is unsound - truncates to uint128 without validation
    depositredValidatorsGhost = require_uint128(_newDepositedValidators);
}


function CVLgetBufferedEtherAndDepositedValidators() returns (uint256, uint256) {
    return (buffredEtherGhost, depositredValidatorsGhost);
}


function CVLgetClBalanceAndClValidators() returns (uint256, uint256) {
    return (clBalanceGhost, clValidatorsGhost);
}


function CVLsetClBalanceAndClValidators(uint256 _newClBalance, uint256 _newClValidators) {
    // NOTE: This is unsound - truncates to uint128 without validation
    clBalanceGhost = require_uint128(_newClBalance);
    clValidatorsGhost = require_uint128(_newClValidators);
}


function CVLsetClValidators(uint256 _newClValidators) {
    // NOTE: This is unsound - truncates to uint128 without validation
    clValidatorsGhost = require_uint128(_newClValidators);
}


/// @dev NOTE this assumes only references to `STAKING_STATE_POSITION` slot are used!
function CVLgetStorageStakeLimitStruct() returns StakeLimitState.Data {
    StakeLimitState.Data ret;
    require(ret.prevStakeBlockNumber == prevStakeBlockNumberGhost, "Correct struct");
    require(ret.prevStakeLimit == prevStakeLimitGhost, "Correct struct");
    require(ret.maxStakeLimitGrowthBlocks == maxStakeLimitGrowthBlocksGhost, "Correct struct");
    require(ret.maxStakeLimit == maxStakeLimitGhost, "Correct struct");
    return ret;
}


/// @dev NOTE this assumes only references to `STAKING_STATE_POSITION` slot are used!
function CVLsetStorageStakeLimitStruct(StakeLimitState.Data data) {
    prevStakeBlockNumberGhost = data.prevStakeBlockNumber;
    prevStakeLimitGhost = data.prevStakeLimit;
    maxStakeLimitGrowthBlocksGhost = data.maxStakeLimitGrowthBlocks;
    maxStakeLimitGhost = data.maxStakeLimit;
}
