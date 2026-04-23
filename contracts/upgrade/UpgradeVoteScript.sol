// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {Strings} from "@openzeppelin/contracts-v5.2/utils/Strings.sol";
import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {StakingModuleConfig} from "contracts/0.8.25/sr/SRTypes.sol";
import {OmnibusBase} from "./utils/OmnibusBase.sol";
import {UpgradeTemplate, UpgradeConfig} from "./UpgradeTemplate.sol";
import {CallsScriptBuilder} from "./utils/CallScriptBuilder.sol";
import {IForwarder} from "./interfaces/IForwarder.sol";
import {

    // ITimeConstraints,
    GlobalConfig,
    EasyTrackNewFactories,

    // EasyTrackOldFactories,
    CoreUpgradeConfig,
    CSMUpgradeConfig,
    CuratedModuleConfig,
    IAragonKernel,
    IAragonACL,
    ILidoUpgrade,
    IEasyTrack,
    IStakingRouterUpgrade,
    IAccountingOracleUpgrade,
    IValidatorsExitBusOracleUpgrade,
    IWithdrawalVaultUpgrade,
    IConsolidationMigrator,
    IWithdrawalsManagerProxy,
    IOssifiableProxyV2,
    ICSModuleV3,
    IHashConsensusV3,
    IParametersRegistryV3,
    IFeeOracleV3,
    IAccountingV3,
    IFeeDistributorV3,
    IValidatorStrikesV3,
    IBaseModuleV3,
    IAllowedMerkleGatesRegistry,
    IMerkleGate,
    IMetaRegistry,
    ITriggerableWithdrawalsGatewayUpgrade
} from "./UpgradeTypes.sol";

