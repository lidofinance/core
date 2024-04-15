import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { log, logWideSplitter } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const lidoAddress = state[Sk.appLido].proxy.address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const gateSealAddress = state.gateSeal.address;

  const burnerAddress = state[Sk.burner].address;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;
  const withdrawalQueueAddress = state[Sk.withdrawalQueueERC721].proxy.address;
  const accountingOracleAddress = state[Sk.accountingOracle].proxy.address;
  const validatorsExitBusOracleAddress = state[Sk.validatorsExitBusOracle].proxy.address;
  const depositSecurityModuleAddress = state[Sk.depositSecurityModule].address;

  //
  // === StakingRouter
  //
  const stakingRouter = await getContractAt("StakingRouter", stakingRouterAddress);
  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.getFunction("STAKING_MODULE_PAUSE_ROLE")(), depositSecurityModuleAddress],
    { from: deployer },
  );
  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.getFunction("STAKING_MODULE_RESUME_ROLE")(), depositSecurityModuleAddress],
    { from: deployer },
  );
  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.getFunction("REPORT_EXITED_VALIDATORS_ROLE")(), accountingOracleAddress],
    { from: deployer },
  );
  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.getFunction("REPORT_REWARDS_MINTED_ROLE")(), lidoAddress],
    { from: deployer },
  );
  logWideSplitter();

  //
  // === ValidatorsExitBusOracle
  //
  if (gateSealAddress) {
    const validatorsExitBusOracle = await getContractAt("ValidatorsExitBusOracle", validatorsExitBusOracleAddress);
    await makeTx(
      validatorsExitBusOracle,
      "grantRole",
      [await validatorsExitBusOracle.getFunction("PAUSE_ROLE")(), gateSealAddress],
      { from: deployer },
    );
    logWideSplitter();
  } else {
    log(`GateSeal is not specified or deployed: skipping assigning PAUSE_ROLE of validatorsExitBusOracle`);
  }

  //
  // === WithdrawalQueue
  //
  const withdrawalQueue = await getContractAt("WithdrawalQueueERC721", withdrawalQueueAddress);
  if (gateSealAddress) {
    await makeTx(withdrawalQueue, "grantRole", [await withdrawalQueue.getFunction("PAUSE_ROLE")(), gateSealAddress], {
      from: deployer,
    });
  } else {
    log(`GateSeal is not specified or deployed: skipping assigning PAUSE_ROLE of withdrawalQueue`);
  }
  await makeTx(withdrawalQueue, "grantRole", [await withdrawalQueue.getFunction("FINALIZE_ROLE")(), lidoAddress], {
    from: deployer,
  });
  await makeTx(
    withdrawalQueue,
    "grantRole",
    [await withdrawalQueue.getFunction("ORACLE_ROLE")(), accountingOracleAddress],
    { from: deployer },
  );
  logWideSplitter();

  //
  // === Burner
  //
  const burner = await getContractAt("Burner", burnerAddress);
  // NB: REQUEST_BURN_SHARES_ROLE is already granted to Lido in Burner constructor
  await makeTx(
    burner,
    "grantRole",
    [await burner.getFunction("REQUEST_BURN_SHARES_ROLE")(), nodeOperatorsRegistryAddress],
    { from: deployer },
  );

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
