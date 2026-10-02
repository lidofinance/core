import { ethers } from "hardhat";

import { getDeployerSigner, impersonate } from "lib/account";
import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { getNetworkName } from "lib/network";
import { DeploymentState, incrementGasUsed, Sk } from "lib/state-file";
import { ether } from "lib/units";

export type AgentCall = { to: string; data: string };

function callsScript(calls: AgentCall[]): string {
  return ethers.concat([
    "0x00000001",
    ...calls.flatMap(({ to, data }) => [to, ethers.toBeHex(ethers.dataLength(data), 4), data]),
  ]);
}

/** Local EVM fixtures use Agent impersonation; real clients execute the same calls through voting. */
export async function executeScratchAgentCalls(calls: AgentCall[], state: DeploymentState) {
  if (!calls.length) return;
  const clientVersion: string = await ethers.provider.send("web3_clientVersion", []);
  if (!/^(HardhatNetwork|anvil)\//i.test(clientVersion)) {
    await executeScratchVote(calls, state);
    return;
  }

  const agent = state[Sk.appAgent].proxy.address;
  const signer = await impersonate(agent, ether("1"));
  try {
    for (const call of calls) {
      const receipt = await (await signer.sendTransaction(call)).wait();
      if (!receipt || receipt.status !== 1) throw new Error(`Scratch Agent call failed: ${call.to}`);
      incrementGasUsed(receipt.gasUsed);
    }
  } finally {
    await ethers.provider.send(`${await getNetworkName()}_stopImpersonatingAccount`, [agent]);
  }
}

/** Execute setup using ordinary token-holder transactions and the DAO's existing permissions. */
export async function executeScratchVote(calls: AgentCall[], state: DeploymentState) {
  if (!calls.length) return;
  const signer = await getDeployerSigner();
  const voting = await loadContract("Voting", state[Sk.appVoting].proxy.address);
  const tokenManager = await loadContract("TokenManager", state[Sk.appTokenManager].proxy.address);
  const token = new ethers.Contract(
    state[Sk.ldo].address,
    ["function balanceOf(address) view returns (uint256)"],
    signer,
  );
  if ((await token.balanceOf(signer.address)) === 0n) {
    throw new Error(
      "Scratch governance requires a configured signer holding LDO; set local vesting holders accordingly",
    );
  }
  const agentInterface = new ethers.Interface(["function execute(address,uint256,bytes)"]);
  const executionScript = callsScript(
    calls.map(({ to, data }) => ({
      to: state[Sk.appAgent].proxy.address,
      data: agentInterface.encodeFunctionData("execute", [to, 0n, data]),
    })),
  );
  const receipt = await makeTx(
    tokenManager,
    "forward",
    [
      callsScript([
        {
          to: voting.address,
          data: voting.interface.encodeFunctionData("newVote(bytes,string)", [
            executionScript,
            "Scratch module activation",
          ]),
        },
      ]),
    ],
    { from: signer.address },
  );
  const event = receipt.logs.flatMap((entry) => {
    if (entry.address.toLowerCase() !== voting.address.toLowerCase()) return [];
    try {
      const parsed = voting.interface.parseLog(entry);
      return parsed?.name === "StartVote" ? [parsed] : [];
    } catch {
      return [];
    }
  })[0];
  if (!event) throw new Error("Scratch governance vote creation emitted no StartVote");
  const voteId = event.args.voteId;
  await makeTx(voting, "vote", [voteId, true, false], { from: signer.address });
  const vote = await voting.getFunction("getVote")(voteId);
  const executableAt = Number(vote.startDate + (await voting.getFunction("voteTime")()));
  // A controlled-chain runner may advance genuine protocol time upon this event. On ordinary
  // networks this waits for blocks naturally; no evm_* or impersonation RPC is used.
  console.log(JSON.stringify({ event: "scratch-vote-wait", voteId: voteId.toString(), executableAt }));
  const deadline = Date.now() + 20 * 60_000;
  while (!(await voting.getFunction("canExecute")(voteId))) {
    if (Date.now() >= deadline) throw new Error(`Scratch governance vote ${voteId} did not become executable`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await makeTx(voting, "executeVote", [voteId], { from: signer.address });
  if (!(await voting.getFunction("getVote")(voteId)).executed) throw new Error("Scratch vote was not executed");
}
