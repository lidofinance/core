import { encodeCallScript, type ProposalCall, type VoteItem } from "scripts/utils/omnibus";
import { txWaitAndLog, upgCtx } from "scripts/utils/upgrade";

import { IForwarder__factory, IOssifiableProxy__factory } from "typechain-types";

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

export async function main() {
  const state = readNetworkState();
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await getSignerOrImpersonate(holderAddress, ether("100"));

  const { tm, voting, dg } = await upgCtx(state);
  const agent = getAddress(Sk.appAgent, state);

  const stakingRouterAddress = getAddress(Sk.stakingRouter, state);
  const newStakingRouterImpl = state[Sk.stakingRouter]?.implementation?.address;
  if (!newStakingRouterImpl) {
    throw new Error("New StakingRouter implementation address is missing in the state file");
  }

  const voteDescription = process.env.VOTE_DESCRIPTION || "SRv3/CMv2 hoodi StakingRouter fix (update4)";

  log("Creating new vote:", voteDescription);

  const proxyIface = IOssifiableProxy__factory.createInterface();

  /// @dev DG proposal items, executed by the Agent via forward
  const dgItems: VoteItem[] = [
    {
      description: "Upgrade StakingRouter implementation",
      call: {
        to: stakingRouterAddress,
        data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newStakingRouterImpl]),
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
      description: "Submit a Dual Governance proposal to upgrade StakingRouter implementation (update4)",
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

  updateObjectInState(Sk.upgradeVoteScript, {
    voteState: {
      voteId,
      voteDescription,
    },
  });
  return voteId;
}
