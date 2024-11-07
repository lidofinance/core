import { ethers } from "hardhat";

import { log } from "lib/log";

async function main() {
  log.scriptStart(__filename);

  // 0x01 is too little, 0x80 works, although less might be enough
  await ethers.provider.send("hardhat_mine", ["0x80"]);
  log.success(`Sent "hardhat_mine"`);

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
