// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    IUpgradeConfig,
    GeneralConfig,
    CoreUpgradeConfig,
    IWithdrawalsManagerProxy,
    IStakingRouter
} from "../UpgradeTypes.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {OmnibusBase} from "../utils/OmnibusBase.sol";
import {VoteScriptHelpers} from "../utils/VoteScriptHelpers.sol";

/// @title CoreUpgradeItems
/// @notice Core protocol upgrade items executed by the Agent through Dual Governance.
library CoreUpgradeItems {
    uint256 internal constant COUNT = 8;

    bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 internal constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");

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
                g.stakingRouter, IStakingRouter(g.stakingRouter).STAKING_MODULE_SHARE_MANAGE_ROLE(), g.easyTrackEVMScriptExecutor
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant ADD_CONSOLIDATION_REQUEST_ROLE to ConsolidationBus on ConsolidationGateway",
            call: VoteScriptHelpers.grantRole(c.consolidationGateway, ADD_CONSOLIDATION_REQUEST_ROLE, c.consolidationBus)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant PUBLISH_ROLE to ConsolidationMigrator on ConsolidationBus",
            call: VoteScriptHelpers.grantRole(c.consolidationBus, PUBLISH_ROLE, c.consolidationMigrator)
        });

        assert(i == COUNT);
    }
}
