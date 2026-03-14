// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {
    IUpgradeConfig,
    GeneralConfig,
    CuratedModuleConfig,
    ICSModuleV3,
    ITriggerableWithdrawalsGateway,
    IHashConsensusV3,
    IStakingRouter
} from "../UpgradeTypes.sol";

import {OmnibusBase} from "../utils/OmnibusBase.sol";
import {VoteScriptHelpers} from "../utils/VoteScriptHelpers.sol";

/// @title CuratedModuleItems
/// @notice Curated module addition vote items (items 41-47), deployed as a separate library.
library CuratedModuleItems {
    uint256 internal constant COUNT = 7;

    bytes32 internal constant REQUEST_BURN_MY_STETH_ROLE = keccak256("REQUEST_BURN_MY_STETH_ROLE");
    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");

    function getItems(IUpgradeConfig template) external view returns (OmnibusBase.VoteItem[] memory items) {
        GeneralConfig memory g = template.getGeneralConfig();
        CuratedModuleConfig memory c = template.getCuratedModuleConfig();

        items = new OmnibusBase.VoteItem[](COUNT);

        uint256 i = 0;

        items[i++] = VoteScriptHelpers.item({
            description: "41. Add Curated module to StakingRouter",
            to: g.stakingRouter,
            data: abi.encodeCall(
                IStakingRouter.addStakingModule,
                (
                    c.moduleName,
                    c.module,
                    c.stakeShareLimit,
                    c.priorityExitShareThreshold,
                    c.stakingModuleFee,
                    c.treasuryFee,
                    c.maxDepositsPerBlock,
                    c.minDepositBlockDistance
                )
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "42. Grant REQUEST_BURN_MY_STETH_ROLE to Curated Accounting",
            call: VoteScriptHelpers.grantRole(g.burner, REQUEST_BURN_MY_STETH_ROLE, c.accounting)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "43. Grant TWG full-withdrawal role to Curated Ejector",
            call: VoteScriptHelpers.grantRole(g.triggerableWithdrawalsGateway, REQUEST_BURN_MY_STETH_ROLE, c.ejector)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "44. Grant RESUME_ROLE to agent on Curated module",
            call: VoteScriptHelpers.grantRole(c.module, RESUME_ROLE, g.agent)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "45. Resume Curated module", to: c.module, data: abi.encodeCall(ICSModuleV3.resume, ())
        });

        items[i++] = VoteScriptHelpers.item({
            description: "46. Revoke RESUME_ROLE from agent on Curated module",
            call: VoteScriptHelpers.revokeRole(c.module, RESUME_ROLE, g.agent)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "47. Update Curated HashConsensus initial epoch",
            to: c.hashConsensus,
            data: abi.encodeCall(IHashConsensusV3.updateInitialEpoch, (c.hashConsensusInitialEpoch))
        });

        assert(i == COUNT);
    }
}
