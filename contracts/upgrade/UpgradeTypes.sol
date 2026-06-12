// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";
import {IAccessControlEnumerable as IAccessControlEnumerableV4} from "@openzeppelin/contracts-v4.4/access/IAccessControlEnumerable.sol";

import {IVersioned} from "contracts/common/interfaces/IVersioned.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {ModuleStateConfig, StakingModuleConfig} from "contracts/0.8.25/sr/SRTypes.sol";

// ============================
// Interfaces
// ============================

interface IAragonKernel {
    function acl() external view returns (address); //IAragonACL
    function getApp(bytes32 _namespace, bytes32 _appId) external view returns (address);
    function setApp(bytes32 _namespace, bytes32 _appId, address _app) external;
    function APP_BASES_NAMESPACE() external view returns (bytes32);
    function APP_MANAGER_ROLE() external view returns (bytes32);
}

interface IAragonACL {
    function hasPermission(address _who, address _where, bytes32 _what) external view returns (bool);
    function getPermissionManager(address _app, bytes32 _role) external view returns (address);
    function createPermission(address _entity, address _app, bytes32 _role, address _manager) external;
    function grantPermission(address _entity, address _app, bytes32 _role) external;
    function revokePermission(address _entity, address _app, bytes32 _role) external;
}

interface IAragonApp {
    function kernel() external view returns (address); //IAragonKernel
    function appId() external view returns (bytes32);
}

interface IBaseOracle is IAccessControlEnumerableV4, IVersioned {
    function getConsensusContract() external view returns (address);
    function getConsensusVersion() external view returns (uint256);
}

interface IEasyTrack {
    function evmScriptExecutor() external view returns (address);
    function isEVMScriptFactory(address _maybeEVMScriptFactory) external view returns (bool);
    function getEVMScriptFactories() external view returns (address[] memory);
    function addEVMScriptFactory(address _evmScriptFactory, bytes memory _permissions) external;
    function removeEVMScriptFactory(address _evmScriptFactory) external;
}

interface IStakingRouterUpgrade is IAccessControlEnumerable {
    // existing roles

    function getWithdrawalCredentials() external view returns (bytes32);
    function finalizeUpgrade_v4(uint256 _maxTopUpPerBlockGwei) external;
    function updateModuleShares(uint256 _stakingModuleId, uint16 _stakeShareLimit, uint16 _priorityExitShareThreshold)
        external;

    function addStakingModule(
        string calldata _name,
        address _stakingModuleAddress,
        StakingModuleConfig calldata _stakingModuleConfig
    ) external;

    function getStakingModulesCount() external view returns (uint256);
    function getStakingModuleIds() external view returns (uint256[] memory);
    function getStakingModuleStateConfig(uint256 _stakingModuleId)
        external
        view
        returns (ModuleStateConfig memory stateConfig);

    function STAKING_MODULE_SHARE_MANAGE_ROLE() external view returns (bytes32);
    function STAKING_MODULE_UNVETTING_ROLE() external view returns (bytes32);
}

interface IOracleReportSanityCheckerUpgrade {
    function migrateBaselineSnapshot() external;
}

interface IDepositSecurityModule {
    function getOwner() external view returns (address);
    function setOwner(address newValue) external;
    function isGuardian(address addr) external view returns (bool);
    function getGuardianQuorum() external view returns (uint256);
    function getGuardians() external view returns (address[] memory);
    function addGuardians(address[] memory addresses, uint256 newQuorum) external;
}

interface IConsolidationMigrator {
    function allowPair(uint256 sourceOperatorId, uint256 targetOperatorId, address submitter) external;
    function disallowPair(uint256 sourceOperatorId, uint256 targetOperatorId) external;
    function sourceModuleId() external view returns (uint256);
    function targetModuleId() external view returns (uint256);
    function getConsolidationBus() external view returns (address);
}

interface IConsolidationBus {
    function getConsolidationGateway() external view returns (address);
}

interface IMerkleGate {
    function name() external view returns (string memory);
    function curveId() external view returns (uint256);
    function setName(string calldata name) external;
    function setTreeParams(bytes32 treeRoot, string calldata treeCid) external;
}

interface IOneShotCurveSetup {
    function executed() external view returns (bool);
    function deployedCurveId() external view returns (uint256);
    function execute() external returns (uint256 curveId);
}

interface ILidoUpgrade is ILido {
    function getBufferedEther() external view returns (uint256);
    function finalizeUpgrade_v4(uint256 _depositsReserveTarget) external;
}

