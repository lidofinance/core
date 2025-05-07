// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IBurner} from "contracts/common/interfaces/IBurner.sol";

import {OmnibusBase} from "./OmnibusBase.sol";
import {IOssifiableProxy} from "./interfaces/IOssifiableProxy.sol";
import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";
import {V3Addresses} from "./V3Addresses.sol";

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

interface ITemplateV3 {
    function startUpgrade() external;
    function finishUpgrade() external;
}

/// @title V3VoteScript
/// @notice Script for upgrading Lido protocol components
contract V3VoteScript is OmnibusBase {

    struct ScriptParams {
        address v3UpgradeAddresses;
        address upgradeTemplate;
        uint16[3] lidoAppNewVersion;
        bytes32 lidoAppId;
        address newLidoImpl;
        address newAccountingOracleImpl;
    }

    //
    // Constants
    //
    uint256 public constant VOTE_ITEMS_COUNT = 11;

    //
    // Immutables
    //
    V3Addresses public immutable ADDRESSES;

    //
    // Structured storage
    //
    ScriptParams public params;

    constructor(
        ScriptParams memory _params
    ) OmnibusBase(V3Addresses(_params.v3UpgradeAddresses).VOTING()) {
        ADDRESSES = V3Addresses(_params.v3UpgradeAddresses);

        params = _params;
    }

    function getVoteItems() public view override returns (VoteItem[] memory voteItems) {
        voteItems = new VoteItem[](VOTE_ITEMS_COUNT);
        uint256 index = 0;

        // Start the upgrade process
        voteItems[index++] = VoteItem({
            description: "1. Call UpgradeTemplateV3.startUpgrade",
            call: _votingCall(address(params.upgradeTemplate), abi.encodeCall(ITemplateV3.startUpgrade, ()))
        });

        // Upgrade LidoLocator implementation
        voteItems[index++] = VoteItem({
            description: "2. Upgrade LidoLocator implementation",
            call: _forwardCall(ADDRESSES.AGENT(), ADDRESSES.LOCATOR(), abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (ADDRESSES.NEW_LOCATOR_IMPLEMENTATION())))
        });

        // Update Lido version in Lido App Repo
        voteItems[index++] = VoteItem({
            description: "3. Update Lido version in Lido App Repo",
            call: _votingCall(ADDRESSES.ARAGON_APP_LIDO_REPO(), abi.encodeCall(IRepo.newVersion, (
                    params.lidoAppNewVersion,
                    params.newLidoImpl,
                    "0x"
                )))
        });

        // Set Lido implementation in Kernel
        voteItems[index++] = VoteItem({
            description: "4. Set Lido implementation in Kernel",
            call: _votingCall(
                ADDRESSES.KERNEL(),
                abi.encodeCall(IKernel.setApp, (IKernel(ADDRESSES.KERNEL()).APP_BASES_NAMESPACE(), params.lidoAppId, params.newLidoImpl))
            )
        });

        // Revoke REQUEST_BURN_SHARES_ROLE from Lido
        bytes32 requestBurnSharesRole = IBurner(ADDRESSES.OLD_BURNER()).REQUEST_BURN_SHARES_ROLE();
        voteItems[index++] = VoteItem({
            description: "5. Revoke REQUEST_BURN_SHARES_ROLE from Lido",
            call: _forwardCall(
                ADDRESSES.AGENT(),
                ADDRESSES.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, ADDRESSES.LIDO()))
            )
        });

        // Revoke REQUEST_BURN_SHARES_ROLE from Curated staking modules (NodeOperatorsRegistry)
        voteItems[index++] = VoteItem({
            description: "6. Revoke REQUEST_BURN_SHARES_ROLE from Curated staking module",
            call: _forwardCall(
                ADDRESSES.AGENT(),
                ADDRESSES.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, ADDRESSES.NODE_OPERATORS_REGISTRY()))
            )
        });

        // Revoke REQUEST_BURN_SHARES_ROLE from SimpleDVT
        voteItems[index++] = VoteItem({
            description: "7. Revoke REQUEST_BURN_SHARES_ROLE from SimpleDVT",
            call: _forwardCall(
                ADDRESSES.AGENT(),
                ADDRESSES.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, ADDRESSES.SIMPLE_DVT()))
            )
        });

        // Revoke REQUEST_BURN_SHARES_ROLE from CS Accounting
        voteItems[index++] = VoteItem({
            description: "8. Revoke REQUEST_BURN_SHARES_ROLE from Community Staking Accounting",
            call: _forwardCall(
                ADDRESSES.AGENT(),
                ADDRESSES.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, ADDRESSES.CSM_ACCOUNTING()))
            )
        });

        // Upgrade AccountingOracle implementation
        voteItems[index++] = VoteItem({
            description: "9. Upgrade AccountingOracle implementation",
            call: _forwardCall(
                ADDRESSES.AGENT(),
                ADDRESSES.ACCOUNTING_ORACLE(),
                abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (params.newAccountingOracleImpl))
            )
        });

        // Grant REPORT_REWARDS_MINTED_ROLE to Accounting
        bytes32 reportRewardsMintedRole = IStakingRouter(ADDRESSES.STAKING_ROUTER()).REPORT_REWARDS_MINTED_ROLE();
        voteItems[index++] = VoteItem({
            description: "10. Grant REPORT_REWARDS_MINTED_ROLE to Accounting",
            call: _forwardCall(
                ADDRESSES.AGENT(),
                ADDRESSES.STAKING_ROUTER(),
                abi.encodeCall(IAccessControl.grantRole, (reportRewardsMintedRole, ADDRESSES.ACCOUNTING()))
            )
        });

        // Finish the upgrade process
        voteItems[index++] = VoteItem({
            description: "11. Call UpgradeTemplateV3.finishUpgrade",
            call: _votingCall(address(params.upgradeTemplate), abi.encodeCall(ITemplateV3.finishUpgrade, ()))
        });
    }
}
