import { encodeCallScript, type ProposalCall, type VoteItem } from "scripts/utils/omnibus";
import { txWaitAndLog, upgCtx } from "scripts/utils/upgrade";

import {
  IForwarder__factory,
  IWithdrawalsManagerProxy__factory,
  // IWithdrawalVaultUpgrade__factory,
} from "typechain-types";

import { ether, findEventsWithInterfaces, getAddress, getSignerOrImpersonate, log, readNetworkState, Sk } from "lib";

const PROPOSAL_METADATA = process.env.PROPOSAL_METADATA || "proposal-metadata";

export async function main() {
  const state = readNetworkState();
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await getSignerOrImpersonate(holderAddress, ether("100"));

  const { tm, voting, dg } = await upgCtx(state);
  const agent = getAddress(Sk.appAgent, state);
  const withdrawalVault = getAddress(Sk.withdrawalVault, state);
  const wvImplAddress = state[Sk.withdrawalVault].implementation.address;

  const voteDescription = process.env.VOTE_DESCRIPTION || `Upgrade Withdrawal Vault to ${wvImplAddress}`;

  log("Creating new vote:", voteDescription);

  // const finalizeUpgradeCalldata =
  //   IWithdrawalVaultUpgrade__factory.createInterface().encodeFunctionData("finalizeUpgrade_v3");
  const finalizeUpgradeCalldata = "0x";
  const upgradeWithdrawalVaultCalldata = IWithdrawalsManagerProxy__factory.createInterface().encodeFunctionData(
    "proxy_upgradeTo",
    [wvImplAddress, finalizeUpgradeCalldata],
  );
  const upgradeWithdrawalVaultScript = encodeCallScript([
    {
      to: withdrawalVault,
      data: upgradeWithdrawalVaultCalldata,
    },
  ]);
  const proposalCalls: ProposalCall[] = [
    {
      target: agent,
      value: 0n,
      payload: IForwarder__factory.createInterface().encodeFunctionData("forward", [upgradeWithdrawalVaultScript]),
    },
  ];
  const voteItems: VoteItem[] = [
    {
      description: "Submit a Dual Governance proposal to upgrade WithdrawalVault implementation",
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

  log("Forwarding evmScript via TokenManager to create a new vote...");
  const tx = await tm.connect(holder).forward(evmScriptNewVote);
  const receipt = await txWaitAndLog(tx);
  const voteId = findEventsWithInterfaces(receipt, "StartVote", [voting.interface])[0].args.voteId;
  log.success("New vote created. voteId:", voteId);
  return voteId;
}
