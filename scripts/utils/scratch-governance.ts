import { ethers } from "hardhat";

import { getDeployerSigner, impersonate } from "lib/account";
import { DaoCall, DaoDecision, DaoRunner, executeDaoDecision } from "lib/dao";
import { getNetworkName } from "lib/network";
import { DeploymentState, incrementGasUsed, Sk } from "lib/state-file";
import { ether } from "lib/units";

export type { DaoCall };

/**
 * One DAO decision during scratch deployment. Local EVM fixtures impersonate the Agent and the
 * DAO's voting; real clients run the decision as the DAO governs the Agent, see `executeDaoDecision`.
 */
export async function executeScratchDecision(decision: DaoDecision, state: DeploymentState) {
  const clientVersion: string = await ethers.provider.send("web3_clientVersion", []);
  if (!/^(HardhatNetwork|anvil)\//i.test(clientVersion)) {
    await executeDaoDecision(decision, state, await scratchRunner(state));
    return;
  }

  await impersonated(state[Sk.appVoting].proxy.address, decision.voting ?? []);
  await impersonated(state[Sk.appAgent].proxy.address, decision.agent ?? []);
}

async function impersonated(sender: string, calls: DaoCall[]) {
  if (!calls.length) return;
  const signer = await impersonate(sender, ether("1"));
  try {
    for (const call of calls) {
      const receipt = await (await signer.sendTransaction(call)).wait();
      if (!receipt || receipt.status !== 1) throw new Error(`Scratch call failed: ${call.to}`);
      incrementGasUsed(receipt.gasUsed);
    }
  } finally {
    await ethers.provider.send(`${await getNetworkName()}_stopImpersonatingAccount`, [sender]);
  }
}

/** Ordinary token-holder transactions on a real client, with no evm_* or impersonation RPC. */
async function scratchRunner(state: DeploymentState): Promise<DaoRunner> {
  const signer = await getDeployerSigner();
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
  return {
    signer,
    async send(tx) {
      const receipt = await (await tx).wait();
      if (!receipt || receipt.status !== 1) throw new Error("Scratch governance transaction failed");
      incrementGasUsed(receipt.gasUsed);
      return receipt;
    },
    async waitUntil(time, ready) {
      // A controlled-chain runner may advance genuine protocol time upon this event. On ordinary
      // networks this waits for blocks naturally.
      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      if (time > now) console.log(JSON.stringify({ event: "scratch-vote-wait", executableAt: Number(time) }));
      const deadline = Date.now() + 20 * 60_000;
      while (!(await ready())) {
        if (Date.now() >= deadline) throw new Error(`Scratch governance did not reach time ${time}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
  };
}
