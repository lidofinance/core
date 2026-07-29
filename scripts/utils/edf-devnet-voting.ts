import { ethers } from "hardhat";
import { buildEDFDevnetExecutionScript, buildEDFDevnetNewVoteScript } from "scripts/utils/edf-devnet";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { EDFUpgradeVoteScript, TokenManager, Voting } from "typechain-types";

import { DeploymentState, findEventsWithInterfaces, getAddress, loadContract, log, Sk, updateObjectInState } from "lib";

export function updateEDFDevnetVoteState(state: DeploymentState, supplement: Record<string, string | number>): void {
  updateObjectInState(Sk.upgradeVoteScript, {
    voteState: {
      ...state[Sk.upgradeVoteScript]?.voteState,
      ...supplement,
    },
  });
}

export async function createEDFDevnetVote(
  state: DeploymentState,
  signer: HardhatEthersSigner,
  voteDescription: string,
): Promise<bigint> {
  const existingVoteId = state[Sk.upgradeVoteScript]?.voteState?.voteId;
  const [tokenManager, voting, voteScript] = await Promise.all([
    loadContract<TokenManager>("TokenManager", getAddress(Sk.appTokenManager, state), signer),
    loadContract<Voting>("Voting", getAddress(Sk.appVoting, state), signer),
    loadContract<EDFUpgradeVoteScript>("EDFUpgradeVoteScript", getAddress(Sk.upgradeVoteScript, state), signer),
  ]);

  const voteItems = await voteScript.getVoteItems();
  const executionScript = buildEDFDevnetExecutionScript(voteItems);
  if (existingVoteId !== undefined) {
    const voteId = BigInt(existingVoteId);
    const vote = await voting.getVote(voteId);
    if (!vote.startDate) throw new Error(`Recorded Aragon vote ${voteId} does not exist`);
    if (ethers.keccak256(vote.script) !== ethers.keccak256(executionScript)) {
      throw new Error(`Recorded Aragon vote ${voteId} does not contain the expected direct EDF devnet script`);
    }
    log.success(`Using recorded direct EDF devnet vote ${voteId}`);
    return voteId;
  }

  const newVoteCalldata = voting.interface.encodeFunctionData("newVote(bytes,string,bool,bool)", [
    executionScript,
    voteDescription,
    false,
    false,
  ]);
  const tokenManagerScript = buildEDFDevnetNewVoteScript(voting.address, newVoteCalldata);
  const tx = await tokenManager.connect(signer).forward(tokenManagerScript);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`Vote creation transaction ${tx.hash} has no receipt`);

  const events = findEventsWithInterfaces(receipt, "StartVote", [voting.interface]);
  if (events.length !== 1) throw new Error(`Expected one StartVote event, got ${events.length}`);

  const voteId = BigInt(events[0].args.voteId);
  const vote = await voting.getVote(voteId);
  if (ethers.keccak256(vote.script) !== ethers.keccak256(executionScript)) {
    throw new Error(`Aragon vote ${voteId} does not contain the expected direct EDF devnet script`);
  }

  updateEDFDevnetVoteState(state, {
    voteId: voteId.toString(),
    voteDescription,
    mode: "direct-aragon",
    creationTx: receipt.hash,
    creationBlock: receipt.blockNumber,
  });

  log.success(`Created direct EDF devnet vote ${voteId}`);
  log.success(`Vote creation transaction: ${receipt.hash}`);
  return voteId;
}