interface IAccountingOracleUpgrade is IBaseOracle {
    function finalizeUpgrade_v5(uint256 consensusVersion) external;
}

interface IValidatorsExitBusOracleUpgrade is IBaseOracle {
    function finalizeUpgrade_v3(
        uint256 maxValidatorsPerReport,
        uint256 maxExitBalanceEth,
        uint256 balancePerFrameEth,
        uint256 frameDurationInSec,
        uint256 consensusVersion
    ) external;
}

interface IWithdrawalVaultUpgrade {
    function finalizeUpgrade_v3() external;
    function TRIGGERABLE_WITHDRAWALS_GATEWAY() external view returns (address);
    function CONSOLIDATION_GATEWAY() external view returns (address);
}

interface IWithdrawalsManagerProxy {
    function proxy_getAdmin() external view returns (address);
    function implementation() external view returns (address);
    function proxy_upgradeTo(address newImplementation, bytes memory setupCalldata) external;
}

struct WithdrawnValidatorInfo {
    uint256 nodeOperatorId;
    uint256 keyIndex;
    uint256 exitBalance;
    uint256 slashingPenalty;
    bool isSlashed;
}

interface IBaseModuleV3 {
    function LIDO_LOCATOR() external view returns (address);
    function PARAMETERS_REGISTRY() external view returns (address);
    function ACCOUNTING() external view returns (address);
    function EXIT_PENALTIES() external view returns (address);
    function FEE_DISTRIBUTOR() external view returns (address);
    function reportSlashedWithdrawnValidators(WithdrawnValidatorInfo[] calldata validatorInfos) external;
    function settleGeneralDelayedPenalty(uint256[] calldata nodeOperatorIds, uint256[] calldata maxAmounts) external;
}

interface ICuratedModule is IBaseModuleV3 {
    function META_REGISTRY() external view returns (address);
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
    function getConsensusContract() external view returns (address);
}

interface IAccountingV3 {
    function finalizeUpgradeV3() external;
    function FEE_DISTRIBUTOR() external view returns (address);
}

interface IFeeDistributorV3 {
    function ORACLE() external view returns (address);
    function finalizeUpgradeV3() external;
}

interface IValidatorStrikesV3 {
    function ejector() external view returns (address);
    function setEjector(address newEjector) external;
}

interface IUpdateStakingModuleShareLimits {
    struct ModuleShareParams {
        uint16 currentStakeShareLimit;
        uint16 newStakeShareLimit;
        uint16 currentPriorityExitShareThreshold;
        uint16 newPriorityExitShareThreshold;
    }

    function validateParams(ModuleShareParams calldata params) external view;
}

interface ITriggerableWithdrawalsGatewayUpgrade is IAccessControlEnumerable {
    function setExitRequestLimit(uint256 maxExitRequestsLimit, uint256 exitsPerFrame, uint256 frameDurationInSec)
        external;
    function TW_EXIT_LIMIT_MANAGER_ROLE() external view returns (bytes32);
}

interface IHashConsensusV3 {
    function updateInitialEpoch(uint256 epoch) external;
}

interface IMetaRegistry {
    struct SubNodeOperator {
        uint64 nodeOperatorId;
        uint16 share;
    }

    struct ExternalOperator {
        bytes data;
    }

    struct OperatorGroup {
        string name;
        SubNodeOperator[] subNodeOperators;
        ExternalOperator[] externalOperators;
    }

    function createOrUpdateOperatorGroup(uint256 groupId, OperatorGroup calldata groupInfo) external;
}

interface IInitializedVersionView {
    function getInitializedVersion() external view returns (uint64);
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
    address circuitBreaker;
    address easyTrack;

    EasyTrackNewFactories newFactories;
    EasyTrackOldFactories oldFactories;
    // Upgrade config for protocol core
    CoreUpgradeParams coreUpgrade;

    // Upgrade config for CSM/CMv2
    CSMUpgradeParams csmUpgrade;
    CuratedModuleParams curatedModule;
}

struct EasyTrackNewFactories {
    // EasyTrack new factories
    address UpdateStakingModuleShareLimits;
    address AllowConsolidationPair;
    // CSM
    address SetMerkleGateTreeForCSM;
    address ReportWithdrawalsForSlashedValidatorsForCSM;
    address SettleGeneralDelayedPenaltyForCSM;
    // CM
    address SetMerkleGateTreeForCM;
    address ReportWithdrawalsForSlashedValidatorsForCM;
    address SettleGeneralDelayedPenaltyForCM;
    address CreateOrUpdateOperatorGroupForCM;
}

