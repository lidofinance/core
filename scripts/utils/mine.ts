import { advanceChainTime, log } from "lib";

async function main() {
  log.scriptStart(__filename);

  // // 0x01 is too little, 0x80 works, although less might be enough
  // await ethers.provider.send("hardhat_mine", ["0x80"]);
  await advanceChainTime(10n);
  log.success(`Sent "advanceChainTime +10s"`);

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
