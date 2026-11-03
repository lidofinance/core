// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";
import {Strings} from "@openzeppelin/contracts-v5.2/utils/Strings.sol";

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
contract SRPhase2UpgradeVoteScript is OmnibusBase {
    using CallsScriptBuilder for CallsScriptBuilder.Context;
    using Strings for uint256;

    error InvalidItemsCount(uint256 actual, uint256 expected);

    uint256 public constant DG_ITEMS_COUNT = 4;
    uint256 public constant VOTING_ITEMS_COUNT = 0;
    /// @notice Agent actions of the first Dual Governance call
    uint256 public constant RAW_ACTIONS_COUNT = 17;

    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");
    bytes32 internal constant ADD_WITHDRAWAL_INTENTS_ROLE = keccak256("ADD_WITHDRAWAL_INTENTS_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE =
        keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXITING_STATUS_ROLE =
        keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");

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

    function getVotingVoteItems() public pure override returns (VoteItem[] memory items) {
        items = new VoteItem[](VOTING_ITEMS_COUNT);
    }

    /// @notice Agent actions of the first Dual Governance call, numbered as its sub-items.
    function getVoteItemsRaw() external view returns (VoteItem[] memory) {
        VoteItem[] memory items = _getVoteItems();
        for (uint256 i = 0; i < items.length; ++i) {
            items[i].description = string.concat("1.", (i + 1).toString(), ". ", items[i].description);
        }
        return items;
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
            description: "1. Upgrade the SR phase 2 (LIP-38) contracts through the Agent",
            call: _votingCall(AGENT, abi.encodeCall(IForwarder.forward, (scriptBuilder.getResult())))
        });
        items[1] = VoteItem({
            description: "2. Remove the old TriggerableWithdrawalsGateway from the Dual Governance tiebreaker sealable withdrawal blockers",
            call: _votingCall(
                dualGovernance,
                abi.encodeCall(
                    IDualGovernanceTiebreaker.removeTiebreakerSealableWithdrawalBlocker,
                    (config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY())
                )
            )
        });
        items[2] = VoteItem({
            description: "3. Add the new TriggerableWithdrawalsGateway to the Dual Governance tiebreaker sealable withdrawal blockers",
            call: _votingCall(
                dualGovernance,
                abi.encodeCall(
                    IDualGovernanceTiebreaker.addTiebreakerSealableWithdrawalBlocker,
                    (config.NEW_TRIGGERABLE_WITHDRAWALS_GATEWAY())
                )
            )
        });
        items[3] = VoteItem({
            description: "4. Call SRPhase2UpgradeTemplate.finishUpgrade",
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
            "Call SRPhase2UpgradeTemplate.startUpgrade",
            TEMPLATE,
            abi.encodeCall(SRPhase2UpgradeTemplate.startUpgrade, ())
        );

        // --- Implementations behind proxies ---
        // The locator goes first, so every contract resolving the gateway or the bus through it sees the
        // new address book in the same transaction.
        items[i++] = _item(
            "Upgrade LidoLocator implementation",
            config.LOCATOR(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_LOCATOR_IMPLEMENTATION()))
        );
        // Plain upgradeTo: removing the exit hooks leaves the storage layout untouched, nothing to finalize.
        items[i++] = _item(
            "Upgrade StakingRouter implementation",
            config.STAKING_ROUTER(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_STAKING_ROUTER_IMPL()))
        );
        // Empty setupCalldata: only the TRIGGERABLE_WITHDRAWALS_GATEWAY immutable changes, nothing to finalize.
        items[i++] = _item(
            "Upgrade WithdrawalVault implementation",
            config.WITHDRAWAL_VAULT(),
            abi.encodeCall(IWithdrawalsManagerProxy.proxy_upgradeTo, (config.NEW_WITHDRAWAL_VAULT_IMPL(), ""))
        );

        // TODO upgrade the ValidatorsExitBusOracle once its implementation exists.

        // --- StakingRouter roles of the removed exit hooks ---
        items[i++] = _item(
            "Revoke REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE from the old TriggerableWithdrawalsGateway",
            config.STAKING_ROUTER(),
            abi.encodeCall(
                IAccessControl.revokeRole,
                (REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE, config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY())
            )
        );
        items[i++] = _item(
            "Revoke REPORT_VALIDATOR_EXITING_STATUS_ROLE from the ValidatorExitDelayVerifier",
            config.STAKING_ROUTER(),
            abi.encodeCall(
                IAccessControl.revokeRole,
                (REPORT_VALIDATOR_EXITING_STATUS_ROLE, config.VALIDATOR_EXIT_DELAY_VERIFIER())
            )
        );

        // --- New TriggerableWithdrawalsGateway ---
        // DEFAULT_ADMIN_ROLE needs no item because the gateway is deployed with the Agent as its admin.
        items[i++] = _item(
            "Grant PAUSE_ROLE on the new TriggerableWithdrawalsGateway to the CircuitBreaker",
            newGateway,
            abi.encodeCall(IAccessControl.grantRole, (PAUSE_ROLE, config.CIRCUIT_BREAKER()))
        );
        items[i++] = _item(
            "Grant PAUSE_ROLE on the new TriggerableWithdrawalsGateway to the ResealManager",
            newGateway,
            abi.encodeCall(IAccessControl.grantRole, (PAUSE_ROLE, config.RESEAL_MANAGER()))
        );
        items[i++] = _item(
            "Grant RESUME_ROLE on the new TriggerableWithdrawalsGateway to the ResealManager",
            newGateway,
            abi.encodeCall(IAccessControl.grantRole, (RESUME_ROLE, config.RESEAL_MANAGER()))
        );
        items[i++] = _item(
            "Grant TW_EXIT_LIMIT_MANAGER_ROLE on the new TriggerableWithdrawalsGateway to the Agent",
            newGateway,
            abi.encodeCall(IAccessControl.grantRole, (TW_EXIT_LIMIT_MANAGER_ROLE, AGENT))
        );
        // A consumer without limits cannot submit requests, so these items also decide who may call the gateway.
        // The config holds exactly these four consumers in this order.
        items[i++] = _item(
            "Set the limits of the TriggerableWithdrawalsBus on the new TriggerableWithdrawalsGateway",
            newGateway,
            abi.encodeCall(
                ITriggerableWithdrawalsGateway.setConsumerLimits,
                (consumers[0].consumer, consumers[0].pwrLimit, consumers[0].fwrLimit)
            )
        );
        items[i++] = _item(
            "Set the limits of the CSM ejector on the new TriggerableWithdrawalsGateway",
            newGateway,
            abi.encodeCall(
                ITriggerableWithdrawalsGateway.setConsumerLimits,
                (consumers[1].consumer, consumers[1].pwrLimit, consumers[1].fwrLimit)
            )
        );
        items[i++] = _item(
            "Set the limits of the CSM 0x02 ejector on the new TriggerableWithdrawalsGateway",
            newGateway,
            abi.encodeCall(
                ITriggerableWithdrawalsGateway.setConsumerLimits,
                (consumers[2].consumer, consumers[2].pwrLimit, consumers[2].fwrLimit)
            )
        );
        items[i++] = _item(
            "Set the limits of the CMv2 ejector on the new TriggerableWithdrawalsGateway",
            newGateway,
            abi.encodeCall(
                ITriggerableWithdrawalsGateway.setConsumerLimits,
                (consumers[3].consumer, consumers[3].pwrLimit, consumers[3].fwrLimit)
            )
        );
        items[i++] = _item(
            "Register CircuitBreaker pauser for the new TriggerableWithdrawalsGateway",
            config.CIRCUIT_BREAKER(),
            abi.encodeCall(ICircuitBreaker.registerPauser, (newGateway, config.CIRCUIT_BREAKER_COMMITTEE()))
        );
        items[i++] = _item(
            "Unregister CircuitBreaker pauser for the old TriggerableWithdrawalsGateway",
            config.CIRCUIT_BREAKER(),
            abi.encodeCall(ICircuitBreaker.registerPauser, (config.OLD_TRIGGERABLE_WITHDRAWALS_GATEWAY(), address(0)))
        );

        // --- TriggerableWithdrawalsBus ---
        items[i++] = _item(
            "Grant ADD_WITHDRAWAL_INTENTS_ROLE on the TriggerableWithdrawalsBus to the ValidatorsExitBusOracle",
            config.TRIGGERABLE_WITHDRAWALS_BUS(),
            abi.encodeCall(IAccessControl.grantRole, (ADD_WITHDRAWAL_INTENTS_ROLE, config.VALIDATORS_EXIT_BUS_ORACLE()))
        );

        if (i != RAW_ACTIONS_COUNT) revert InvalidItemsCount(i, RAW_ACTIONS_COUNT);
    }

    function _item(string memory description, address to, bytes memory data) private pure returns (VoteItem memory) {
        return VoteItem({description: description, call: _votingCall(to, data)});
    }
}
