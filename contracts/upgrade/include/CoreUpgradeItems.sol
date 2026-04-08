// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    IUpgradeConfig,
    GeneralConfig,
    CoreUpgradeConfig,
    IKernel,
    IACL,
    IWithdrawalsManagerProxy,
    IStakingRouter,
    IAccountingOracle,
    IVersioned,
    IEasyTrack
} from

"../UpgradeTypes.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {OmnibusBase} from "../utils/OmnibusBase.sol";
import {VoteScriptHelpers} from "../utils/VoteScriptHelpers.sol";

/// @title CoreUpgradeItems
/// @notice Core protocol upgrade items executed by the Agent through Dual Governance.
library CoreUpgradeItems {
    uint256 internal constant COUNT = 17;
    bytes32 internal constant STAKING_MODULE_SHARE_MANAGE_ROLE = keccak256("STAKING_MODULE_SHARE_MANAGE_ROLE");
    // bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    // bytes32 internal constant TOP_UP_ROLE = keccak256("TOP_UP_ROLE");
    // bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    // bytes32 internal constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");
    // bytes32 internal constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
    // bytes32 internal constant REMOVE_ROLE = keccak256("REMOVE_ROLE");
    // bytes32 internal constant ALLOW_PAIR_ROLE = keccak256("ALLOW_PAIR_ROLE");
    // bytes32 internal constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");

    function getItems(IUpgradeConfig template) external view returns (OmnibusBase.VoteItem[] memory items) {
        GeneralConfig memory g = template.getGeneralConfig();
        CoreUpgradeConfig memory c = template.getCoreUpgradeConfig();

        items = new OmnibusBase.VoteItem[](COUNT);
        uint256 i = 0;

        address agent = g.agent;

        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade LidoLocator implementation",
            to: c.locator,
            data: abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (c.newLocatorImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Grant Aragon APP_MANAGER_ROLE to the AGENT",
            to: c.acl,
            data: abi.encodeCall(IACL.grantPermission, (agent, c.kernel, keccak256("APP_MANAGER_ROLE")))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Set Lido implementation in Kernel",
            to: c.kernel,
            data: abi.encodeCall(IKernel.setApp, (IKernel(c.kernel).APP_BASES_NAMESPACE(), c.lidoAppId, c.newLidoImpl))
        });

        items[i++] = VoteScriptHelpers.item({
            description: "Revoke Aragon APP_MANAGER_ROLE from the AGENT",
            to: c.acl,
            data: abi.encodeCall(IACL.revokePermission, (agent, c.kernel, keccak256("APP_MANAGER_ROLE")))
        });



        /// @notice updating implementation and calling finalizeUpgrade
        /// @dev finalizeUpgrade_v4 must be called to migrate storage and OZ roles before any other actions
        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade StakingRouter implementation and finalize v4 migration",
            to: g.stakingRouter,
            data: abi.encodeCall(
                IOssifiableProxy.proxy__upgradeToAndCall,
                (c.newStakingRouterImpl, abi.encodeCall(IStakingRouter.finalizeUpgrade_v4, ()), false)
            )
        });

        /// @notice grant STAKING_MODULE_SHARE_MANAGE_ROLE to EasyTrack executor
        items[i++] = VoteScriptHelpers.item({
            description: "Grant STAKING_MODULE_SHARE_MANAGE_ROLE to EasyTrack executor",
            call: VoteScriptHelpers.grantRole(
                g.stakingRouter, STAKING_MODULE_SHARE_MANAGE_ROLE, g.easyTrackEVMScriptExecutor
            )
        });

        /// @notice updating AccountingOracle implementation
        /// @dev finalizeUpgrade will be called in UpgradeTemplate.finishUpgrade()
        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade AccountingOracle implementation",
            to: c.accountingOracle,
            data: abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (c.newAccountingOracleImpl))
        });

        /// @notice updating Accounting implementation
        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade Accounting implementation",
            to: c.accounting,
            data: abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (c.newAccountingImpl))
        });

        /// @notice updating WithdrawalVault implementation
        /// @dev finalizeUpgrade will be called in UpgradeTemplate.finishUpgrade()
        items[i++] = VoteScriptHelpers.item({
            description: "Upgrade WithdrawalVault implementation",
            to: c.withdrawalVault,
            data: abi.encodeCall(IWithdrawalsManagerProxy.proxy_upgradeTo, (c.newWithdrawalVaultImpl, bytes("")))
        });

        assert(i == COUNT);
    }
}
