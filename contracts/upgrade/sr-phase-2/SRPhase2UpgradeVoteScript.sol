// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";

import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {IForwarder} from "../interfaces/IForwarder.sol";
import {CallsScriptBuilder} from "../utils/CallScriptBuilder.sol";
import {OmnibusBase} from "../utils/OmnibusBase.sol";

import {SRPhase2UpgradeConfig} from "./SRPhase2UpgradeConfig.sol";
import {SRPhase2UpgradeTemplate} from "./SRPhase2UpgradeTemplate.sol";
import {
    GatewayConsumerLimits,
    IDualGovernanceTiebreaker,
    IEasyTrack,
    IOracleReportSanityChecker,
    ITriggerableWithdrawalsGateway,
    IWithdrawalsManagerProxy
} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2UpgradeVoteScript
/// @notice Omnibus for the SR phase 2 (LIP-38) upgrade: replaces the TriggerableWithdrawalsGateway,
///         plugs in the TriggerableWithdrawalsBus and removes the exit delay penalties.
/// @dev The Dual Governance proposal has four calls. The first runs the upgrade through the Agent, starting
///      with `startUpgrade`. The next two replace the gateway among the tiebreaker sealable withdrawal blockers:
///      only the Dual Governance admin executor may change them, so they cannot go through the Agent.
///      The last one calls `finishUpgrade` through the Agent, so the template checks the blockers too.
///      Two Aragon Voting items remove the Easy Track factories of the exit request hash delivery: only the
///      Voting may change Easy Track factories. They run when the vote is enacted, before the proposal.
///      Numbering follows the Aragon vote: item `1` submits the proposal, `1.1` to `1.4` are its calls,
///      `1.1.N` are the Agent actions of the first call, and `2` and `3` are the Voting items.
contract SRPhase2UpgradeVoteScript is OmnibusBase {
    using CallsScriptBuilder for CallsScriptBuilder.Context;

    error InvalidItemsCount(uint256 actual, uint256 expected);

    uint256 public constant DG_ITEMS_COUNT = 4;
    uint256 public constant VOTING_ITEMS_COUNT = 2;
    /// @notice Agent actions of the first Dual Governance call
    uint256 public constant RAW_ACTIONS_COUNT = 21;

    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");
    bytes32 internal constant ADD_WITHDRAWAL_INTENTS_ROLE = keccak256("ADD_WITHDRAWAL_INTENTS_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE =
        keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXITING_STATUS_ROLE =
        keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");
    bytes32 internal constant SUBMIT_REPORT_HASH_ROLE = keccak256("SUBMIT_REPORT_HASH_ROLE");
    bytes32 internal constant MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE =
        keccak256("MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE");

    address public immutable TEMPLATE;
    address public immutable CONFIG;
    address internal immutable AGENT;

    struct ScriptParams {
        address upgradeTemplate;
    }

    constructor(ScriptParams memory params)
        OmnibusBase(
            SRPhase2UpgradeConfig(SRPhase2UpgradeTemplate(params.upgradeTemplate).CONFIG()).VOTING(),
            SRPhase2UpgradeConfig(SRPhase2UpgradeTemplate(params.upgradeTemplate).CONFIG()).DUAL_GOVERNANCE()
        )
    {
        SRPhase2UpgradeTemplate template = SRPhase2UpgradeTemplate(params.upgradeTemplate);
        SRPhase2UpgradeConfig config = SRPhase2UpgradeConfig(template.CONFIG());
        TEMPLATE = address(template);
        CONFIG = address(config);
        AGENT = config.AGENT();
    }

    /// @notice Aragon Voting items; numbering starts from `2` as `1` is the Dual Governance proposal submission.
    function getVotingVoteItems() public view override returns (VoteItem[] memory items) {
        SRPhase2UpgradeConfig config = SRPhase2UpgradeConfig(CONFIG);
        address easyTrack = config.EASY_TRACK();

        items = new VoteItem[](VOTING_ITEMS_COUNT);
        items[0] = VoteItem({
            description: "2. Remove the CuratedSubmitExitRequestHashes factory from Easy Track",
            call: _votingCall(
                easyTrack,
                abi.encodeCall(IEasyTrack.removeEVMScriptFactory, (config.CURATED_SUBMIT_EXIT_REQUEST_HASHES_FACTORY()))
            )
        });
        items[1] = VoteItem({
            description: "3. Remove the SDVTSubmitExitRequestHashes factory from Easy Track",
            call: _votingCall(
                easyTrack,
                abi.encodeCall(IEasyTrack.removeEVMScriptFactory, (config.SDVT_SUBMIT_EXIT_REQUEST_HASHES_FACTORY()))
            )
        });

        // TODO add the Easy Track factory for the ACTIVE_REBALANCING_* OracleDaemonConfig keys once it exists.
    }

    function getVoteItems() public view override returns (VoteItem[] memory items) {
        SRPhase2UpgradeConfig config = SRPhase2UpgradeConfig(CONFIG);
        address dualGovernance = address(DUAL_GOVERNANCE);

        VoteItem[] memory rawItems = _getVoteItems();
        CallsScriptBuilder.Context memory scriptBuilder = CallsScriptBuilder.create();
        for (uint256 i = 0; i < rawItems.length; ++i) {
            scriptBuilder.addCall(rawItems[i].call.to, rawItems[i].call.data);
        }

        items = new VoteItem[](DG_ITEMS_COUNT);
        items[0] = VoteItem({
            description: "1.1. Upgrade the SR phase 2 (LIP-38) contracts through the Agent",
            call: _votingCall(AGENT, abi.encodeCall(IForwarder.forward, (scriptBuilder.getResult())))
        });
        items[1] = VoteItem({
            description: "1.2. Remove the old TriggerableWithdrawalsGateway from the Dual Governance tiebreaker sealable withdrawal blockers",
            call: _votingCall(
                dualGovernance,
                abi.encodeCall(
                    IDualGovernanceTiebreaker.removeTiebreakerSealableWithdrawalBlocker,
                    (config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY())
                )
            )
        });
        items[2] = VoteItem({
            description: "1.3. Add the new TriggerableWithdrawalsGateway to the Dual Governance tiebreaker sealable withdrawal blockers",
            call: _votingCall(
                dualGovernance,
                abi.encodeCall(
                    IDualGovernanceTiebreaker.addTiebreakerSealableWithdrawalBlocker,
                    (config.NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY())
                )
            )
        });
        items[3] = VoteItem({
            description: "1.4. Call SRPhase2UpgradeTemplate.finishUpgrade",
            call: _forwardCall(AGENT, TEMPLATE, abi.encodeCall(SRPhase2UpgradeTemplate.finishUpgrade, ()))
        });
    }

    function _getVoteItems() internal view returns (VoteItem[] memory items) {
        SRPhase2UpgradeConfig config = SRPhase2UpgradeConfig(CONFIG);
        address newGateway = config.NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY();
        GatewayConsumerLimits[] memory consumers = config.getGatewayConsumers();

        items = new VoteItem[](RAW_ACTIONS_COUNT);
        uint256 i = 0;

        items[i++] = _item(
            "1.1.1. Call SRPhase2UpgradeTemplate.startUpgrade",
            TEMPLATE,
            abi.encodeCall(SRPhase2UpgradeTemplate.startUpgrade, ())
        );

        // --- Implementations behind proxies ---
        // The locator goes first, so every contract resolving the gateway or the bus through it sees the
        // new address book in the same transaction.
        items[i++] = _item(
            "1.1.2. Upgrade LidoLocator implementation",
            config.LOCATOR(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_LOCATOR_IMPLEMENTATION()))
        );
        // Plain upgradeTo: removing the exit hooks leaves the storage layout untouched, nothing to finalize.
        items[i++] = _item(
            "1.1.3. Upgrade StakingRouter implementation",
            config.STAKING_ROUTER(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_STAKING_ROUTER_IMPL()))
        );

        // TODO allow partial withdrawals for CMv2 once the StakingRouter has setStakingModulePartialWithdrawalsAllowed.

        // Empty setupCalldata: only the TRIGGERABLE_WITHDRAWALS_GATEWAY immutable changes, nothing to finalize.
        items[i++] = _item(
            "1.1.4. Upgrade WithdrawalVault implementation",
            config.WITHDRAWAL_VAULT(),
            abi.encodeCall(IWithdrawalsManagerProxy.proxy_upgradeTo, (config.NEW_WITHDRAWAL_VAULT_IMPL(), ""))
        );

        // TODO upgrade the ValidatorsExitBusOracle once its implementation exists.

        // --- StakingRouter roles of the removed exit hooks ---
        items[i++] = _item(
            "1.1.5. Revoke REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE from the old TriggerableWithdrawalsGateway",
            config.STAKING_ROUTER(),
            abi.encodeCall(
                IAccessControl.revokeRole,
                (REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE, config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY())
            )
        );
        items[i++] = _item(
            "1.1.6. Revoke REPORT_VALIDATOR_EXITING_STATUS_ROLE from the ValidatorExitDelayVerifier",
            config.STAKING_ROUTER(),
            abi.encodeCall(
                IAccessControl.revokeRole,
                (REPORT_VALIDATOR_EXITING_STATUS_ROLE, config.VALIDATOR_EXIT_DELAY_VERIFIER())
            )
        );

        // --- New TriggerableWithdrawalsGateway ---
        // DEFAULT_ADMIN_ROLE needs no item because the gateway is deployed with the Agent as its admin.
        items[i++] = _item(
            "1.1.7. Grant PAUSE_ROLE on the new TriggerableWithdrawalsGateway to the CircuitBreaker",
            newGateway,
            abi.encodeCall(IAccessControl.grantRole, (PAUSE_ROLE, config.CIRCUIT_BREAKER()))
        );
        items[i++] = _item(
            "1.1.8. Grant PAUSE_ROLE on the new TriggerableWithdrawalsGateway to the ResealManager",
            newGateway,
            abi.encodeCall(IAccessControl.grantRole, (PAUSE_ROLE, config.RESEAL_MANAGER()))
        );
        items[i++] = _item(
            "1.1.9. Grant RESUME_ROLE on the new TriggerableWithdrawalsGateway to the ResealManager",
            newGateway,
            abi.encodeCall(IAccessControl.grantRole, (RESUME_ROLE, config.RESEAL_MANAGER()))
        );
        items[i++] = _item(
            "1.1.10. Grant TW_EXIT_LIMIT_MANAGER_ROLE on the new TriggerableWithdrawalsGateway to the Agent",
            newGateway,
            abi.encodeCall(IAccessControl.grantRole, (TW_EXIT_LIMIT_MANAGER_ROLE, AGENT))
        );
        // A consumer without limits cannot submit requests, so these items also decide who may call the gateway.
        // The config holds exactly these four consumers in this order.
        items[i++] = _item(
            "1.1.11. Set the limits of the TriggerableWithdrawalsBus on the new TriggerableWithdrawalsGateway",
            newGateway,
            abi.encodeCall(
                ITriggerableWithdrawalsGateway.setConsumerLimits,
                (consumers[0].consumer, consumers[0].pwrLimit, consumers[0].fwrLimit)
            )
        );
        // TODO replace the CSM, CSM 0x02 and CMv2 ejectors with the CSM release ones that call triggerWithdrawals,
        // and wire them into their modules. The live ejectors call triggerFullWithdrawals, which the new gateway lacks.
        items[i++] = _item(
            "1.1.12. Set the limits of the CSM ejector on the new TriggerableWithdrawalsGateway",
            newGateway,
            abi.encodeCall(
                ITriggerableWithdrawalsGateway.setConsumerLimits,
                (consumers[1].consumer, consumers[1].pwrLimit, consumers[1].fwrLimit)
            )
        );
        items[i++] = _item(
            "1.1.13. Set the limits of the CSM 0x02 ejector on the new TriggerableWithdrawalsGateway",
            newGateway,
            abi.encodeCall(
                ITriggerableWithdrawalsGateway.setConsumerLimits,
                (consumers[2].consumer, consumers[2].pwrLimit, consumers[2].fwrLimit)
            )
        );
        items[i++] = _item(
            "1.1.14. Set the limits of the CMv2 ejector on the new TriggerableWithdrawalsGateway",
            newGateway,
            abi.encodeCall(
                ITriggerableWithdrawalsGateway.setConsumerLimits,
                (consumers[3].consumer, consumers[3].pwrLimit, consumers[3].fwrLimit)
            )
        );
        items[i++] = _item(
            "1.1.15. Register CircuitBreaker pauser for the new TriggerableWithdrawalsGateway",
            config.CIRCUIT_BREAKER(),
            abi.encodeCall(ICircuitBreaker.registerPauser, (newGateway, config.CIRCUIT_BREAKER_COMMITTEE()))
        );
        items[i++] = _item(
            "1.1.16. Unregister CircuitBreaker pauser for the old TriggerableWithdrawalsGateway",
            config.CIRCUIT_BREAKER(),
            abi.encodeCall(ICircuitBreaker.registerPauser, (config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY(), address(0)))
        );

        // --- TriggerableWithdrawalsBus ---
        items[i++] = _item(
            "1.1.17. Grant ADD_WITHDRAWAL_INTENTS_ROLE on the TriggerableWithdrawalsBus to the ValidatorsExitBusOracle",
            config.TRIGGERABLE_WITHDRAWALS_BUS(),
            abi.encodeCall(IAccessControl.grantRole, (ADD_WITHDRAWAL_INTENTS_ROLE, config.VALIDATORS_EXIT_BUS_ORACLE()))
        );

        // --- ValidatorsExitBusOracle: the exit request hash delivery is removed ---
        // The grant stays in the proxy storage, so the revoke does not depend on the VEBO implementation.
        items[i++] = _item(
            "1.1.18. Revoke SUBMIT_REPORT_HASH_ROLE on the ValidatorsExitBusOracle from the Easy Track EVMScriptExecutor",
            config.VALIDATORS_EXIT_BUS_ORACLE(),
            abi.encodeCall(IAccessControl.revokeRole, (SUBMIT_REPORT_HASH_ROLE, config.EASY_TRACK_EVM_SCRIPT_EXECUTOR()))
        );

        // --- OracleReportSanityChecker: one VEBO report must fit into the bus PWR quota ---
        // Nobody holds the setter role, so the Agent holds it only within this vote.
        address sanityChecker = config.ORACLE_REPORT_SANITY_CHECKER();
        items[i++] = _item(
            "1.1.19. Grant MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE on the OracleReportSanityChecker to the Agent",
            sanityChecker,
            abi.encodeCall(IAccessControl.grantRole, (MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE, AGENT))
        );
        items[i++] = _item(
            "1.1.20. Set maxBalanceExitRequestedPerReportInEth on the OracleReportSanityChecker to the PWR maxLimit of the TriggerableWithdrawalsBus",
            sanityChecker,
            abi.encodeCall(
                IOracleReportSanityChecker.setMaxBalanceExitRequestedPerReportInEth,
                (config.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH())
            )
        );
        items[i++] = _item(
            "1.1.21. Revoke MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE on the OracleReportSanityChecker from the Agent",
            sanityChecker,
            abi.encodeCall(IAccessControl.revokeRole, (MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE, AGENT))
        );

        // TODO set the six new OracleDaemonConfig keys once their initial values and encoding are fixed, and grant
        // CONFIG_MANAGER_ROLE to the Easy Track EVMScriptExecutor once the ACTIVE_REBALANCING_* factory exists.

        if (i != RAW_ACTIONS_COUNT) revert InvalidItemsCount(i, RAW_ACTIONS_COUNT);
    }

    function _item(string memory description, address to, bytes memory data) private pure returns (VoteItem memory) {
        return VoteItem({description: description, call: _votingCall(to, data)});
    }
}
