// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {
    VoteItem,
    GeneralConfig,
    CuratedModuleConfig,
    VoteScriptHelpers,
    ICSModuleV3,
    IBurner,
    ITriggerableWithdrawalsGateway,
    IHashConsensusV3,
    IStakingRouter
} from "./StakingRouterV3VoteTypes.sol";

/// @title CuratedModuleSteps
/// @notice Curated module addition vote items (items 41-47), deployed as a separate library.
library CuratedModuleSteps {
    uint256 internal constant COUNT = 7;

    function getItems(
        GeneralConfig memory g,
        CuratedModuleConfig memory c
    ) external view returns (VoteItem[] memory items) {
        items = new VoteItem[](COUNT);

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
            call: VoteScriptHelpers.grantRole(g.burner, IBurner(g.burner).REQUEST_BURN_MY_STETH_ROLE(), c.accounting)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "43. Grant TWG full-withdrawal role to Curated Ejector",
            call: VoteScriptHelpers.grantRole(
                g.triggerableWithdrawalsGateway,
                ITriggerableWithdrawalsGateway(g.triggerableWithdrawalsGateway).ADD_FULL_WITHDRAWAL_REQUEST_ROLE(),
                c.ejector
            )
        });

        items[i++] = VoteScriptHelpers.item({
            description: "44. Grant RESUME_ROLE to agent on Curated module",
            call: VoteScriptHelpers.grantRole(c.module, ICSModuleV3(c.module).RESUME_ROLE(), g.agent)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "45. Resume Curated module",
            to: c.module,
            data: abi.encodeCall(ICSModuleV3.resume, ())
        });

        items[i++] = VoteScriptHelpers.item({
            description: "46. Revoke RESUME_ROLE from agent on Curated module",
            call: VoteScriptHelpers.revokeRole(c.module, ICSModuleV3(c.module).RESUME_ROLE(), g.agent)
        });

        items[i++] = VoteScriptHelpers.item({
            description: "47. Update Curated HashConsensus initial epoch",
            to: c.hashConsensus,
            data: abi.encodeCall(IHashConsensusV3.updateInitialEpoch, (g.hashConsensusInitialEpoch))
        });

        assert(i == COUNT);
    }
}
