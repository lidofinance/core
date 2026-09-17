import { ethers } from "hardhat";

import { advanceChainTime, log } from "lib";

async function main() {
  log.scriptStart(__filename);

  await advanceChainTime(10n);
  log.success(`Sent "advanceChainTime +10s"`);

  // Both are needed, for different consumers of the freshly deployed node:
  // - advanceChainTime above nudges the clock so the last deploy txs settle.
  // - the 128 spare blocks below are for MODE=forking consumers
  //   (dao-local-deploy.sh / dao-sepolia-fork-deploy.sh): EDR forks an external
  //   node at `latest - 128`, so without this margin the in-process fork lands
  //   mid-deploy and never sees the final steps (role transfers, DG wiring).
  //   0x01 is too little, 0x80 works, although less might be enough.
  await ethers.provider.send("hardhat_mine", ["0x80"]);
  log.success(`Sent "hardhat_mine" 0x80`);

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
