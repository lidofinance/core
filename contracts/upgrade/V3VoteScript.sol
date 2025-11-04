// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";

import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {OmnibusBase} from "./utils/OmnibusBase.sol";
import {V3Template} from "./V3Template.sol";

interface IKernel {
    function setApp(bytes32 _namespace, bytes32 _appId, address _app) external;
    function APP_BASES_NAMESPACE() external view returns (bytes32);
}

interface IOracleDaemonConfig {
    function CONFIG_MANAGER_ROLE() external view returns (bytes32);
    function set(string calldata _key, bytes calldata _value) external;
}

interface IStakingRouter {
    function REPORT_REWARDS_MINTED_ROLE() external view returns (bytes32);
}

/// @title V3VoteScript
/// @notice Script for upgrading Lido protocol components
contract V3VoteScript is OmnibusBase {

    struct ScriptParams {
        address upgradeTemplate;
        bytes32 lidoAppId;
    }

    //
    // Constants
    //
    uint256 public constant VOTE_ITEMS_COUNT = 17;

    //
    // Immutables
    //
    V3Template public immutable TEMPLATE;

    //
    // Structured storage
    //
    ScriptParams public params;

    constructor(
        ScriptParams memory _params
    ) OmnibusBase(V3Template(_params.upgradeTemplate).VOTING(), V3Template(_params.upgradeTemplate).DUAL_GOVERNANCE()) {
        TEMPLATE = V3Template(_params.upgradeTemplate);

        params = _params;
    }

    function getVotingVoteItems() public pure override returns (VoteItem[] memory votingVoteItems) {
        votingVoteItems = new VoteItem[](0);
    }

    function getVoteItems() public view override returns (VoteItem[] memory voteItems) {
        voteItems = new VoteItem[](VOTE_ITEMS_COUNT);
        uint256 index = 0;

        voteItems[index++] = VoteItem({
            description: "1. Call UpgradeTemplateV3.startUpgrade",
            call: _forwardCall(TEMPLATE.AGENT(), params.upgradeTemplate, abi.encodeCall(V3Template.startUpgrade, ()))
        });

        voteItems[index++] = VoteItem({
            description: "2. Upgrade LidoLocator implementation",
            call: _forwardCall(TEMPLATE.AGENT(), TEMPLATE.LOCATOR(), abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (TEMPLATE.NEW_LOCATOR_IMPL())))
        });

        voteItems[index++] = VoteItem({
            description: "3. Grant Aragon APP_MANAGER_ROLE to the AGENT",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ACL(),
                abi.encodeWithSignature(
                    "grantPermission(address,address,bytes32)",
                    TEMPLATE.AGENT(),
                    TEMPLATE.KERNEL(),
                    keccak256("APP_MANAGER_ROLE")
                )
            )
        });

        voteItems[index++] = VoteItem({
            description: "4. Set Lido implementation in Kernel",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.KERNEL(),
                abi.encodeCall(IKernel.setApp, (IKernel(TEMPLATE.KERNEL()).APP_BASES_NAMESPACE(), params.lidoAppId, TEMPLATE.NEW_LIDO_IMPL()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "5. Revoke Aragon APP_MANAGER_ROLE from the AGENT",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ACL(),
                abi.encodeWithSignature(
                    "revokePermission(address,address,bytes32)",
                    TEMPLATE.AGENT(),
                    TEMPLATE.KERNEL(),
                    keccak256("APP_MANAGER_ROLE")
                )
            )
        });

        bytes32 requestBurnSharesRole = IBurner(TEMPLATE.OLD_BURNER()).REQUEST_BURN_SHARES_ROLE();
        voteItems[index++] = VoteItem({
            description: "6. Revoke REQUEST_BURN_SHARES_ROLE from Lido",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.LIDO()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "7. Revoke REQUEST_BURN_SHARES_ROLE from Curated staking module",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.NODE_OPERATORS_REGISTRY()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "8. Revoke REQUEST_BURN_SHARES_ROLE from SimpleDVT",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.SIMPLE_DVT()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "9. Revoke REQUEST_BURN_SHARES_ROLE from Community Staking Accounting",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.CSM_ACCOUNTING()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "10. Upgrade AccountingOracle implementation",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ACCOUNTING_ORACLE(),
                abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (TEMPLATE.NEW_ACCOUNTING_ORACLE_IMPL()))
            )
        });

        bytes32 reportRewardsMintedRole = IStakingRouter(TEMPLATE.STAKING_ROUTER()).REPORT_REWARDS_MINTED_ROLE();
        voteItems[index++] = VoteItem({
            description: "11. Revoke REPORT_REWARDS_MINTED_ROLE from Lido",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.STAKING_ROUTER(),
                abi.encodeCall(IAccessControl.revokeRole, (reportRewardsMintedRole, TEMPLATE.LIDO()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "12. Grant REPORT_REWARDS_MINTED_ROLE to Accounting",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.STAKING_ROUTER(),
                abi.encodeCall(IAccessControl.grantRole, (reportRewardsMintedRole, TEMPLATE.ACCOUNTING()))
            )
        });

        bytes32 configManagerRole = IOracleDaemonConfig(TEMPLATE.ORACLE_DAEMON_CONFIG()).CONFIG_MANAGER_ROLE();

        voteItems[index++] = VoteItem({
            description: "13. Grant OracleDaemonConfig's CONFIG_MANAGER_ROLE to Agent",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ORACLE_DAEMON_CONFIG(),
                abi.encodeCall(IAccessControl.grantRole, (configManagerRole, TEMPLATE.AGENT()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "14. Set SLASHING_RESERVE_WE_RIGHT_SHIFT to 0x2000 at OracleDaemonConfig",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ORACLE_DAEMON_CONFIG(),
                abi.encodeCall(IOracleDaemonConfig.set, ("SLASHING_RESERVE_WE_RIGHT_SHIFT", abi.encode(0x2000)))
            )
        });

        voteItems[index++] = VoteItem({
            description: "15. Set SLASHING_RESERVE_WE_LEFT_SHIFT to 0x2000 at OracleDaemonConfig",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ORACLE_DAEMON_CONFIG(),
                abi.encodeCall(IOracleDaemonConfig.set, ("SLASHING_RESERVE_WE_LEFT_SHIFT", abi.encode(0x2000)))
            )
        });

        voteItems[index++] = VoteItem({
            description: "16. Revoke OracleDaemonConfig's CONFIG_MANAGER_ROLE from Agent",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ORACLE_DAEMON_CONFIG(),
                abi.encodeCall(IAccessControl.revokeRole, (configManagerRole, TEMPLATE.AGENT()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "17. Call UpgradeTemplateV3.finishUpgrade",
            call: _forwardCall(TEMPLATE.AGENT(), params.upgradeTemplate, abi.encodeCall(V3Template.finishUpgrade, ()))
        });

        assert(index == VOTE_ITEMS_COUNT);
    }
}
