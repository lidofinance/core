// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";
import {Strings} from "@openzeppelin/contracts-v5.2/utils/Strings.sol";

import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {UpgradeConfig} from "./UpgradeConfig.sol";
import {UpgradeTemplate} from "./UpgradeTemplate.sol";
import {IWithdrawalsManagerProxy} from "./UpgradeTypes.sol";
import {IForwarder} from "./interfaces/IForwarder.sol";
import {CallsScriptBuilder} from "./utils/CallScriptBuilder.sol";
import {OmnibusBase} from "./utils/OmnibusBase.sol";

/// @title UpgradeVoteScript
/// @notice Omnibus for the Gloas upgrade: swaps in the fork-aware verifiers and re-wires the
///         contracts whose immutables point at the replaced `ConsolidationGateway`.
contract UpgradeVoteScript is OmnibusBase {
    using CallsScriptBuilder for CallsScriptBuilder.Context;
    using Strings for uint256;

    error InvalidItemsCount(uint256 actual, uint256 expected);

    uint256 public constant DG_ITEMS_COUNT = 1;
    uint256 public constant VOTING_ITEMS_COUNT = 0;
    uint256 public constant RAW_ACTIONS_COUNT = 15;

    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
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
            UpgradeConfig(UpgradeTemplate(params.upgradeTemplate).CONFIG()).VOTING(),
            UpgradeConfig(UpgradeTemplate(params.upgradeTemplate).CONFIG()).DUAL_GOVERNANCE()
        )
    {
        UpgradeTemplate template = UpgradeTemplate(params.upgradeTemplate);
        UpgradeConfig config = UpgradeConfig(template.CONFIG());
        TEMPLATE = address(template);
        CONFIG = address(config);
        AGENT = config.AGENT();
    }

    function getVotingVoteItems() public pure override returns (VoteItem[] memory items) {
        items = new VoteItem[](VOTING_ITEMS_COUNT);
    }

    function getVoteItemsRaw() external view returns (VoteItem[] memory) {
        VoteItem[] memory items = _getVoteItems();
        for (uint256 i = 0; i < items.length; ++i) {
            items[i].description = string.concat("1.", (i + 1).toString(), ". ", items[i].description);
        }
        return items;
    }

    function getVoteItems() public view override returns (VoteItem[] memory items) {
        VoteItem[] memory rawItems = _getVoteItems();
        CallsScriptBuilder.Context memory scriptBuilder = CallsScriptBuilder.create();
        for (uint256 i = 0; i < rawItems.length; ++i) {
            scriptBuilder.addCall(rawItems[i].call.to, rawItems[i].call.data);
        }

        items = new VoteItem[](DG_ITEMS_COUNT);
        items[0] = VoteItem({
            description: "1. Submit the Gloas verifiers upgrade to Dual Governance",
            call: _votingCall(AGENT, abi.encodeCall(IForwarder.forward, (scriptBuilder.getResult())))
        });
    }

    function _getVoteItems() internal view returns (VoteItem[] memory items) {
        UpgradeConfig config = UpgradeConfig(CONFIG);
        items = new VoteItem[](RAW_ACTIONS_COUNT);
        uint256 i = 0;

        items[i++] = _item(
            "Call UpgradeTemplate.startUpgrade",
            TEMPLATE,
            abi.encodeCall(UpgradeTemplate.startUpgrade, ())
        );

        // --- Implementations behind proxies ---
        // The locator goes first: every immutable below is re-pointed in the same transaction,
        // so no caller observes a half-migrated address book.
        items[i++] = _item(
            "Upgrade LidoLocator implementation",
            config.LOCATOR(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_LOCATOR_IMPLEMENTATION()))
        );
        items[i++] = _item(
            "Upgrade PredepositGuarantee implementation",
            config.PREDEPOSIT_GUARANTEE(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_PREDEPOSIT_GUARANTEE_IMPL()))
        );
        items[i++] = _item(
            "Upgrade TopUpGateway implementation",
            config.TOP_UP_GATEWAY(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_TOP_UP_GATEWAY_IMPL()))
        );
        items[i++] = _item(
            "Upgrade ConsolidationBus implementation",
            config.CONSOLIDATION_BUS(),
            abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (config.NEW_CONSOLIDATION_BUS_IMPL()))
        );
        // No setup calldata: `finalizeUpgrade_v3` already ran in SRv3 and would revert on a
        // second call. Only the CONSOLIDATION_GATEWAY immutable changes here.
        items[i++] = _item(
            "Upgrade WithdrawalVault implementation",
            config.WITHDRAWAL_VAULT(),
            abi.encodeCall(IWithdrawalsManagerProxy.proxy_upgradeTo, (config.NEW_WITHDRAWAL_VAULT_IMPL(), ""))
        );

        // --- New ValidatorExitDelayVerifier ---
        items[i++] = _item(
            "Grant REPORT_VALIDATOR_EXITING_STATUS_ROLE to the new ValidatorExitDelayVerifier",
            config.STAKING_ROUTER(),
            abi.encodeCall(
                IAccessControl.grantRole,
                (REPORT_VALIDATOR_EXITING_STATUS_ROLE, config.NEW_VALIDATOR_EXIT_DELAY_VERIFIER())
            )
        );
        items[i++] = _item(
            "Revoke REPORT_VALIDATOR_EXITING_STATUS_ROLE from the old ValidatorExitDelayVerifier",
            config.STAKING_ROUTER(),
            abi.encodeCall(
                IAccessControl.revokeRole,
                (REPORT_VALIDATOR_EXITING_STATUS_ROLE, config.OLD_VALIDATOR_EXIT_DELAY_VERIFIER())
            )
        );

        // --- New ConsolidationGateway ---
        // Mirrors UpgradeTemporaryAdmin._setupConsolidationGateway from SRv3; DEFAULT_ADMIN_ROLE
        // needs no item because the gateway is deployed with the Agent as its admin.
        items[i++] = _item(
            "Grant PAUSE_ROLE on the new ConsolidationGateway to the CircuitBreaker",
            config.NEW_CONSOLIDATION_GATEWAY(),
            abi.encodeCall(IAccessControl.grantRole, (PAUSE_ROLE, config.CIRCUIT_BREAKER()))
        );
        items[i++] = _item(
            "Grant PAUSE_ROLE on the new ConsolidationGateway to the ResealManager",
            config.NEW_CONSOLIDATION_GATEWAY(),
            abi.encodeCall(IAccessControl.grantRole, (PAUSE_ROLE, config.RESEAL_MANAGER()))
        );
        items[i++] = _item(
            "Grant RESUME_ROLE on the new ConsolidationGateway to the ResealManager",
            config.NEW_CONSOLIDATION_GATEWAY(),
            abi.encodeCall(IAccessControl.grantRole, (RESUME_ROLE, config.RESEAL_MANAGER()))
        );
        items[i++] = _item(
            "Grant ADD_CONSOLIDATION_REQUEST_ROLE on the new ConsolidationGateway to the ConsolidationBus",
            config.NEW_CONSOLIDATION_GATEWAY(),
            abi.encodeCall(IAccessControl.grantRole, (ADD_CONSOLIDATION_REQUEST_ROLE, config.CONSOLIDATION_BUS()))
        );
        items[i++] = _item(
            "Register CircuitBreaker pauser for the new ConsolidationGateway",
            config.CIRCUIT_BREAKER(),
            abi.encodeCall(
                ICircuitBreaker.registerPauser,
                (config.NEW_CONSOLIDATION_GATEWAY(), config.CIRCUIT_BREAKER_COMMITTEE())
            )
        );
        // Leaving the outgoing gateway registered would keep it looking pausable to the committee,
        // so an incident response could be spent on a contract nothing calls any more.
        items[i++] = _item(
            "Unregister CircuitBreaker pauser for the old ConsolidationGateway",
            config.CIRCUIT_BREAKER(),
            abi.encodeCall(ICircuitBreaker.registerPauser, (config.OLD_CONSOLIDATION_GATEWAY(), address(0)))
        );

        items[i++] = _item(
            "Call UpgradeTemplate.finishUpgrade",
            TEMPLATE,
            abi.encodeCall(UpgradeTemplate.finishUpgrade, ())
        );

        if (i != RAW_ACTIONS_COUNT) revert InvalidItemsCount(i, RAW_ACTIONS_COUNT);
    }

    function _item(string memory description, address to, bytes memory data) private pure returns (VoteItem memory) {
        return VoteItem({description: description, call: _votingCall(to, data)});
    }
}
