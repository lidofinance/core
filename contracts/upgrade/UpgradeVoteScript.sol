// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {Strings} from "@openzeppelin/contracts-v5.2/utils/Strings.sol";
import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {StakingModuleConfig} from "contracts/0.8.25/sr/SRTypes.sol";
import {OmnibusBase} from "./utils/OmnibusBase.sol";
import {UpgradeTemplate} from "./UpgradeTemplate.sol";

import {
    ITimeConstraints,
    GlobalConfig,
    EasyTrackNewFactories,
    EasyTrackOldFactories,
    CoreUpgradeConfig,
    CSMUpgradeConfig,
    CuratedModuleConfig,
    IAragonKernel,
    IAragonACL,
    IEasyTrack,
    IStakingRouter,
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
    IMetaRegistry
} from "./UpgradeTypes.sol";

/// @title UpgradeVoteScript
/// @notice Script for upgrading Lido protocol components
contract UpgradeVoteScript is OmnibusBase {
    using Strings for uint256;

    //
    // Constants
    //
    // TODO set upon finish with items
    uint256 internal constant DG_ITEMS_COUNT = 68;
    uint256 public constant VOTING_ITEMS_COUNT = 11;

    bytes32 internal constant STAKING_MODULE_SHARE_MANAGE_ROLE = keccak256("STAKING_MODULE_SHARE_MANAGE_ROLE");
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

    //
    // Immutables
    //
    address public immutable TEMPLATE;
    address public immutable TIME_CONSTRAINTS;
    uint32 public immutable ENABLED_DAY_SPAN_START; // = 50400; // 14:00 UTC
    uint32 public immutable ENABLED_DAY_SPAN_END; // = 82800; // 23:00 UTC

    struct ScriptParams {
        address upgradeTemplate;
        address timeConstraints;
        uint32 enabledDaySpanStart;
        uint32 enabledDaySpanEnd;
    }

    constructor(ScriptParams memory _params)
        OmnibusBase(
            UpgradeTemplate(_params.upgradeTemplate).VOTING(),
            UpgradeTemplate(_params.upgradeTemplate).DUAL_GOVERNANCE()
        )
    {
        TEMPLATE = _params.upgradeTemplate;
        TIME_CONSTRAINTS = _params.timeConstraints;
        ENABLED_DAY_SPAN_START = _params.enabledDaySpanStart; // e.g. 50400 = 14:00 UTC
        ENABLED_DAY_SPAN_END = _params.enabledDaySpanEnd; // e.g. 82800 = 23:00 UTC
    }

    /// @dev Non DG voting items
    function getVotingVoteItems() public view override returns (VoteItem[] memory) {
        VoteItem[] memory items = new VoteItem[](VOTING_ITEMS_COUNT);
        uint256 i = 0;

        UpgradeTemplate template = UpgradeTemplate(TEMPLATE);
        GlobalConfig memory g = template.getGlobalConfig();
        address easyTrack = g.easyTrack;
        (EasyTrackNewFactories memory n, EasyTrackOldFactories memory o) = template.getEasyTrackConfig();

        //
        // Add new EasyTrack Factories
        //
        items[i++] =
            _delETFactoryItem("Remove CSMSettleElStealingPenalty ET factory", easyTrack, o.CSMSettleElStealingPenalty);
        items[i++] = _delETFactoryItem("Remove CSMSetVettedGateTree ET factory", easyTrack, o.CSMSetVettedGateTree);

        {
            CoreUpgradeConfig memory c = template.getCoreUpgradeConfig();

            items[i++] = _addETFactoryItem(
                "Add UpdateStakingModuleShareLimits ET factory",
                easyTrack,
                n.UpdateStakingModuleShareLimits,
                bytes.concat(bytes20(g.stakingRouter), bytes4(IStakingRouter.updateModuleShares.selector))
            );

            items[i++] = _addETFactoryItem(
                "Add AllowConsolidationPair ET factory",
                easyTrack,
                n.AllowConsolidationPair,
                bytes.concat(bytes20(c.consolidationMigrator), bytes4(IConsolidationMigrator.allowPair.selector))
            );
        }

        {
            CSMUpgradeConfig memory c = template.getCSMUpgradeConfig();

            items[i++] = _addETFactoryItem(
                "Add SetMerkleGateTree CSM ET factory",
                easyTrack,
                n.SetMerkleGateTreeForCSM,
                _setMerkleGateTreePermissions(n.AllowedMerkleGatesRegistryForCSM)
            );

            items[i++] = _addETFactoryItem(
                "Add ReportWithdrawalsForSlashedValidators CSM ET factory",
                easyTrack,
                n.ReportWithdrawalsForSlashedValidatorsForCSM,
                bytes.concat(bytes20(c.csm), bytes4(IBaseModuleV3.reportSlashedWithdrawnValidators.selector))
            );

            items[i++] = _addETFactoryItem(
                "Add SettleGeneralDelayedPenalty CSM ET factory",
                easyTrack,
                n.SettleGeneralDelayedPenaltyForCSM,
                bytes.concat(bytes20(c.csm), bytes4(IBaseModuleV3.settleGeneralDelayedPenalty.selector))
            );
        }

        {
            CuratedModuleConfig memory c = template.getCuratedModuleConfig();

            items[i++] = _addETFactoryItem(
                "Add SetMerkleGateTree CM ET factory",
                easyTrack,
                n.SetMerkleGateTreeForCM,
                _setMerkleGateTreePermissions(n.AllowedMerkleGatesRegistryForCM)
            );

            items[i++] = _addETFactoryItem(
                "Add ReportWithdrawalsForSlashedValidators CM ET factory",
                easyTrack,
                n.ReportWithdrawalsForSlashedValidatorsForCM,
                bytes.concat(bytes20(c.module), bytes4(IBaseModuleV3.reportSlashedWithdrawnValidators.selector))
            );

            items[i++] = _addETFactoryItem(
                "Add SettleGeneralDelayedPenalty CM ET factory",
                easyTrack,
                n.SettleGeneralDelayedPenaltyForCM,
                bytes.concat(bytes20(c.module), bytes4(IBaseModuleV3.settleGeneralDelayedPenalty.selector))
            );

            items[i++] = _addETFactoryItem(
                "Add CreateOrUpdateOperatorGroup CM ET factory",
                easyTrack,
                n.CreateOrUpdateOperatorGroup,
                bytes.concat(bytes20(c.metaRegistry), bytes4(IMetaRegistry.createOrUpdateOperatorGroup.selector))
            );
        }
        assert(i == VOTING_ITEMS_COUNT);

        //  start from `2` as `1` is reserved for DG submission item
        return _wrapItemsNumber(items, 2);
    }

    /// @dev DG voting items
    function getVoteItems() public view override returns (VoteItem[] memory) {
        VoteItem[] memory items = new VoteItem[](DG_ITEMS_COUNT);
        uint256 i = 0;

        UpgradeTemplate template = UpgradeTemplate(TEMPLATE);
        GlobalConfig memory g = template.getGlobalConfig();
        address agent = g.agent;
        address resealManager = g.resealManager;
        address evmScriptExecutor = g.easyTrackEVMScriptExecutor;

        // items[i++] = _item({
        //     description: "Ensure DG proposal execution is within defined time window",
        //     to: TIME_CONSTRAINTS,
        //     data: abi.encodeCall(
        //         ITimeConstraints.checkTimeWithinDayTimeAndEmit, (ENABLED_DAY_SPAN_START, ENABLED_DAY_SPAN_END)
        //     )
        // });

        items[i++] = _item({
            description: "Call UpgradeTemplate.startUpgrade",
            to: address(template),
            data: abi.encodeCall(UpgradeTemplate.startUpgrade, ())
        });

        //
        // Core upgrade
        //
        {
            CoreUpgradeConfig memory c = template.getCoreUpgradeConfig();

            items[i++] = _proxyUpgradeToItem({
                description: "Upgrade LidoLocator implementation", to: c.locator, impl: c.newLocatorImpl
            });

            items[i++] = _item({
                description: "Grant Aragon APP_MANAGER_ROLE to the AGENT",
                to: c.acl,
                data: abi.encodeCall(IAragonACL.grantPermission, (agent, c.kernel, keccak256("APP_MANAGER_ROLE")))
            });

            items[i++] = _item({
                description: "Set Lido implementation in Kernel",
                to: c.kernel,
                data: abi.encodeCall(
                    IAragonKernel.setApp, (IAragonKernel(c.kernel).APP_BASES_NAMESPACE(), c.lidoAppId, c.newLidoImpl)
                )
            });

            items[i++] = _item({
                description: "Revoke Aragon APP_MANAGER_ROLE from the AGENT",
                to: c.acl,
                data: abi.encodeCall(IAragonACL.revokePermission, (agent, c.kernel, keccak256("APP_MANAGER_ROLE")))
            });

            /// @notice updating implementation and calling finalizeUpgrade
            /// @dev finalizeUpgrade_v4 must be called before any other actions to migrate storage and OZ roles
            items[i++] = _proxyUpgradeToAndCallItem({
                description: "Upgrade StakingRouter implementation and finalize v4 migration",
                to: g.stakingRouter,
                impl: c.newStakingRouterImpl,
                data: abi.encodeCall(IStakingRouter.finalizeUpgrade_v4, ())
            });

            /// @notice grant STAKING_MODULE_SHARE_MANAGE_ROLE to EasyTrack executor
            items[i++] = _ozGrantRoleItem({
                description: "Grant STAKING_MODULE_SHARE_MANAGE_ROLE to EasyTrack executor",
                to: g.stakingRouter,
                role: STAKING_MODULE_SHARE_MANAGE_ROLE,
                account: evmScriptExecutor
            });

            /// @notice updating AccountingOracle implementation
            /// @dev finalizeUpgrade will be called in UpgradeTemplate.finishUpgrade()
            items[i++] = _item({
                description: "Upgrade AccountingOracle implementation",
                to: c.accountingOracle,
                data: abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (c.newAccountingOracleImpl))
            });

            /// @notice updating Accounting implementation
            items[i++] = _proxyUpgradeToItem({
                description: "Upgrade Accounting implementation", to: c.accounting, impl: c.newAccountingImpl
            });

            /// @notice updating WithdrawalVault implementation
            /// @dev finalizeUpgrade will be called in UpgradeTemplate.finishUpgrade()
            items[i++] = _item({
                description: "Upgrade WithdrawalVault implementation",
                to: c.withdrawalVault,
                data: abi.encodeCall(IWithdrawalsManagerProxy.proxy_upgradeTo, (c.newWithdrawalVaultImpl, bytes("")))
            });
        }

        //
        // CSM Upgrade items
        //
        {
            CSMUpgradeConfig memory c = template.getCSMUpgradeConfig();
            address csm = c.csm;
            address gateSeal = c.gateSeal;
            address verifier = c.verifier;
            address vettedGate = c.vettedGate;
            address oldEjector = IValidatorStrikesV3(c.strikes).ejector();

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
                description: "Revoke VERIFIER_ROLE from old verifier", to: csm, role: VERIFIER_ROLE, account: verifier
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
                description: "Revoke PAUSE_ROLE from old gate seal on old Verifier",
                to: verifier,
                role: PAUSE_ROLE,
                account: gateSeal
            });

            // todo: do we need revoke role from old ejector, since it’s just going to end up as trash?
            items[i++] = _ozRevokeRoleItem({
                description: "Revoke PAUSE_ROLE from old gate seal on old Ejector",
                to: oldEjector,
                role: PAUSE_ROLE,
                account: gateSeal
            });

            // todo: do we need revoke role from old ejector, since it’s just going to end up as trash?
            items[i++] = _ozRevokeRoleItem({
                description: "Revoke PAUSE_ROLE from reseal manager on old Verifier",
                to: verifier,
                role: PAUSE_ROLE,
                account: resealManager
            });

            // todo: do we need revoke role from old ejector, since it’s just going to end up as trash?
            items[i++] = _ozRevokeRoleItem({
                description: "Revoke RESUME_ROLE from reseal manager on old Verifier",
                to: verifier,
                role: RESUME_ROLE,
                account: resealManager
            });

            // todo: do we need revoke role from old ejector, since it’s just going to end up as trash?
            items[i++] = _ozRevokeRoleItem({
                description: "Revoke PAUSE_ROLE from reseal manager on old Ejector",
                to: oldEjector,
                role: PAUSE_ROLE,
                account: resealManager
            });

            // todo: do we need revoke role from old ejector, since it’s just going to end up as trash?
            items[i++] = _ozRevokeRoleItem({
                description: "Revoke RESUME_ROLE from reseal manager on old Ejector",
                to: oldEjector,
                role: RESUME_ROLE,
                account: resealManager
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
                description: "Grant PAUSE_ROLE to GateSealV3 on CSModule",
                to: csm,
                role: PAUSE_ROLE,
                account: c.gateSealV3
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant PAUSE_ROLE to GateSealV3 on Accounting",
                to: c.accounting,
                role: PAUSE_ROLE,
                account: c.gateSealV3
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant PAUSE_ROLE to GateSealV3 on FeeOracle",
                to: c.feeOracle,
                role: PAUSE_ROLE,
                account: c.gateSealV3
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant PAUSE_ROLE to GateSealV3 on VettedGate",
                to: vettedGate,
                role: PAUSE_ROLE,
                account: c.gateSealV3
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
                account: oldEjector
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
            CuratedModuleConfig memory c = template.getCuratedModuleConfig();

            items[i++] = _item({
                description: "Add Curated module to StakingRouter",
                to: g.stakingRouter,
                data: abi.encodeCall(
                    IStakingRouter.addStakingModule,
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
                description: "Grant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE to Easy Track on Curated module",
                to: c.module,
                role: REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant SETTLE_GENERAL_DELAYED_PENALTY_ROLE to Easy Track on Curated module",
                to: c.module,
                role: SETTLE_GENERAL_DELAYED_PENALTY_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant MANAGE_OPERATOR_GROUPS_ROLE to Easy Track on Curated MetaRegistry",
                to: c.metaRegistry,
                role: MANAGE_OPERATOR_GROUPS_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant SET_TREE_ROLE to Easy Track on Curated Professional Operator Gate",
                to: c.professionalOperatorGate,
                role: SET_TREE_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant SET_TREE_ROLE to Easy Track on Curated Professional Trusted Operator Gate",
                to: c.professionalTrustedOperatorGate,
                role: SET_TREE_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant SET_TREE_ROLE to Easy Track on Curated Public Good Operator Gate",
                to: c.publicGoodOperatorGate,
                role: SET_TREE_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant SET_TREE_ROLE to Easy Track on Curated Decentralization Operator Gate",
                to: c.decentralizationOperatorGate,
                role: SET_TREE_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant SET_TREE_ROLE to Easy Track on Curated Extra Effort Operator Gate",
                to: c.extraEffortOperatorGate,
                role: SET_TREE_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant SET_TREE_ROLE to Easy Track on Curated Intra-Operator DVT Cluster Gate",
                to: c.intraOperatorDVTClusterGate,
                role: SET_TREE_ROLE,
                account: evmScriptExecutor
            });

            items[i++] = _ozGrantRoleItem({
                description: "Grant TWG full-withdrawal role to Curated Ejector",
                to: g.triggerableWithdrawalsGateway,
                role: REQUEST_BURN_MY_STETH_ROLE,
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
            to: address(template),
            data: abi.encodeCall(UpgradeTemplate.finishUpgrade, ())
        });

        assert(i == DG_ITEMS_COUNT);

        // set prefix to `1`, so all item's description will transform to `1.N. Description...`
        return _wrapItemsPrefixNumberForward(items, agent, 1, 1);
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
