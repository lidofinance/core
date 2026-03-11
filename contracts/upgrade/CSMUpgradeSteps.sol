// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    VoteItem,
    GeneralConfig,
    UpgradeConfig,
    VoteScriptHelpers,
    IOssifiableProxyV2,
    ICSModuleV3,
    IParametersRegistryV3,
    IFeeOracleV3,
    IAccountingV3,
    IFeeDistributorV3,
    IPausableWithResumeRoles,
    IPausableRole,
    IValidatorStrikesV3,
    IBurner,
    ITriggerableWithdrawalsGateway
} from "./StakingRouterV3VoteTypes.sol";

/// @title CSMUpgradeSteps
/// @notice CSM v2 -> v3 upgrade vote items (items 1-40), deployed as a separate library.
library CSMUpgradeSteps {
    uint256 internal constant COUNT = 40;

    bytes32 internal constant REPORT_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("REPORT_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 internal constant SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE =
        keccak256("SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE");
    bytes32 internal constant REPORT_GENERAL_DELAYED_PENALTY_ROLE =
        keccak256("REPORT_GENERAL_DELAYED_PENALTY_ROLE");
    bytes32 internal constant SETTLE_GENERAL_DELAYED_PENALTY_ROLE =
        keccak256("SETTLE_GENERAL_DELAYED_PENALTY_ROLE");
    bytes32 internal constant REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE =
        keccak256("REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE");
    bytes32 internal constant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE =
        keccak256("REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE");
    bytes32 internal constant START_REFERRAL_SEASON_ROLE = keccak256("START_REFERRAL_SEASON_ROLE");
    bytes32 internal constant END_REFERRAL_SEASON_ROLE = keccak256("END_REFERRAL_SEASON_ROLE");

    function getItems(
        GeneralConfig memory g,
        UpgradeConfig memory u
    ) external view returns (VoteItem[] memory items) {
        items = new VoteItem[](COUNT);

        address oldEjector = IValidatorStrikesV3(u.strikes).ejector();

        uint256 i = 0;

        // --- Proxy upgrades ---

        items[i++] = VoteScriptHelpers.item({
            description: "1. Upgrade and finalize CSM v3",
            to: u.csm,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (u.csmImpl, abi.encodeCall(ICSModuleV3.finalizeUpgradeV3, ()))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "2. Upgrade and finalize ParametersRegistry v3",
            to: u.parametersRegistry,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (u.parametersRegistryImpl, abi.encodeCall(IParametersRegistryV3.finalizeUpgradeV3, ()))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "3. Upgrade and finalize FeeOracle v3",
            to: u.feeOracle,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (u.feeOracleImpl, abi.encodeCall(IFeeOracleV3.finalizeUpgradeV3, (u.feeOracleConsensusVersion)))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "4. Upgrade VettedGate implementation",
            to: u.vettedGate,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (u.vettedGateImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "5. Upgrade and finalize Accounting v3",
            to: u.accounting,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (u.accountingImpl, abi.encodeCall(IAccountingV3.finalizeUpgradeV3, ()))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "6. Upgrade and finalize FeeDistributor v3",
            to: u.feeDistributor,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (u.feeDistributorImpl, abi.encodeCall(IFeeDistributorV3.finalizeUpgradeV3, ()))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "7. Upgrade ExitPenalties implementation",
            to: u.exitPenalties,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (u.exitPenaltiesImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "8. Upgrade ValidatorStrikes implementation",
            to: u.strikes,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (u.strikesImpl))
        });

        // --- Role & permission updates ---

        items[i++] = VoteScriptHelpers.item({
            description: "9. Point ValidatorStrikes to the new Ejector",
            to: u.strikes,
            data: abi.encodeCall(IValidatorStrikesV3.setEjector, (u.ejector))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "10. Grant REPORT_GENERAL_DELAYED_PENALTY_ROLE",
            call: VoteScriptHelpers.grantRole(u.csm, REPORT_GENERAL_DELAYED_PENALTY_ROLE, g.generalDelayedPenaltyReporter)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "11. Grant SETTLE_GENERAL_DELAYED_PENALTY_ROLE",
            call: VoteScriptHelpers.grantRole(u.csm, SETTLE_GENERAL_DELAYED_PENALTY_ROLE, g.easyTrackEVMScriptExecutor)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "12. Revoke REPORT_EL_REWARDS_STEALING_PENALTY_ROLE",
            call: VoteScriptHelpers.revokeRole(u.csm, REPORT_EL_REWARDS_STEALING_PENALTY_ROLE, g.generalDelayedPenaltyReporter)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "13. Revoke SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE",
            call: VoteScriptHelpers.revokeRole(u.csm, SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE, g.easyTrackEVMScriptExecutor)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "14. Revoke VERIFIER_ROLE from old verifier",
            call: VoteScriptHelpers.revokeRole(u.csm, ICSModuleV3(u.csm).VERIFIER_ROLE(), u.verifier)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "15. Grant VERIFIER_ROLE to VerifierV3",
            call: VoteScriptHelpers.grantRole(u.csm, ICSModuleV3(u.csm).VERIFIER_ROLE(), u.verifierV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "16. Grant REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE to VerifierV3",
            call: VoteScriptHelpers.grantRole(u.csm, REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE, u.verifierV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "17. Grant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE to Easy Track",
            call: VoteScriptHelpers.grantRole(u.csm, REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE, g.easyTrackEVMScriptExecutor)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "18. Revoke CREATE_NODE_OPERATOR_ROLE from old PermissionlessGate",
            call: VoteScriptHelpers.revokeRole(u.csm, ICSModuleV3(u.csm).CREATE_NODE_OPERATOR_ROLE(), u.oldPermissionlessGate)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "19. Grant CREATE_NODE_OPERATOR_ROLE to new PermissionlessGate",
            call: VoteScriptHelpers.grantRole(u.csm, ICSModuleV3(u.csm).CREATE_NODE_OPERATOR_ROLE(), u.permissionlessGate)
        });

        // --- Gate seal migration ---

        items[i++] = VoteScriptHelpers.item({
            description: "20. Revoke PAUSE_ROLE from old gate seal on CSModule",
            call: VoteScriptHelpers.revokeRole(u.csm, ICSModuleV3(u.csm).PAUSE_ROLE(), g.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "21. Revoke PAUSE_ROLE from old gate seal on Accounting",
            call: VoteScriptHelpers.revokeRole(u.accounting, IAccountingV3(u.accounting).PAUSE_ROLE(), g.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "22. Revoke PAUSE_ROLE from old gate seal on FeeOracle",
            call: VoteScriptHelpers.revokeRole(u.feeOracle, IFeeOracleV3(u.feeOracle).PAUSE_ROLE(), g.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "23. Revoke PAUSE_ROLE from old gate seal on VettedGate",
            call: VoteScriptHelpers.revokeRole(u.vettedGate, IPausableRole(u.vettedGate).PAUSE_ROLE(), g.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "24. Revoke PAUSE_ROLE from old gate seal on old Verifier",
            call: VoteScriptHelpers.revokeRole(u.verifier, IPausableRole(u.verifier).PAUSE_ROLE(), g.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "25. Revoke PAUSE_ROLE from old gate seal on old Ejector",
            call: VoteScriptHelpers.revokeRole(oldEjector, IPausableWithResumeRoles(oldEjector).PAUSE_ROLE(), g.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "26. Revoke PAUSE_ROLE from reseal manager on old Verifier",
            call: VoteScriptHelpers.revokeRole(u.verifier, IPausableWithResumeRoles(u.verifier).PAUSE_ROLE(), g.resealManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "27. Revoke RESUME_ROLE from reseal manager on old Verifier",
            call: VoteScriptHelpers.revokeRole(u.verifier, IPausableWithResumeRoles(u.verifier).RESUME_ROLE(), g.resealManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "28. Revoke PAUSE_ROLE from reseal manager on old Ejector",
            call: VoteScriptHelpers.revokeRole(oldEjector, IPausableWithResumeRoles(oldEjector).PAUSE_ROLE(), g.resealManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "29. Revoke RESUME_ROLE from reseal manager on old Ejector",
            call: VoteScriptHelpers.revokeRole(oldEjector, IPausableWithResumeRoles(oldEjector).RESUME_ROLE(), g.resealManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "30. Revoke START_REFERRAL_SEASON_ROLE",
            call: VoteScriptHelpers.revokeRole(u.vettedGate, START_REFERRAL_SEASON_ROLE, g.agent)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "31. Revoke END_REFERRAL_SEASON_ROLE",
            call: VoteScriptHelpers.revokeRole(u.vettedGate, END_REFERRAL_SEASON_ROLE, g.identifiedCommunityStakersGateManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "32. Grant PAUSE_ROLE to GateSealV3 on CSModule",
            call: VoteScriptHelpers.grantRole(u.csm, ICSModuleV3(u.csm).PAUSE_ROLE(), g.gateSealV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "33. Grant PAUSE_ROLE to GateSealV3 on Accounting",
            call: VoteScriptHelpers.grantRole(u.accounting, IAccountingV3(u.accounting).PAUSE_ROLE(), g.gateSealV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "34. Grant PAUSE_ROLE to GateSealV3 on FeeOracle",
            call: VoteScriptHelpers.grantRole(u.feeOracle, IFeeOracleV3(u.feeOracle).PAUSE_ROLE(), g.gateSealV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "35. Grant PAUSE_ROLE to GateSealV3 on VettedGate",
            call: VoteScriptHelpers.grantRole(u.vettedGate, IPausableRole(u.vettedGate).PAUSE_ROLE(), g.gateSealV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "36. Grant MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE to penaltiesManager",
            call: VoteScriptHelpers.grantRole(
                u.parametersRegistry,
                IParametersRegistryV3(u.parametersRegistry).MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE(),
                g.penaltiesManager
            )
        });

        // --- Burner role migration ---

        items[i++] = VoteScriptHelpers.item({
            description: "37. Revoke REQUEST_BURN_SHARES_ROLE from CSM Accounting",
            call: VoteScriptHelpers.revokeRole(g.burner, IBurner(g.burner).REQUEST_BURN_SHARES_ROLE(), u.accounting)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "38. Grant REQUEST_BURN_MY_STETH_ROLE to CSM Accounting",
            call: VoteScriptHelpers.grantRole(g.burner, IBurner(g.burner).REQUEST_BURN_MY_STETH_ROLE(), u.accounting)
        });

        // --- TWG role migration ---

        items[i++] = VoteScriptHelpers.item({
            description: "39. Revoke TWG full-withdrawal role from old Ejector",
            call: VoteScriptHelpers.revokeRole(
                g.triggerableWithdrawalsGateway,
                ITriggerableWithdrawalsGateway(g.triggerableWithdrawalsGateway).ADD_FULL_WITHDRAWAL_REQUEST_ROLE(),
                oldEjector
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "40. Grant TWG full-withdrawal role to new Ejector",
            call: VoteScriptHelpers.grantRole(
                g.triggerableWithdrawalsGateway,
                ITriggerableWithdrawalsGateway(g.triggerableWithdrawalsGateway).ADD_FULL_WITHDRAWAL_REQUEST_ROLE(),
                u.ejector
            )
        });

        assert(i == COUNT);
    }
}
