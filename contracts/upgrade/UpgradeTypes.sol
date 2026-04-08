// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    IAccessControl,
    IAccessControlEnumerable
} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
// import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {IVersioned} from "contracts/common/interfaces/IVersioned.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";

// ============================
// Interfaces
// ============================

interface IKernel {
    function acl() external view returns (address); //IACL
    function getApp(bytes32 _namespace, bytes32 _appId) external view returns (address);
    function setApp(bytes32 _namespace, bytes32 _appId, address _app) external;
    function APP_BASES_NAMESPACE() external view returns (bytes32);
}

interface IACL {
    function grantPermission(address _entity, address _app, bytes32 _role) external;
    function revokePermission(address _entity, address _app, bytes32 _role) external;
}

interface IAragonApp {
    function kernel() external view returns (address); //IKernel
    function appId() external view returns (bytes32);
}

interface ITimeConstraints {
    function checkTimeAfterTimestampAndEmit(uint40 timestamp) external;
    function checkTimeBeforeTimestampAndEmit(uint40 timestamp) external;
    function checkTimeWithinDayTimeAndEmit(uint32 startDayTime, uint32 endDayTime) external;
}

interface IBaseOracle is IAccessControlEnumerable, IVersioned {
    function getConsensusContract() external view returns (address);
}

interface IEasyTrack {
    function getEVMScriptFactories() external view returns (address[] memory);
    function evmScriptExecutor() external view returns (address);
    function addEVMScriptFactory(address _evmScriptFactory, bytes memory _permissions) external;
}

interface IStakingRouter is IAccessControlEnumerable {
    // existing roles
    function MANAGE_WITHDRAWAL_CREDENTIALS_ROLE() external view returns (bytes32);
    function STAKING_MODULE_MANAGE_ROLE() external view returns (bytes32);
    function STAKING_MODULE_UNVETTING_ROLE() external view returns (bytes32);
    function REPORT_EXITED_VALIDATORS_ROLE() external view returns (bytes32);
    function UNSAFE_SET_EXITED_VALIDATORS_ROLE() external view returns (bytes32);
    function REPORT_REWARDS_MINTED_ROLE() external view returns (bytes32);
    function REPORT_VALIDATOR_EXITING_STATUS_ROLE() external view returns (bytes32);
    function REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE() external view returns (bytes32);
    function STAKING_MODULE_SHARE_MANAGE_ROLE() external view returns (bytes32);

    function finalizeUpgrade_v4() external;
    function updateModuleShares(uint256 _stakingModuleId, uint16 _stakeShareLimit, uint16 _priorityExitShareThreshold)
        external;

    function addStakingModule(
        string calldata _name,
        address _stakingModuleAddress,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) external;
}

interface IOracleReportSanityChecker is IAccessControlEnumerable {
    function ALL_LIMITS_MANAGER_ROLE() external view returns (bytes32);
    function EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE() external view returns (bytes32);
    function MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE() external view returns (bytes32);
    function MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE() external view returns (bytes32);
    function MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE() external view returns (bytes32);
    function REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE() external view returns (bytes32);
    function MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE() external view returns (bytes32);
    function SECOND_OPINION_MANAGER_ROLE() external view returns (bytes32);
    function INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE() external view returns (bytes32);
}

interface IConsolidationMigrator {
    function allowPair(uint256 sourceOperatorId, uint256 targetOperatorId, address submitter) external;
    function disallowPair(uint256 sourceOperatorId, uint256 targetOperatorId) external;
}

interface ILidoWithFinalizeUpgrade is ILido {
    function getBufferedEther() external view returns (uint256);
    function finalizeUpgrade_v4() external;
}

interface IAccountingOracle is IBaseOracle {
    function finalizeUpgrade_v5(uint256 consensusVersion) external;
}

interface IWithdrawalVault {
    function finalizeUpgrade_v3() external;
}

interface IProxyAdmin {
    function proxy_getAdmin() external view returns (address);
    function implementation() external view returns (address);
    function proxy_upgradeTo(address newImplementation, bytes memory setupCalldata) external;
}

