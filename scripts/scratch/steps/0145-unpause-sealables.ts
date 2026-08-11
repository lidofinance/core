import { ethers } from "hardhat";

import { ValidatorsExitBusOracle, WithdrawalQueueERC721 } from "typechain-types";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { cy, log } from "lib/log";
import { isDGDeploymentEnabled, isProtocolActivationEnabled } from "lib/scratch";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

// DG's `addSealableWithdrawalBlocker` rejects paused sealables, so WQ + VEBO
// must be resumed before step 0160 registers them. Runs before 0150 so the
// deployer still holds DEFAULT_ADMIN_ROLE on both — no impersonation, works
// on a live network. Also resumes them when protocol activation is enabled
// (an operational deploy without DG). No-op otherwise (matches historical
// pre-DG scratch state where WQ stays paused).
export async function main() {
  if (!isDGDeploymentEnabled() && !isProtocolActivationEnabled()) {
    log("DG deployment and protocol activation disabled — leaving sealables paused");
    return;
  }

  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const wq = await loadContract<WithdrawalQueueERC721>(
    "WithdrawalQueueERC721",
    getAddress(Sk.withdrawalQueueERC721, state),
  );
  const vebo = await loadContract<ValidatorsExitBusOracle>(
    "ValidatorsExitBusOracle",
    getAddress(Sk.validatorsExitBusOracle, state),
  );

  for (const [label, c] of [
    ["WithdrawalQueueERC721", wq],
    ["ValidatorsExitBusOracle", vebo],
  ] as const) {
    const resumeRole = await c.RESUME_ROLE();
    if (!(await c.isPaused())) {
      // A previous run may have died between resume() and renounceRole() —
      // don't let the deployer keep RESUME_ROLE just because the unpause is done.
      if (await c.hasRole(resumeRole, deployer)) {
        log(`Sealable ${cy(await c.getAddress())} (${label}) is not paused, renouncing leftover RESUME_ROLE`);
        await makeTx(c, "renounceRole", [resumeRole, deployer], { from: deployer });
      } else {
        log(`Sealable ${cy(await c.getAddress())} (${label}) is not paused, skipping`);
      }
      continue;
    }
    await makeTx(c, "grantRole", [resumeRole, deployer], { from: deployer });
    await makeTx(c, "resume", [], { from: deployer });
    await makeTx(c, "renounceRole", [resumeRole, deployer], { from: deployer });
    log(`Resumed sealable ${cy(await c.getAddress())} (${label})`);
  }
}
