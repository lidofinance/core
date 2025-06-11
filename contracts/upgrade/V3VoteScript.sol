// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";

import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {OmnibusBase} from "./utils/OmnibusBase.sol";
import {V3Template} from "./V3Template.sol";

interface IRepo {
    function newVersion(uint16[3] calldata _newSemanticVersion, address _contractAddress, bytes calldata _contentURI) external;
}

interface IKernel {
    function setApp(bytes32 _namespace, bytes32 _appId, address _app) external;
    function APP_BASES_NAMESPACE() external view returns (bytes32);
}

interface IStakingRouter {
    function REPORT_REWARDS_MINTED_ROLE() external view returns (bytes32);
}

/// @title V3VoteScript
/// @notice Script for upgrading Lido protocol components
contract V3VoteScript is OmnibusBase {

    struct ScriptParams {
        address upgradeTemplate;
        uint16[3] lidoAppNewVersion;
        bytes32 lidoAppId;
    }

    //
    // Constants
    //
    uint256 public constant VOTE_ITEMS_COUNT = 12;

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
    ) OmnibusBase(V3Template(_params.upgradeTemplate).VOTING()) {
        TEMPLATE = V3Template(_params.upgradeTemplate);

        params = _params;
    }

    function getVoteItems() public view override returns (VoteItem[] memory voteItems) {
        voteItems = new VoteItem[](VOTE_ITEMS_COUNT);
        uint256 index = 0;

        // Start the upgrade process
        voteItems[index++] = VoteItem({
            description: "1. Call UpgradeTemplateV3.startUpgrade",
            call: _forwardCall(TEMPLATE.AGENT(), params.upgradeTemplate, abi.encodeCall(V3Template.startUpgrade, ()))
        });

        // Upgrade LidoLocator implementation
        voteItems[index++] = VoteItem({
            description: "2. Upgrade LidoLocator implementation",
            call: _forwardCall(TEMPLATE.AGENT(), TEMPLATE.LOCATOR(), abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (TEMPLATE.NEW_LOCATOR_IMPL())))
        });

        // Update Lido version in Lido App Repo
        voteItems[index++] = VoteItem({
            description: "3. Update Lido version in Lido App Repo",
            call: _votingCall(TEMPLATE.ARAGON_APP_LIDO_REPO(), abi.encodeCall(IRepo.newVersion, (
                    params.lidoAppNewVersion,
                    TEMPLATE.NEW_LIDO_IMPL(),
                    "0x"
                )))
        });

        // Set Lido implementation in Kernel
        voteItems[index++] = VoteItem({
            description: "4. Set Lido implementation in Kernel",
            call: _votingCall(
                TEMPLATE.KERNEL(),
                abi.encodeCall(IKernel.setApp, (IKernel(TEMPLATE.KERNEL()).APP_BASES_NAMESPACE(), params.lidoAppId, TEMPLATE.NEW_LIDO_IMPL()))
            )
        });

        // Revoke REQUEST_BURN_SHARES_ROLE from Lido
        bytes32 requestBurnSharesRole = IBurner(TEMPLATE.OLD_BURNER()).REQUEST_BURN_SHARES_ROLE();
        voteItems[index++] = VoteItem({
            description: "5. Revoke REQUEST_BURN_SHARES_ROLE from Lido",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.LIDO()))
            )
        });

        // Revoke REQUEST_BURN_SHARES_ROLE from Curated staking modules (NodeOperatorsRegistry)
        voteItems[index++] = VoteItem({
            description: "6. Revoke REQUEST_BURN_SHARES_ROLE from Curated staking module",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.NODE_OPERATORS_REGISTRY()))
            )
        });

        // Revoke REQUEST_BURN_SHARES_ROLE from SimpleDVT
        voteItems[index++] = VoteItem({
            description: "7. Revoke REQUEST_BURN_SHARES_ROLE from SimpleDVT",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.SIMPLE_DVT()))
            )
        });

        // Revoke REQUEST_BURN_SHARES_ROLE from CS Accounting
        voteItems[index++] = VoteItem({
            description: "8. Revoke REQUEST_BURN_SHARES_ROLE from Community Staking Accounting",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.CSM_ACCOUNTING()))
            )
        });

        // Upgrade AccountingOracle implementation
        voteItems[index++] = VoteItem({
            description: "9. Upgrade AccountingOracle implementation",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ACCOUNTING_ORACLE(),
                abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (TEMPLATE.NEW_ACCOUNTING_ORACLE_IMPL()))
            )
        });

        // Revoke REPORT_REWARDS_MINTED_ROLE from Lido
        bytes32 reportRewardsMintedRole = IStakingRouter(TEMPLATE.STAKING_ROUTER()).REPORT_REWARDS_MINTED_ROLE();
        voteItems[index++] = VoteItem({
            description: "10. Revoke REPORT_REWARDS_MINTED_ROLE from Lido",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.STAKING_ROUTER(),
                abi.encodeCall(IAccessControl.revokeRole, (reportRewardsMintedRole, TEMPLATE.LIDO()))
            )
        });

        // Grant REPORT_REWARDS_MINTED_ROLE to Accounting
        voteItems[index++] = VoteItem({
            description: "11. Grant REPORT_REWARDS_MINTED_ROLE to Accounting",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.STAKING_ROUTER(),
                abi.encodeCall(IAccessControl.grantRole, (reportRewardsMintedRole, TEMPLATE.ACCOUNTING()))
            )
        });

        // Finish the upgrade process
        voteItems[index++] = VoteItem({
            description: "12. Call UpgradeTemplateV3.finishUpgrade",
            call: _forwardCall(TEMPLATE.AGENT(), params.upgradeTemplate, abi.encodeCall(V3Template.finishUpgrade, ()))
        });

        assert(index == VOTE_ITEMS_COUNT);
    }
}