interface IBaseModuleV3 {
    function LIDO_LOCATOR() external view returns (address);
    function PARAMETERS_REGISTRY() external view returns (address);
    function ACCOUNTING() external view returns (address);
    function EXIT_PENALTIES() external view returns (address);
    function FEE_DISTRIBUTOR() external view returns (address);
}

interface IOssifiableProxyV2 {
    function proxy__upgradeTo(address newImplementation_) external;
    function proxy__upgradeToAndCall(address newImplementation_, bytes calldata setupCalldata_) external;
}

interface ICSModuleV3 {
    function finalizeUpgradeV3() external;
    function resume() external;
}

interface IParametersRegistryV3 {
    function finalizeUpgradeV3() external;
}

interface IFeeOracleV3 {
    function finalizeUpgradeV3(uint256 consensusVersion) external;
    function STRIKES() external view returns (address);
}

interface IAccountingV3 {
    function finalizeUpgradeV3() external;
    function FEE_DISTRIBUTOR() external view returns (address);
}

interface IFeeDistributorV3 {
    function ORACLE() external view returns (address);
    function finalizeUpgradeV3() external;
}

interface IPausableRole {
    function PAUSE_ROLE() external view returns (bytes32);
}

interface IValidatorStrikesV3 {
    function ejector() external view returns (address);
    function setEjector(address newEjector) external;
}

interface ITriggerableWithdrawalsGateway {
    function setExitRequestLimit(uint256 maxExitRequestsLimit, uint256 exitsPerFrame, uint256 frameDurationInSec)
        external;
}

interface IHashConsensusV3 {
    function updateInitialEpoch(uint256 epoch) external;
}

// ============================
// Shared types
// ============================

interface IUpgradeConfig {
    function LOCATOR() external view returns (address);
    function AGENT() external view returns (address);
    function VOTING() external view returns (address);
    function DUAL_GOVERNANCE() external view returns (address);

    function getGeneralConfig() external view returns (GeneralConfig memory);
    function getCoreUpgradeConfig() external view returns (CoreUpgradeConfig memory);
    function getCSMUpgradeConfig() external view returns (CSMUpgradeConfig memory);
    function getCuratedModuleConfig() external view returns (CuratedModuleConfig memory);
}

//
// ------ Template deploy configuration params ------
//

struct UpgradeParameters {
    // Existing contracts
    address locator;
    address agent;
    address voting;
    address dualGovernance;
    address resealManager;
    address easyTrack;

    // Upgrade config for protocol core
    CoreUpgradeParams coreUpgrade;

    // Upgrade config for CSM/CMv2
    CSMUpgradeParams csmUpgrade;
    CuratedModuleParams curatedModule;
}

struct CoreUpgradeParams {
    // Old implementations
    address oldLocatorImpl;
    address oldLidoImpl;
    address oldAccountingImpl;
    address oldAccountingOracleImpl;
    address oldStakingRouterImpl;
    address oldWithdrawalVaultImpl;
    address oldValidatorsExitBusOracleImpl;
    address oldOracleReportSanityChecker;
    address oldDepositSecurityModule;

    // New implementations
    address newLocatorImpl;
    address newLidoImpl;
    address newAccountingImpl;
    address newAccountingOracleImpl;
    address newStakingRouterImpl;
    address newWithdrawalVaultImpl;
    address newValidatorsExitBusOracleImpl;
    address newOracleReportSanityChecker;
    address newDepositSecurityModule;
    address consolidationBusImpl;
    address consolidationMigratorImpl;
    address topUpGatewayImpl;

    // New fancy proxy and blueprint contracts
    address consolidationBus;
    address consolidationMigrator;
    address topUpGateway;

    // params
    uint256 lidoDepositsReserveTarget;
    address consolidationGatewayGateSeal;
    address consolidationBusExecutor;
    address consolidationManagerCommittee;
    address topUpGatewayDepositor;

    // EasyTrack new factories
    address etfUpdateStakingModuleShareLimits;
    address etfAllowConsolidationPair;
}