/// @title UpgradeVoteScript
/// @notice Script for upgrading Lido protocol components
contract UpgradeVoteScript is OmnibusBase {
    using Strings for uint256;
    using CallsScriptBuilder for CallsScriptBuilder.Context;

    error InvalidItemsCount(uint256 actual, uint256 expected);
    //
    // Constants
    //
    // TODO set upon finish with items
    uint256 public constant DG_ITEMS_COUNT = 57;
    uint256 public constant VOTING_ITEMS_COUNT = 9;

    // Aragon Kernel APP_BASES_NAMESPACE
    bytes32 internal constant KERNEL_APP_BASES_NAMESPACE = keccak256("base");
    bytes32 internal constant APP_MANAGER_ROLE = keccak256("APP_MANAGER_ROLE");
    bytes32 internal constant BUFFER_RESERVE_MANAGER_ROLE = keccak256("BUFFER_RESERVE_MANAGER_ROLE");
    bytes32 internal constant STAKING_MODULE_SHARE_MANAGE_ROLE = keccak256("STAKING_MODULE_SHARE_MANAGE_ROLE");
    bytes32 internal constant STAKING_MODULE_UNVETTING_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");

    bytes32 internal constant REPORT_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("REPORT_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 internal constant SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 internal constant REPORT_GENERAL_DELAYED_PENALTY_ROLE = keccak256("REPORT_GENERAL_DELAYED_PENALTY_ROLE");
    bytes32 internal constant SETTLE_GENERAL_DELAYED_PENALTY_ROLE = keccak256("SETTLE_GENERAL_DELAYED_PENALTY_ROLE");
    bytes32 internal constant REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE =
        keccak256("REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE");
    bytes32 internal constant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE =
        keccak256("REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE");
    bytes32 internal constant START_REFERRAL_SEASON_ROLE = keccak256("START_REFERRAL_SEASON_ROLE");
    bytes32 internal constant END_REFERRAL_SEASON_ROLE = keccak256("END_REFERRAL_SEASON_ROLE");
    bytes32 internal constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
    bytes32 internal constant CREATE_NODE_OPERATOR_ROLE = keccak256("CREATE_NODE_OPERATOR_ROLE");
    bytes32 internal constant MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE =
        keccak256("MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE");
    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant REQUEST_BURN_MY_STETH_ROLE = keccak256("REQUEST_BURN_MY_STETH_ROLE");
    bytes32 internal constant REQUEST_BURN_SHARES_ROLE = keccak256("REQUEST_BURN_SHARES_ROLE");
    bytes32 internal constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 internal constant SET_TREE_ROLE = keccak256("SET_TREE_ROLE");
    bytes32 internal constant MANAGE_OPERATOR_GROUPS_ROLE = keccak256("MANAGE_OPERATOR_GROUPS_ROLE");
    bytes32 internal constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");
    //
    // Immutables
    //
    address public immutable TEMPLATE;
    address public immutable CONFIG;
    address public immutable TIME_CONSTRAINTS;
    uint32 public immutable ENABLED_DAY_SPAN_START; // = 50400; // 14:00 UTC
    uint32 public immutable ENABLED_DAY_SPAN_END; // = 82800; // 23:00 UTC
    address internal immutable AGENT;

    struct ScriptParams {
        address upgradeTemplate;
        address timeConstraints;
        uint32 enabledDaySpanStart;
        uint32 enabledDaySpanEnd;
    }

    constructor(ScriptParams memory _params)
        OmnibusBase(
            UpgradeConfig(UpgradeTemplate(_params.upgradeTemplate).CONFIG()).VOTING(),
            UpgradeConfig(UpgradeTemplate(_params.upgradeTemplate).CONFIG()).DUAL_GOVERNANCE()
        )
    {
        UpgradeTemplate template = UpgradeTemplate(_params.upgradeTemplate);
        UpgradeConfig config = UpgradeConfig(template.CONFIG());
        TEMPLATE = address(template);
        CONFIG = address(config);
        AGENT = config.AGENT();
        TIME_CONSTRAINTS = _params.timeConstraints;
        ENABLED_DAY_SPAN_START = _params.enabledDaySpanStart; // e.g. 50400 = 14:00 UTC
        ENABLED_DAY_SPAN_END = _params.enabledDaySpanEnd; // e.g. 82800 = 23:00 UTC
    }

    /// @dev Non DG voting items
    function getVotingVoteItems() public view override returns (VoteItem[] memory) {
        //  start from `2` as `1` is reserved for DG submission item
        return _wrapItemsNumber(_getVotingVoteItems(), 2);
    }

    /// @dev DG voting items
    function getVoteItemsRaw() external view returns (VoteItem[] memory) {
        // set prefix to `1`, so all item's description will transform to `1.N. Description...`
        return _wrapItemsPrefixNumber(_getVoteItems(), 1, 1);
    }

    function getVoteItemsPacked() external view returns (VoteItem[] memory) {
        string memory description = "All vote DG items packed in one call to the Agent";
        return _wrapItemsForwardPacked(_getVoteItems(), AGENT, description);
    }

    function getVoteItems() public view override returns (VoteItem[] memory) {
        // set prefix to `1`, so all item's description will transform to `1.N. Description...`
        return _wrapItemsPrefixNumberForward(_getVoteItems(), AGENT, 1, 1);
    }

    function _getVotingVoteItems() internal view returns (VoteItem[] memory items) {
        items = new VoteItem[](VOTING_ITEMS_COUNT);
        uint256 i = 0;

        UpgradeConfig config = UpgradeConfig(CONFIG);
        GlobalConfig memory g = config.getGlobalConfig();
        address easyTrack = g.easyTrack;

        // (EasyTrackNewFactories memory etn, EasyTrackOldFactories memory eto) = config.getEasyTrackConfig();

        (EasyTrackNewFactories memory etn,) = config.getEasyTrackConfig();

        //
        // Delete old EasyTrack Factories
        //
        // items[i++] = _delETFactoryItem("Remove CSMSettleElStealingPenalty ET factory", easyTrack, eto.CSMSettleElStealingPenalty);
        // items[i++] = _delETFactoryItem("Remove CSMSetVettedGateTree ET factory", easyTrack, eto.CSMSetVettedGateTree);

        //
        // Add new EasyTrack Factories
        //

        {
            CoreUpgradeConfig memory c = config.getCoreUpgradeConfig();

            items[i++] = _addETFactoryItem(
                "Add UpdateStakingModuleShareLimits ET factory",
                easyTrack,
                etn.UpdateStakingModuleShareLimits,
                bytes.concat(bytes20(g.stakingRouter), bytes4(IStakingRouterUpgrade.updateModuleShares.selector))
            );

            items[i++] = _addETFactoryItem(
                "Add AllowConsolidationPair ET factory",
                easyTrack,
                etn.AllowConsolidationPair,
                bytes.concat(bytes20(c.consolidationMigrator), bytes4(IConsolidationMigrator.allowPair.selector))
            );
        }

        {
            CSMUpgradeConfig memory c = config.getCSMUpgradeConfig();

            items[i++] = _addETFactoryItem(
                "Add SetMerkleGateTree CSM ET factory",
                easyTrack,
                etn.SetMerkleGateTreeForCSM,
                _setMerkleGateTreePermissions(etn.AllowedMerkleGatesRegistryForCSM)
            );

            items[i++] = _addETFactoryItem(
                "Add ReportWithdrawalsForSlashedValidators CSM ET factory",
                easyTrack,
                etn.ReportWithdrawalsForSlashedValidatorsForCSM,
                bytes.concat(bytes20(c.csm), bytes4(IBaseModuleV3.reportSlashedWithdrawnValidators.selector))
            );

            items[i++] = _addETFactoryItem(
                "Add SettleGeneralDelayedPenalty CSM ET factory",
                easyTrack,
                etn.SettleGeneralDelayedPenaltyForCSM,
                bytes.concat(bytes20(c.csm), bytes4(IBaseModuleV3.settleGeneralDelayedPenalty.selector))
            );
        }

        {
            CuratedModuleConfig memory c = config.getCuratedModuleConfig();

            items[i++] = _addETFactoryItem(
                "Add SetMerkleGateTree CM ET factory",
                easyTrack,
                etn.SetMerkleGateTreeForCM,
                _setMerkleGateTreePermissions(etn.AllowedMerkleGatesRegistryForCM)
            );

            items[i++] = _addETFactoryItem(
                "Add ReportWithdrawalsForSlashedValidators CM ET factory",
                easyTrack,
                etn.ReportWithdrawalsForSlashedValidatorsForCM,
                bytes.concat(bytes20(c.module), bytes4(IBaseModuleV3.reportSlashedWithdrawnValidators.selector))
            );

            items[i++] = _addETFactoryItem(
                "Add SettleGeneralDelayedPenalty CM ET factory",
                easyTrack,
                etn.SettleGeneralDelayedPenaltyForCM,
                bytes.concat(bytes20(c.module), bytes4(IBaseModuleV3.settleGeneralDelayedPenalty.selector))
            );

            items[i++] = _addETFactoryItem(
                "Add CreateOrUpdateOperatorGroup CM ET factory",
                easyTrack,
                etn.CreateOrUpdateOperatorGroup,
                bytes.concat(bytes20(c.metaRegistry), bytes4(IMetaRegistry.createOrUpdateOperatorGroup.selector))
            );
        }
        if (i != VOTING_ITEMS_COUNT) revert InvalidItemsCount(i, VOTING_ITEMS_COUNT);
    }

    function _getVoteItems() internal view returns (VoteItem[] memory items) {
        items = new VoteItem[](DG_ITEMS_COUNT);
        uint256 i = 0;

        UpgradeConfig config = UpgradeConfig(CONFIG);
        GlobalConfig memory g = config.getGlobalConfig();
        address agent = g.agent;
        address evmScriptExecutor = g.easyTrackEVMScriptExecutor;
        address stakingRouter = g.stakingRouter;

        // items[i++] = _item({
        //     description: "Ensure DG proposal execution is within defined time window",
        //     to: TIME_CONSTRAINTS,
        //     data: abi.encodeCall(
        //         ITimeConstraints.checkTimeWithinDayTimeAndEmit, (ENABLED_DAY_SPAN_START, ENABLED_DAY_SPAN_END)
        //     )
        // });

        items[i++] = _item({
            description: "Call UpgradeTemplate.startUpgrade",
            to: TEMPLATE,
            data: abi.encodeCall(UpgradeTemplate.startUpgrade, ())
        });

        //
        // Core upgrade
        //
        {
            CoreUpgradeConfig memory c = config.getCoreUpgradeConfig();

            items[i++] = _proxyUpgradeToItem({
                description: "Upgrade LidoLocator implementation", to: c.locator, impl: c.newLocatorImpl
            });

            /// @notice updating StakingRouter implementation and call finalizeUpgrade_v4
            items[i++] = _proxyUpgradeToAndCallItem({
                description: "Upgrade StakingRouter implementation",
                to: stakingRouter,
                impl: c.newStakingRouterImpl,
                data: abi.encodeCall(IStakingRouterUpgrade.finalizeUpgrade_v4, ())
            });

            /// @notice updating AccountingOracle implementation and call finalizeUpgrade_v5
            items[i++] = _proxyUpgradeToAndCallItem({
                description: "Upgrade AccountingOracle implementation",
                to: c.accountingOracle,
                impl: c.newAccountingOracleImpl,
                data: abi.encodeCall(IAccountingOracleUpgrade.finalizeUpgrade_v5, (c.aoConsensusVersion))
            });

            /// @notice updating ValidatorsExitBusOracle implementation and call finalizeUpgrade_v3
            items[i++] = _proxyUpgradeToAndCallItem({
                description: "Upgrade ValidatorsExitBusOracle implementation",
                to: c.validatorsExitBusOracle,
                impl: c.newValidatorsExitBusOracleImpl,
                data: abi.encodeCall(
                    IValidatorsExitBusOracleUpgrade.finalizeUpgrade_v3,
                    (
                        c.veboMaxValidatorsPerReport,
                        c.veboMaxExitBalanceEth,
                        c.veboBalancePerFrameEth,
                        c.veboFrameDurationInSec,
                        c.veboConsensusVersion
                    )
                )
            });

            /// @notice updating Accounting implementation (no finalizeUpgrade)
            items[i++] = _proxyUpgradeToItem({
                description: "Upgrade Accounting implementation", to: c.accounting, impl: c.newAccountingImpl
            });

            /// @notice updating WithdrawalVault implementation and call finalizeUpgrade_v3
            items[i++] = _item({
                description: "Upgrade WithdrawalVault implementation",
                to: c.withdrawalVault,
                data: abi.encodeCall(
                    IWithdrawalsManagerProxy.proxy_upgradeTo,
                    (c.newWithdrawalVaultImpl, abi.encodeCall(IWithdrawalVaultUpgrade.finalizeUpgrade_v3, ()))
                )
            });

            items[i++] = _item({
                description: "Grant Aragon APP_MANAGER_ROLE to the AGENT",
                to: c.acl,
                data: abi.encodeCall(IAragonACL.grantPermission, (agent, c.kernel, APP_MANAGER_ROLE))
            });

            items[i++] = _item({
                description: "Set Lido implementation in Kernel",
                to: c.kernel,
                data: abi.encodeCall(IAragonKernel.setApp, (KERNEL_APP_BASES_NAMESPACE, c.lidoAppId, c.newLidoImpl))
            });

            items[i++] = _item({
                description: "Revoke Aragon APP_MANAGER_ROLE from the AGENT",
                to: c.acl,
                data: abi.encodeCall(IAragonACL.revokePermission, (agent, c.kernel, APP_MANAGER_ROLE))
            });

            items[i++] = _item({
                description: "Create and grant Aragon BUFFER_RESERVE_MANAGER_ROLE to the AGENT",
                to: c.acl,
                data: abi.encodeCall(IAragonACL.createPermission, (agent, g.lido, BUFFER_RESERVE_MANAGER_ROLE, agent))
            });

            items[i++] = _item({
                description: "Call finalizeUpgrade_v4 on Lido",
                to: g.lido,
                data: abi.encodeCall(ILidoUpgrade.finalizeUpgrade_v4, ())
            });

            /// @notice grant STAKING_MODULE_SHARE_MANAGE_ROLE to EasyTrack executor
            items[i++] = _ozGrantRoleItem({
                description: "Grant STAKING_MODULE_SHARE_MANAGE_ROLE to EasyTrack executor",
                to: stakingRouter,
                role: STAKING_MODULE_SHARE_MANAGE_ROLE,
                account: evmScriptExecutor
            });

            /// @notice revoke STAKING_MODULE_UNVETTING_ROLE from old DSM
            items[i++] = _ozRevokeRoleItem({
                description: "Revoke STAKING_MODULE_UNVETTING_ROLE from old DSM",
                to: stakingRouter,
                role: STAKING_MODULE_UNVETTING_ROLE,
                account: c.oldDepositSecurityModule
            });

            /// @notice grant STAKING_MODULE_UNVETTING_ROLE to new DSM
            items[i++] = _ozGrantRoleItem({
                description: "Grant STAKING_MODULE_UNVETTING_ROLE to new DSM",
                to: stakingRouter,
                role: STAKING_MODULE_UNVETTING_ROLE,
                account: c.newDepositSecurityModule
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant TW_EXIT_LIMIT_MANAGER_ROLE to Agent on TWGateway",
                to: g.triggerableWithdrawalsGateway,
                role: TW_EXIT_LIMIT_MANAGER_ROLE,
                account: agent
            });

            items[i++] = _item({
                description: "Set TWGateway exit request limits",
                to: g.triggerableWithdrawalsGateway,
                data: abi.encodeCall(
                    ITriggerableWithdrawalsGatewayUpgrade.setExitRequestLimit,
                    (c.twMaxExitRequestsLimit, c.twExitsPerFrame, c.twFrameDurationInSec)
                )
            });

            items[i++] = _item({
                description: "Register CM Committee as CircuitBreaker Pauser for ConsolidationGateway",
                to: g.circuitBreaker,
                data: abi.encodeCall(ICircuitBreaker.registerPauser, (c.consolidationGateway, c.curatedModuleCommittee))
            });
        }

        //
        // CSM Upgrade items
        //
        {
            CSMUpgradeConfig memory c = config.getCSMUpgradeConfig();
            address csm = c.csm;
            address gateSeal = c.gateSeal;
            address cb = g.circuitBreaker;
            address vettedGate = c.vettedGate;
            // --- Proxy upgrades ---

            items[i++] = _proxyUpgradeToAndCallV2Item({
                description: "Upgrade and finalize CSM v3",
                to: csm,
                impl: c.csmImpl,
                data: abi.encodeCall(ICSModuleV3.finalizeUpgradeV3, ())
            });

            items[i++] = _proxyUpgradeToAndCallV2Item({
                description: "Upgrade and finalize ParametersRegistry v3",
                to: c.parametersRegistry,
                impl: c.parametersRegistryImpl,
                data: abi.encodeCall(IParametersRegistryV3.finalizeUpgradeV3, ())
            });

            items[i++] = _proxyUpgradeToAndCallV2Item({
                description: "Upgrade and finalize FeeOracle v3",
                to: c.feeOracle,
                impl: c.feeOracleImpl,
                data: abi.encodeCall(IFeeOracleV3.finalizeUpgradeV3, (c.feeOracleConsensusVersion))
            });

            items[i++] = _proxyUpgradeToItem({
                description: "Upgrade VettedGate implementation", to: vettedGate, impl: c.vettedGateImpl
            });

            items[i++] = _proxyUpgradeToAndCallV2Item({
                description: "Upgrade and finalize Accounting v3",
                to: c.accounting,
                impl: c.accountingImpl,
                data: abi.encodeCall(IAccountingV3.finalizeUpgradeV3, ())
            });

            items[i++] = _proxyUpgradeToAndCallV2Item({
                description: "Upgrade and finalize FeeDistributor v3",
                to: c.feeDistributor,
                impl: c.feeDistributorImpl,
                data: abi.encodeCall(IFeeDistributorV3.finalizeUpgradeV3, ())
            });

            items[i++] = _proxyUpgradeToItem({
                description: "Upgrade ExitPenalties implementation", to: c.exitPenalties, impl: c.exitPenaltiesImpl
            });

            items[i++] = _proxyUpgradeToItem({
                description: "Upgrade ValidatorStrikes implementation", to: c.strikes, impl: c.strikesImpl
            });

            // --- Role & permission updates ---

            items[i++] = _item({
                description: "Point ValidatorStrikes to the new Ejector",
                to: c.strikes,
                data: abi.encodeCall(IValidatorStrikesV3.setEjector, (c.ejector))
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant REPORT_GENERAL_DELAYED_PENALTY_ROLE",
                to: csm,
                role: REPORT_GENERAL_DELAYED_PENALTY_ROLE,
                account: c.generalDelayedPenaltyReporter
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant SETTLE_GENERAL_DELAYED_PENALTY_ROLE",
                to: csm,
                role: SETTLE_GENERAL_DELAYED_PENALTY_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke REPORT_EL_REWARDS_STEALING_PENALTY_ROLE",
                to: csm,
                role: REPORT_EL_REWARDS_STEALING_PENALTY_ROLE,
                account: c.generalDelayedPenaltyReporter
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE",
                to: csm,
                role: SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke VERIFIER_ROLE from old verifier", to: csm, role: VERIFIER_ROLE, account: c.verifier
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant VERIFIER_ROLE to VerifierV3", to: csm, role: VERIFIER_ROLE, account: c.verifierV3
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE to VerifierV3",
                to: csm,
                role: REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE,
                account: c.verifierV3
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE to Easy Track",
                to: csm,
                role: REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke CREATE_NODE_OPERATOR_ROLE from old PermissionlessGate",
                to: csm,
                role: CREATE_NODE_OPERATOR_ROLE,
                account: c.oldPermissionlessGate
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant CREATE_NODE_OPERATOR_ROLE to new PermissionlessGate",
                to: csm,
                role: CREATE_NODE_OPERATOR_ROLE,
                account: c.permissionlessGate
            });

            // --- Gate seal migration ---

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke PAUSE_ROLE from old gate seal on CSModule",
                to: csm,
                role: PAUSE_ROLE,
                account: gateSeal
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke PAUSE_ROLE from old gate seal on Accounting",
                to: c.accounting,
                role: PAUSE_ROLE,
                account: gateSeal
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke PAUSE_ROLE from old gate seal on FeeOracle",
                to: c.feeOracle,
                role: PAUSE_ROLE,
                account: gateSeal
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke PAUSE_ROLE from old gate seal on VettedGate",
                to: vettedGate,
                role: PAUSE_ROLE,
                account: gateSeal
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke START_REFERRAL_SEASON_ROLE",
                to: vettedGate,
                role: START_REFERRAL_SEASON_ROLE,
                account: agent
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke END_REFERRAL_SEASON_ROLE",
                to: vettedGate,
                role: END_REFERRAL_SEASON_ROLE,
                account: c.identifiedCommunityStakersGateManager
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant PAUSE_ROLE to CircuitBreaker on CSModule", to: csm, role: PAUSE_ROLE, account: cb
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant PAUSE_ROLE to CircuitBreaker on Accounting",
                to: c.accounting,
                role: PAUSE_ROLE,
                account: cb
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant PAUSE_ROLE to CircuitBreaker on FeeOracle",
                to: c.feeOracle,
                role: PAUSE_ROLE,
                account: cb
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant PAUSE_ROLE to CircuitBreaker on VettedGate",
                to: vettedGate,
                role: PAUSE_ROLE,
                account: cb
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE to penaltiesManager",
                to: c.parametersRegistry,
                role: MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE,
                account: c.penaltiesManager
            });

            // --- Burner role migration ---

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke REQUEST_BURN_SHARES_ROLE from CSM Accounting",
                to: g.burner,
                role: REQUEST_BURN_SHARES_ROLE,
                account: c.accounting
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant REQUEST_BURN_MY_STETH_ROLE to CSM Accounting",
                to: g.burner,
                role: REQUEST_BURN_MY_STETH_ROLE,
                account: c.accounting
            });

            // --- TWG role migration ---

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke TWG full-withdrawal role from old Ejector",
                to: g.triggerableWithdrawalsGateway,
                role: ADD_FULL_WITHDRAWAL_REQUEST_ROLE,
                account: IValidatorStrikesV3(c.strikes).ejector()
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant TWG full-withdrawal role to new Ejector",
                to: g.triggerableWithdrawalsGateway,
                role: ADD_FULL_WITHDRAWAL_REQUEST_ROLE,
                account: c.ejector
            });
        }

        //
        // Curated Module items
        //
        {
            CuratedModuleConfig memory c = config.getCuratedModuleConfig();

            items[i++] = _item({
                description: "Add Curated module to StakingRouter",
                to: stakingRouter,
                data: abi.encodeCall(
                    IStakingRouterUpgrade.addStakingModule,
                    (
                        c.moduleName,
                        c.module,
                        StakingModuleConfig({
                            stakeShareLimit: c.stakeShareLimit,
                            priorityExitShareThreshold: c.priorityExitShareThreshold,
                            stakingModuleFee: c.stakingModuleFee,
                            treasuryFee: c.treasuryFee,
                            maxDepositsPerBlock: c.maxDepositsPerBlock,
                            minDepositBlockDistance: c.minDepositBlockDistance,
                            withdrawalCredentialsType: 0x02
                        })
                    )
                )
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant REQUEST_BURN_MY_STETH_ROLE to Curated Accounting",
                to: g.burner,
                role: REQUEST_BURN_MY_STETH_ROLE,
                account: c.accounting
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant TWG full-withdrawal role to Curated Ejector",
                to: g.triggerableWithdrawalsGateway,
                role: ADD_FULL_WITHDRAWAL_REQUEST_ROLE,
                account: c.ejector
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant RESUME_ROLE to agent on Curated module",
                to: c.module,
                role: RESUME_ROLE,
                account: agent
            });

            items[i++] = _item({
                description: "Resume Curated module", to: c.module, data: abi.encodeCall(ICSModuleV3.resume, ())
            });

            items[i++] = _ozRevokeRoleItem({
                description: "Revoke RESUME_ROLE from agent on Curated module",
                to: c.module,
                role: RESUME_ROLE,
                account: agent
            });

            items[i++] = _item({
                description: "Update Curated HashConsensus initial epoch",
                to: c.hashConsensus,
                data: abi.encodeCall(IHashConsensusV3.updateInitialEpoch, (c.hashConsensusInitialEpoch))
            });
        }

        //
        // Template: finish upgrade
        //

        items[i++] = _item({
            description: "Call UpgradeTemplate.finishUpgrade",
            to: TEMPLATE,
            data: abi.encodeCall(UpgradeTemplate.finishUpgrade, ())
        });

        if (i != DG_ITEMS_COUNT) revert InvalidItemsCount(i, DG_ITEMS_COUNT);
    }

    //
    // Helpers
    //

    function _addNumber(string memory s, uint256 n) internal pure returns (string memory) {
        return string.concat(n.toString(), ". ", s);
    }

    function _addPrefixedNumber(string memory s, string memory p, uint256 n) internal pure returns (string memory) {
        return string.concat(p, n.toString(), ". ", s);
    }

    function _wrapItemsNumber(VoteItem[] memory items, uint256 startNum) internal pure returns (VoteItem[] memory) {
        for (uint256 i = 0; i < items.length; ++i) {
            uint256 num = i + startNum;
            items[i].description = _addNumber(items[i].description, num);
        }
        return items;
    }

    function _wrapItemsPrefixNumber(VoteItem[] memory items, uint256 prefixNum, uint256 startNum)
        internal
        pure
        returns (VoteItem[] memory)
    {
        string memory prefix = string.concat(prefixNum.toString(), ".");
        for (uint256 i = 0; i < items.length; ++i) {
            uint256 num = i + startNum;
            items[i].description = _addPrefixedNumber(items[i].description, prefix, num);
        }

        return items;
    }

    /// @dev Wrap item with prefix, add number and forwarded `forwarder`
    function _wrapItemsPrefixNumberForward(
        VoteItem[] memory items,
        address forwarder,
        uint256 prefixNum,
        uint256 startNum
    ) internal pure returns (VoteItem[] memory) {
        string memory prefix = string.concat(prefixNum.toString(), ".");
        for (uint256 i = 0; i < items.length; ++i) {
            uint256 num = i + startNum;
            items[i].description = _addPrefixedNumber(items[i].description, prefix, num);
            items[i].call = _forwardCall(forwarder, items[i].call.to, items[i].call.data);
        }

        return items;
    }

    function _wrapItemsForwardPacked(VoteItem[] memory items, address forwarder, string memory description)
        internal
        pure
        returns (VoteItem[] memory)
    {
        VoteItem[] memory itemsPacked = new VoteItem[](1);
        CallsScriptBuilder.Context memory scriptBuilder = CallsScriptBuilder.create();
        for (uint256 i = 0; i < items.length; ++i) {
            // slither-disable-next-line unused-return
            scriptBuilder.addCall(items[i].call.to, items[i].call.data);
        }

        itemsPacked[0].description = description;
        itemsPacked[0].call = _votingCall(forwarder, abi.encodeCall(IForwarder.forward, scriptBuilder.getResult()));

        return itemsPacked;
    }

    function _item(string memory description, address to, bytes memory data) internal pure returns (VoteItem memory) {
        return VoteItem({description: description, call: _votingCall(to, data)});
    }

    function _setMerkleGateTreePermissions(address allowedMerkleGatesRegistry)
        private
        view
        returns (bytes memory permissions)
    {
        address[] memory gates = IAllowedMerkleGatesRegistry(allowedMerkleGatesRegistry).getAllowedGates();
        for (uint256 i = 0; i < gates.length; ++i) {
            permissions = bytes.concat(permissions, bytes20(gates[i]), bytes4(IMerkleGate.setTreeParams.selector));
        }
    }

    function _addETFactoryItem(string memory description, address easyTrack, address factory, bytes memory permissions)
        private
        pure
        returns (VoteItem memory)
    {
        return _item(description, easyTrack, abi.encodeCall(IEasyTrack.addEVMScriptFactory, (factory, permissions)));
    }

    function _delETFactoryItem(string memory description, address easyTrack, address factory)
        private
        pure
        returns (VoteItem memory)
    {
        return _item(description, easyTrack, abi.encodeCall(IEasyTrack.removeEVMScriptFactory, (factory)));
    }

    function _ozGrantRoleItem(string memory description, address to, bytes32 role, address account)
        internal
        pure
        returns (VoteItem memory)
    {
        return _item(description, to, abi.encodeCall(IAccessControl.grantRole, (role, account)));
    }

    function _ozRevokeRoleItem(string memory description, address to, bytes32 role, address account)
        internal
        pure
        returns (VoteItem memory)
    {
        return _item(description, to, abi.encodeCall(IAccessControl.revokeRole, (role, account)));
    }

    function _proxyUpgradeToItem(string memory description, address to, address impl)
        internal
        pure
        returns (VoteItem memory)
    {
        return _item(description, to, abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (impl)));
    }

    /// @dev wraps call to the IOssifiableProxy.proxy__upgradeToAndCall
    function _proxyUpgradeToAndCallItem(string memory description, address to, address impl, bytes memory data)
        internal
        pure
        returns (VoteItem memory)
    {
        return _item(description, to, abi.encodeCall(IOssifiableProxy.proxy__upgradeToAndCall, (impl, data, false)));
    }

    /// @dev wraps call to the modified IOssifiableProxyV2.proxy__upgradeToAndCall (used in CSM/CM)
    function _proxyUpgradeToAndCallV2Item(string memory description, address to, address impl, bytes memory data)
        internal
        pure
        returns (VoteItem memory)
    {
        return _item(description, to, abi.encodeCall(IOssifiableProxyV2.proxy__upgradeToAndCall, (impl, data)));
    }
}
