import { id } from "ethers";
import { encodeCallScript, type ProposalCall, type VoteItem } from "scripts/utils/omnibus";
import { txWaitAndLog, upgCtx } from "scripts/utils/upgrade";

import { IAccessControl__factory, IForwarder__factory, StakingRouter__factory } from "typechain-types";

import {
  ether,
  findEventsWithInterfaces,
  getAddress,
  getSignerOrImpersonate,
  log,
  logConfirmReview,
  readNetworkState,
  Sk,
  updateObjectInState,
} from "lib";

const PROPOSAL_METADATA = process.env.PROPOSAL_METADATA || "proposal-metadata";

const STAKING_MODULE_SHARE_MANAGE_ROLE = id("STAKING_MODULE_SHARE_MANAGE_ROLE");

const MODULE_ID = 1;
const STAKE_SHARE_LIMIT = 0;
const PRIORITY_EXIT_SHARE_THRESHOLD = 0;

export async function main() {
  const state = readNetworkState();
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await getSignerOrImpersonate(holderAddress, ether("100"));

  const { tm, voting, dg } = await upgCtx(state);
  const agent = getAddress(Sk.appAgent, state);
  const stakingRouterAddress = getAddress(Sk.stakingRouter, state);

  const voteDescription =
    process.env.VOTE_DESCRIPTION ||
    `Set StakingRouter module #${MODULE_ID} shares to ${STAKE_SHARE_LIMIT}/${PRIORITY_EXIT_SHARE_THRESHOLD}`;

  log("Creating new vote:", voteDescription);

  const accessControlIface = IAccessControl__factory.createInterface();
  const stakingRouterIface = StakingRouter__factory.createInterface();

  /// @dev DG proposal items, executed by the Agent via forward
  const dgItems: VoteItem[] = [
    {
      description: "Grant STAKING_MODULE_SHARE_MANAGE_ROLE to the AGENT",
      call: {
        to: stakingRouterAddress,
        data: accessControlIface.encodeFunctionData("grantRole", [STAKING_MODULE_SHARE_MANAGE_ROLE, agent]),
      },
    },
    {
      description: `Set StakingRouter module #${MODULE_ID} stakeShareLimit=${STAKE_SHARE_LIMIT}, priorityExitShareThreshold=${PRIORITY_EXIT_SHARE_THRESHOLD}`,
      call: {
        to: stakingRouterAddress,
        data: stakingRouterIface.encodeFunctionData("updateModuleShares", [
          MODULE_ID,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
        ]),
      },
    },
    {
      description: "Revoke STAKING_MODULE_SHARE_MANAGE_ROLE from the AGENT",
      call: {
        to: stakingRouterAddress,
        data: accessControlIface.encodeFunctionData("revokeRole", [STAKING_MODULE_SHARE_MANAGE_ROLE, agent]),
      },
    },
  ];

  log("DG proposal items:");
  log(dgItems.map(({ description }, idx) => `${idx + 1}. ${description}`));

  /// @dev pack all DG items into a single Agent.forward call (same as UpgradeVoteScript._wrapItemsForwardPacked)
  const agentScript = encodeCallScript(dgItems.map(({ call }) => ({ to: call.to, data: call.data })));
  const proposalCalls: ProposalCall[] = [
    {
      target: agent,
      value: 0n,
      payload: IForwarder__factory.createInterface().encodeFunctionData("forward", [agentScript]),
    },
  ];
  const voteItems: VoteItem[] = [
    {
      description: `Submit a Dual Governance proposal to update StakingRouter module #${MODULE_ID} shares`,
      call: {
        to: dg.address,
        data: dg.interface.encodeFunctionData("submitProposal", [proposalCalls, PROPOSAL_METADATA]),
      },
    },
  ];

  log("items:");
  log(voteItems.map(({ description }) => description));
  const evmScript = encodeCallScript(voteItems.map(({ call }) => ({ to: call.to, data: call.data })));
  const evmScriptNewVote = encodeCallScript([
    {
      to: voting.address,
      data: voting.interface.encodeFunctionData("newVote(bytes,string,bool,bool)", [
        evmScript,
        voteDescription,
        false,
        false,
      ]),
    },
  ]);

  await logConfirmReview();
  log("Forwarding evmScript via TokenManager to create a new vote...");
  const tx = await tm.connect(holder).forward(evmScriptNewVote);
  const receipt = await txWaitAndLog(tx);
  const voteId = findEventsWithInterfaces(receipt, "StartVote", [voting.interface])[0].args.voteId;
  log.success("New vote created. voteId:", voteId);

  // save voteId in deployed state
  updateObjectInState(Sk.upgradeVoteScript, {
    voteState: {
      voteId,
      voteDescription,
    },
  });
  return voteId;
}