struct CSMUpgradeParams {
    address csmProxy;
    address csmImpl;
    address vettedGateProxy;
    address parametersRegistryImpl;
    address feeOracleImpl;
    uint256 feeOracleConsensusVersion;
    address vettedGateImpl;
    address accountingImpl;
    address feeDistributorImpl;
    address exitPenaltiesImpl;
    address strikesImpl;
    address oldPermissionlessGate;
    address permissionlessGate;
    address verifier;
    address verifierV3;
    address ejector;
    address identifiedCommunityStakersGateManager;
    address gateSeal;
    address gateSealV3;
    address generalDelayedPenaltyReporter;
    address penaltiesManager;
}

struct CuratedModuleParams {
    address module;
    address hashConsensus;
    string moduleName;
    uint256 stakeShareLimit;
    uint256 priorityExitShareThreshold;
    uint256 stakingModuleFee;
    uint256 treasuryFee;
    uint256 maxDepositsPerBlock;
    uint256 minDepositBlockDistance;
    uint256 hashConsensusInitialEpoch;
}

//
// ------ Shared configs for VotingScript ------
//

struct GeneralConfig {
    address agent;
    address burner;
    address resealManager;
    address easyTrack;
    address easyTrackEVMScriptExecutor;
    address stakingRouter;
    address triggerableWithdrawalsGateway;
    // address accountingOracle;
    // address topUpGateway;
    // address withdrawalVault;
}

struct CoreUpgradeConfig {
    address kernel;
    address acl;
    bytes32 lidoAppId;

    address locator;

    address oldLocatorImpl;
    address oldLidoImpl;
    address oldAccountingImpl;
    address oldAccountingOracleImpl;
    address oldStakingRouterImpl;
    address oldWithdrawalVaultImpl;
    address oldValidatorsExitBusOracleImpl;
    address oldOracleReportSanityChecker;
    address oldDepositSecurityModule;

    address newLocatorImpl;
    address newLidoImpl;
    address newAccountingImpl;
    address newAccountingOracleImpl;
    address newStakingRouterImpl;
    address newWithdrawalVaultImpl;
    address newValidatorsExitBusOracleImpl;
    address newOracleReportSanityChecker;
    address newDepositSecurityModule;
    address consolidationBusImpl;
    address consolidationMigratorImpl;
    address topUpGatewayImpl;

    address accounting;
    address accountingOracle;
    address withdrawalVault;
    address consolidationGateway;
    address consolidationBus;
    address consolidationMigrator;
    address topUpGateway;

    uint256 lidoDepositsReserveTarget;
    address consolidationGatewayGateSeal;
    address consolidationBusExecutor;
    address consolidationManagerCommittee;
    address topUpGatewayDepositor;

    address etfUpdateStakingModuleShareLimits;
    address etfAllowConsolidationPair;
}

struct CSMUpgradeConfig {
    address csm;
    address csmImpl;
    address parametersRegistry;
    address parametersRegistryImpl;
    address feeOracle;
    address feeOracleImpl;
    uint256 feeOracleConsensusVersion;
    address vettedGate;
    address vettedGateImpl;
    address accounting;
    address accountingImpl;
    address feeDistributor;
    address feeDistributorImpl;
    address exitPenalties;
    address exitPenaltiesImpl;
    address strikes;
    address strikesImpl;
    address oldPermissionlessGate;
    address verifier;
    address verifierV3;
    address permissionlessGate;
    address ejector;
    address identifiedCommunityStakersGateManager;
    address gateSeal;
    address gateSealV3;
    address generalDelayedPenaltyReporter;
    address penaltiesManager;
}

struct CuratedModuleConfig {
    address module;
    address accounting;
    address ejector;
    address hashConsensus;
    string moduleName;
    uint256 stakeShareLimit;
    uint256 priorityExitShareThreshold;
    uint256 stakingModuleFee;
    uint256 treasuryFee;
    uint256 maxDepositsPerBlock;
    uint256 minDepositBlockDistance;
    uint256 hashConsensusInitialEpoch;
}
