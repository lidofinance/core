// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    IUpgradeConfig,
    GeneralConfig,
    CSMUpgradeConfig,
    IOssifiableProxyV2,
    ICSModuleV3,
    IParametersRegistryV3,
    IFeeOracleV3,
    IAccountingV3,
    IFeeDistributorV3,
    IValidatorStrikesV3
} from "../UpgradeTypes.sol";

import {OmnibusBase} from "../utils/OmnibusBase.sol";
import {VoteScriptHelpers} from "../utils/VoteScriptHelpers.sol";

/// @title CSMUpgradeItems
/// @notice CSM v2 -> v3 upgrade vote items (items 1-40), deployed as a separate library.
library CSMUpgradeItems {
    uint256 internal constant COUNT = 40;

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

    // function getItems(     GeneralConfig calldata g,     CSMUpgradeConfig calldata c )
    function getItems(IUpgradeConfig template) external view returns (OmnibusBase.VoteItem[] memory items) {
        GeneralConfig memory g = template.getGeneralConfig();
        CSMUpgradeConfig memory c = template.getCSMUpgradeConfig();

        items = new OmnibusBase.VoteItem[](COUNT);
        uint256 i = 0;

        address oldEjector = IValidatorStrikesV3(c.strikes).ejector();

        // --- Proxy upgrades ---

        items[i++] = VoteScriptHelpers.item({
            description: "1. Upgrade and finalize CSM v3",
            to: c.csm,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (c.csmImpl, abi.encodeCall(ICSModuleV3.finalizeUpgradeV3, ()))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "2. Upgrade and finalize ParametersRegistry v3",
            to: c.parametersRegistry,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (c.parametersRegistryImpl, abi.encodeCall(IParametersRegistryV3.finalizeUpgradeV3, ()))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "3. Upgrade and finalize FeeOracle v3",
            to: c.feeOracle,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (c.feeOracleImpl, abi.encodeCall(IFeeOracleV3.finalizeUpgradeV3, (c.feeOracleConsensusVersion)))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "4. Upgrade VettedGate implementation",
            to: c.vettedGate,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (c.vettedGateImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "5. Upgrade and finalize Accounting v3",
            to: c.accounting,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (c.accountingImpl, abi.encodeCall(IAccountingV3.finalizeUpgradeV3, ()))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "6. Upgrade and finalize FeeDistributor v3",
            to: c.feeDistributor,
            data: abi.encodeCall(
                IOssifiableProxyV2.proxy__upgradeToAndCall,
                (c.feeDistributorImpl, abi.encodeCall(IFeeDistributorV3.finalizeUpgradeV3, ()))
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "7. Upgrade ExitPenalties implementation",
            to: c.exitPenalties,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (c.exitPenaltiesImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "8. Upgrade ValidatorStrikes implementation",
            to: c.strikes,
            data: abi.encodeCall(IOssifiableProxyV2.proxy__upgradeTo, (c.strikesImpl))
        });

        // --- Role & permission updates ---

        items[i++] = VoteScriptHelpers.item({
            description: "9. Point ValidatorStrikes to the new Ejector",
            to: c.strikes,
            data: abi.encodeCall(IValidatorStrikesV3.setEjector, (c.ejector))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "10. Grant REPORT_GENERAL_DELAYED_PENALTY_ROLE",
            call: VoteScriptHelpers.grantRole(
                c.csm, REPORT_GENERAL_DELAYED_PENALTY_ROLE, c.generalDelayedPenaltyReporter
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "11. Grant SETTLE_GENERAL_DELAYED_PENALTY_ROLE",
            call: VoteScriptHelpers.grantRole(c.csm, SETTLE_GENERAL_DELAYED_PENALTY_ROLE, g.easyTrackEVMScriptExecutor)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "12. Revoke REPORT_EL_REWARDS_STEALING_PENALTY_ROLE",
            call: VoteScriptHelpers.revokeRole(
                c.csm, REPORT_EL_REWARDS_STEALING_PENALTY_ROLE, c.generalDelayedPenaltyReporter
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "13. Revoke SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE",
            call: VoteScriptHelpers.revokeRole(
                c.csm, SETTLE_EL_REWARDS_STEALING_PENALTY_ROLE, g.easyTrackEVMScriptExecutor
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "14. Revoke VERIFIER_ROLE from old verifier",
            call: VoteScriptHelpers.revokeRole(c.csm, VERIFIER_ROLE, c.verifier)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "15. Grant VERIFIER_ROLE to VerifierV3",
            call: VoteScriptHelpers.grantRole(c.csm, VERIFIER_ROLE, c.verifierV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "16. Grant REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE to VerifierV3",
            call: VoteScriptHelpers.grantRole(c.csm, REPORT_REGULAR_WITHDRAWN_VALIDATORS_ROLE, c.verifierV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "17. Grant REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE to Easy Track",
            call: VoteScriptHelpers.grantRole(
                c.csm, REPORT_SLASHED_WITHDRAWN_VALIDATORS_ROLE, g.easyTrackEVMScriptExecutor
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "18. Revoke CREATE_NODE_OPERATOR_ROLE from old PermissionlessGate",
            call: VoteScriptHelpers.revokeRole(c.csm, CREATE_NODE_OPERATOR_ROLE, c.oldPermissionlessGate)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "19. Grant CREATE_NODE_OPERATOR_ROLE to new PermissionlessGate",
            call: VoteScriptHelpers.grantRole(c.csm, CREATE_NODE_OPERATOR_ROLE, c.permissionlessGate)
        });

        // --- Gate seal migration ---

        items[i++] = VoteScriptHelpers.item({
            description: "20. Revoke PAUSE_ROLE from old gate seal on CSModule",
            call: VoteScriptHelpers.revokeRole(c.csm, PAUSE_ROLE, c.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "21. Revoke PAUSE_ROLE from old gate seal on Accounting",
            call: VoteScriptHelpers.revokeRole(c.accounting, PAUSE_ROLE, c.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "22. Revoke PAUSE_ROLE from old gate seal on FeeOracle",
            call: VoteScriptHelpers.revokeRole(c.feeOracle, PAUSE_ROLE, c.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "23. Revoke PAUSE_ROLE from old gate seal on VettedGate",
            call: VoteScriptHelpers.revokeRole(c.vettedGate, PAUSE_ROLE, c.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "24. Revoke PAUSE_ROLE from old gate seal on old Verifier",
            call: VoteScriptHelpers.revokeRole(c.verifier, PAUSE_ROLE, c.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "25. Revoke PAUSE_ROLE from old gate seal on old Ejector",
            call: VoteScriptHelpers.revokeRole(oldEjector, PAUSE_ROLE, c.gateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "26. Revoke PAUSE_ROLE from reseal manager on old Verifier",
            call: VoteScriptHelpers.revokeRole(c.verifier, PAUSE_ROLE, g.resealManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "27. Revoke RESUME_ROLE from reseal manager on old Verifier",
            call: VoteScriptHelpers.revokeRole(c.verifier, RESUME_ROLE, g.resealManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "28. Revoke PAUSE_ROLE from reseal manager on old Ejector",
            call: VoteScriptHelpers.revokeRole(oldEjector, PAUSE_ROLE, g.resealManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "29. Revoke RESUME_ROLE from reseal manager on old Ejector",
            call: VoteScriptHelpers.revokeRole(oldEjector, RESUME_ROLE, g.resealManager)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "30. Revoke START_REFERRAL_SEASON_ROLE",
            call: VoteScriptHelpers.revokeRole(c.vettedGate, START_REFERRAL_SEASON_ROLE, g.agent)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "31. Revoke END_REFERRAL_SEASON_ROLE",
            call: VoteScriptHelpers.revokeRole(
                c.vettedGate, END_REFERRAL_SEASON_ROLE, c.identifiedCommunityStakersGateManager
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "32. Grant PAUSE_ROLE to GateSealV3 on CSModule",
            call: VoteScriptHelpers.grantRole(c.csm, PAUSE_ROLE, c.gateSealV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "33. Grant PAUSE_ROLE to GateSealV3 on Accounting",
            call: VoteScriptHelpers.grantRole(c.accounting, PAUSE_ROLE, c.gateSealV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "34. Grant PAUSE_ROLE to GateSealV3 on FeeOracle",
            call: VoteScriptHelpers.grantRole(c.feeOracle, PAUSE_ROLE, c.gateSealV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "35. Grant PAUSE_ROLE to GateSealV3 on VettedGate",
            call: VoteScriptHelpers.grantRole(c.vettedGate, PAUSE_ROLE, c.gateSealV3)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "36. Grant MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE to penaltiesManager",
            call: VoteScriptHelpers.grantRole(
                c.parametersRegistry, MANAGE_GENERAL_PENALTIES_AND_CHARGES_ROLE, c.penaltiesManager
            )
        });

        // --- Burner role migration ---

        items[i++] = VoteScriptHelpers.item({
            description: "37. Revoke REQUEST_BURN_SHARES_ROLE from CSM Accounting",
            call: VoteScriptHelpers.revokeRole(g.burner, REQUEST_BURN_SHARES_ROLE, c.accounting)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "38. Grant REQUEST_BURN_MY_STETH_ROLE to CSM Accounting",
            call: VoteScriptHelpers.grantRole(g.burner, REQUEST_BURN_MY_STETH_ROLE, c.accounting)
        });

        // --- TWG role migration ---

        items[i++] = VoteScriptHelpers.item({
            description: "39. Revoke TWG full-withdrawal role from old Ejector",
            call: VoteScriptHelpers.revokeRole(
                g.triggerableWithdrawalsGateway, ADD_FULL_WITHDRAWAL_REQUEST_ROLE, oldEjector
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "40. Grant TWG full-withdrawal role to new Ejector",
            call: VoteScriptHelpers.grantRole(
                g.triggerableWithdrawalsGateway, ADD_FULL_WITHDRAWAL_REQUEST_ROLE, c.ejector
            )
        });

        assert(i == COUNT);
    }
}
