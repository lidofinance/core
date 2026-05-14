import { ValidatorsExitBusOracle, WithdrawalQueueERC721 } from "typechain-types";

import {
  ether,
  getAddress,
  impersonate,
  loadContract,
  log,
  readNetworkState,
  RESUME_ROLE,
  Sk,
  withTemporaryRole,
} from "lib";
import { cy } from "lib/log";

// DG's `addSealableWithdrawalBlocker` rejects paused sealables. WQ + VEBO ship
// paused on a fresh deploy (mainnet's WQ has been resumed for years by the time
// DG launched there). Resume both so step 0160 can register them as sealables.
//
// This step is a DG prerequisite; remove from steps.json alongside 0160/0170 if
// DG is not desired for the deployment.
export async function main() {
  const state = readNetworkState();
  const agentAddress = getAddress(Sk.appAgent, state);
  const agent = await impersonate(agentAddress, ether("100"));

  const wq = await loadContract<WithdrawalQueueERC721>(
    "WithdrawalQueueERC721",
    getAddress(Sk.withdrawalQueueERC721, state),
    agent,
  );
  const vebo = await loadContract<ValidatorsExitBusOracle>(
    "ValidatorsExitBusOracle",
    getAddress(Sk.validatorsExitBusOracle, state),
    agent,
  );

  for (const [label, c] of [
    ["WithdrawalQueueERC721", wq],
    ["ValidatorsExitBusOracle", vebo],
  ] as const) {
    if (await c.isPaused()) {
      await withTemporaryRole(c, RESUME_ROLE, agentAddress, async () => {
        await (await c.resume()).wait();
      });
      log(`Resumed sealable ${cy(await c.getAddress())} (${label})`);
    }
  }
}
