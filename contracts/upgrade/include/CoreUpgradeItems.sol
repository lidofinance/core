// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    IUpgradeConfig,
    GeneralConfig,
    CoreUpgradeConfig,
    IWithdrawalsManagerProxy,
    IStakingRouter,
    ITriggerableWithdrawalsGateway
} from "../UpgradeTypes.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {OmnibusBase} from "../utils/OmnibusBase.sol";
import {VoteScriptHelpers} from "../utils/VoteScriptHelpers.sol";

/// @title CoreUpgradeItems
/// @notice Core protocol upgrade items executed by the Agent through Dual Governance.
library CoreUpgradeItems {
    uint256 internal constant COUNT = 17;
    bytes32 internal constant STAKING_MODULE_SHARE_MANAGE_ROLE = keccak256("STAKING_MODULE_SHARE_MANAGE_ROLE");
    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant TOP_UP_ROLE = keccak256("TOP_UP_ROLE");
    bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 internal constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");
    bytes32 internal constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
    bytes32 internal constant REMOVE_ROLE = keccak256("REMOVE_ROLE");
    bytes32 internal constant ALLOW_PAIR_ROLE = keccak256("ALLOW_PAIR_ROLE");
    bytes32 internal constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");

    function getItems(IUpgradeConfig template) external view returns (OmnibusBase.VoteItem[] memory items) {
        GeneralConfig memory g = template.getGeneralConfig();
        CoreUpgradeConfig memory c = template.getCoreUpgradeConfig();

        items = new OmnibusBase.VoteItem[](COUNT);

        uint256 i = 0;

        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade StakingRouter implementation and finalize v4 migration",
            to: g.stakingRouter,
            data: abi.encodeCall(
                IOssifiableProxy.proxy__upgradeToAndCall,
                (c.newStakingRouterImpl, abi.encodeCall(IStakingRouter.finalizeUpgrade_v4, ()), false)
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade AccountingOracle implementation",
            to: g.accountingOracle,
            data: abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (c.newAccountingOracleImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade Accounting implementation",
            to: c.accounting,
            data: abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (c.newAccountingImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade WithdrawalVault implementation",
            to: c.withdrawalVault,
            data: abi.encodeCall(IWithdrawalsManagerProxy.proxy_upgradeTo, (c.newWithdrawalVaultImpl, bytes("")))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade TopUpGateway implementation",
            to: c.topUpGateway,
            data: abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (c.topUpGatewayImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant STAKING_MODULE_SHARE_MANAGE_ROLE to EasyTrack executor",
            call: VoteScriptHelpers.grantRole(
                g.stakingRouter, STAKING_MODULE_SHARE_MANAGE_ROLE, g.easyTrackEVMScriptExecutor
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant ADD_CONSOLIDATION_REQUEST_ROLE to ConsolidationBus on ConsolidationGateway",
            call: VoteScriptHelpers.grantRole(
                c.consolidationGateway, ADD_CONSOLIDATION_REQUEST_ROLE, c.consolidationBus
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant PUBLISH_ROLE to ConsolidationMigrator on ConsolidationBus",
            call: VoteScriptHelpers.grantRole(c.consolidationBus, PUBLISH_ROLE, c.consolidationMigrator)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant ALLOW_PAIR_ROLE to EasyTrack executor on ConsolidationMigrator",
            call: VoteScriptHelpers.grantRole(c.consolidationMigrator, ALLOW_PAIR_ROLE, g.easyTrackEVMScriptExecutor)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant EXECUTE_ROLE to ConsolidationBus bot",
            call: VoteScriptHelpers.grantRole(c.consolidationBus, EXECUTE_ROLE, c.consolidationBusBot)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant REMOVE_ROLE to ConsolidationBus bot",
            call: VoteScriptHelpers.grantRole(c.consolidationBus, REMOVE_ROLE, c.consolidationBusBot)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant PAUSE_ROLE to GateSeal on ConsolidationGateway",
            call: VoteScriptHelpers.grantRole(c.consolidationGateway, PAUSE_ROLE, c.consolidationGatewayGateSeal)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant TOP_UP_ROLE to top-up depositor bot on TopUpGateway",
            call: VoteScriptHelpers.grantRole(c.topUpGateway, TOP_UP_ROLE, c.topUpDepositorBot)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant TW_EXIT_LIMIT_MANAGER_ROLE to Agent on TriggerableWithdrawalsGateway",
            call: VoteScriptHelpers.grantRole(g.triggerableWithdrawalsGateway, TW_EXIT_LIMIT_MANAGER_ROLE, g.agent)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Update TriggerableWithdrawalsGateway exit request limits",
            to: g.triggerableWithdrawalsGateway,
            data: abi.encodeCall(
                ITriggerableWithdrawalsGateway.setExitRequestLimit,
                (c.twMaxExitRequestsLimit, c.twExitsPerFrame, c.twFrameDurationInSec)
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Revoke TW_EXIT_LIMIT_MANAGER_ROLE from Agent on TriggerableWithdrawalsGateway",
            call: VoteScriptHelpers.revokeRole(g.triggerableWithdrawalsGateway, TW_EXIT_LIMIT_MANAGER_ROLE, g.agent)
        });

        assert(i == COUNT);
    }
}