struct EasyTrackOldFactories {
    address CSMSettleElStealingPenalty;
    address CSMSetVettedGateTree;
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

    // New implementations
    address newLocatorImpl;
    address newLidoImpl;
    address newAccountingImpl;
    address newAccountingOracleImpl;
    address newStakingRouterImpl;
    address newWithdrawalVaultImpl;
    address newValidatorsExitBusOracleImpl;
    address consolidationBusImpl;
    address consolidationMigratorImpl;
    address topUpGatewayImpl;

    // New fancy proxy and blueprint contracts
    address consolidationBus;
    address consolidationMigrator;
    address topUpGateway;

    // params
    uint256 lidoDepositsReserveTarget;
    address consolidationCommittee;
    address topUpGatewayDepositor;

    // twGateway limits
    uint256 twMaxExitRequestsLimit;
    uint256 twExitsPerFrame;
    uint256 twFrameDurationInSec;

    // accounting oracle
    uint256 aoConsensusVersion;

    // validators exit bus oracle
    uint256 veboMaxValidatorsPerReport;
    uint256 veboMaxExitBalanceEth;
    uint256 veboBalancePerFrameEth;
    uint256 veboFrameDurationInSec;
    uint256 veboConsensusVersion;

    // staking router
    uint256 maxTopUpPerBlockGwei;
}

struct CSMUpgradeParams {
    address csmProxy;
    address csmImpl;
    address vettedGateProxy;
    address identifiedDVTClusterGate;
    address identifiedDVTClusterCurveSetup;
    uint256 identifiedDVTClusterBondCurveId;
    address parametersRegistryImpl;
    address feeOracleImpl;
    uint256 feeOracleConsensusVersion;
    address vettedGateImpl;
    address accountingImpl;
    address feeDistributorImpl;
    address exitPenaltiesImpl;
    address strikesImpl;
    address oldPermissionlessGate;
    address newPermissionlessGate;
    address oldVerifier;
    address newVerifier;
    address ejector;
    address csmCommittee;
}

struct CuratedModuleParams {
    address module;
    address[] curatedGates;
    address verifier;
    address circuitBreakerPauser;
    string moduleName;
    uint256 stakeShareLimit;
    uint256 priorityExitShareThreshold;
    uint256 stakingModuleFee;
    uint256 treasuryFee;
    uint256 maxDepositsPerBlock;
    uint256 minDepositBlockDistance;
    uint256 feeOracleConsensusVersion;
    uint256 hashConsensusInitialEpoch;
}

//
// ------ Shared configs for VotingScript ------
//

struct GlobalConfig {
    address agent;
    address lido;
    address burner;
    address resealManager;
    address resealCommittee;
    address circuitBreaker;
    address easyTrack;
    address easyTrackEVMScriptExecutor;
    address stakingRouter;
    address triggerableWithdrawalsGateway;
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
    address validatorsExitBusOracle;
    address withdrawalVault;
    address consolidationGateway;
    address consolidationBus;
    address consolidationMigrator;
    address topUpGateway;

    uint256 lidoDepositsReserveTarget;
    address consolidationCommittee;
    address topUpGatewayDepositor;

    uint256 twMaxExitRequestsLimit;
    uint256 twExitsPerFrame;
    uint256 twFrameDurationInSec;

    uint256 aoConsensusVersion;
    uint256 veboMaxValidatorsPerReport;
    uint256 veboMaxExitBalanceEth;
    uint256 veboBalancePerFrameEth;
    uint256 veboFrameDurationInSec;
    uint256 veboConsensusVersion;

    // staking router
    uint256 maxTopUpPerBlockGwei;
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
    address identifiedDVTClusterGate;
    address identifiedDVTClusterCurveSetup;
    uint256 identifiedDVTClusterBondCurveId;
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
    address oldVerifier;
    address newVerifier;
    address newPermissionlessGate;
    address oldEjector;
    address ejector;
    address csmCommittee;
}

struct CuratedModuleConfig {
    address module;
    address[] curatedGates;
    address parametersRegistry;
    address accounting;
    address ejector;
    address verifier;
    address circuitBreakerPauser;
    address feeDistributor;
    address feeOracle;
    address hashConsensus;
    address strikes;
    string moduleName;
    uint256 stakeShareLimit;
    uint256 priorityExitShareThreshold;
    uint256 stakingModuleFee;
    uint256 treasuryFee;
    uint256 maxDepositsPerBlock;
    uint256 minDepositBlockDistance;
    uint256 feeOracleConsensusVersion;
    uint256 hashConsensusInitialEpoch;
    address metaRegistry;
}
