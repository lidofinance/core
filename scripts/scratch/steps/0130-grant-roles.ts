import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import {
  Burner,
  StakingRouter,
  ValidatorsExitBusOracle,
  WithdrawalQueueERC721,
  WithdrawalVault,
} from "typechain-types";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { log } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const lidoAddress = state[Sk.appLido].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const simpleDvtApp = state[Sk.appSimpleDvt].proxy.address;
  const gateSealAddress = state.gateSeal.address;
  const burnerAddress = state[Sk.burner].address;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;
  const withdrawalQueueAddress = state[Sk.withdrawalQueueERC721].proxy.address;
  const withdrawalVaultAddress = state[Sk.withdrawalVault].proxy.address;
  const accountingOracleAddress = state[Sk.accountingOracle].proxy.address;
  const validatorsExitBusOracleAddress = state[Sk.validatorsExitBusOracle].proxy.address;
  const depositSecurityModuleAddress = state[Sk.depositSecurityModule].address;

  const waitTransactionsGroup: Promise<ContractTransactionReceipt>[] = [];

  // StakingRouter
  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  waitTransactionsGroup.push(
    makeTx(
      stakingRouter,
      "grantRole",
      [await stakingRouter.STAKING_MODULE_UNVETTING_ROLE(), depositSecurityModuleAddress],
      { from: deployer },
    ),
  );
  waitTransactionsGroup.push(
    makeTx(stakingRouter, "grantRole", [await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE(), accountingOracleAddress], {
      from: deployer,
    }),
  );
  waitTransactionsGroup.push(
    makeTx(stakingRouter, "grantRole", [await stakingRouter.REPORT_REWARDS_MINTED_ROLE(), lidoAddress], {
      from: deployer,
    }),
  );
  waitTransactionsGroup.push(
    makeTx(stakingRouter, "grantRole", [await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), agentAddress], {
      from: deployer,
    }),
  );

  // ValidatorsExitBusOracle
  if (gateSealAddress) {
    const validatorsExitBusOracle = await loadContract<ValidatorsExitBusOracle>(
      "ValidatorsExitBusOracle",
      validatorsExitBusOracleAddress,
    );
    waitTransactionsGroup.push(
      makeTx(validatorsExitBusOracle, "grantRole", [await validatorsExitBusOracle.PAUSE_ROLE(), gateSealAddress], {
        from: deployer,
      }),
    );
  } else {
    log(`GateSeal is not specified or deployed: skipping assigning PAUSE_ROLE of validatorsExitBusOracle`);
    log.emptyLine();
  }

  // WithdrawalQueue
  const withdrawalQueue = await loadContract<WithdrawalQueueERC721>("WithdrawalQueueERC721", withdrawalQueueAddress);
  if (gateSealAddress) {
    waitTransactionsGroup.push(
      makeTx(withdrawalQueue, "grantRole", [await withdrawalQueue.PAUSE_ROLE(), gateSealAddress], {
        from: deployer,
      }),
    );
  } else {
    log(`GateSeal is not specified or deployed: skipping assigning PAUSE_ROLE of withdrawalQueue`);
    log.emptyLine();
  }

  waitTransactionsGroup.push(
    makeTx(withdrawalQueue, "grantRole", [await withdrawalQueue.FINALIZE_ROLE(), lidoAddress], {
      from: deployer,
    }),
  );

  waitTransactionsGroup.push(
    makeTx(withdrawalQueue, "grantRole", [await withdrawalQueue.ORACLE_ROLE(), accountingOracleAddress], {
      from: deployer,
    }),
  );

  // WithdrawalVault
  const withdrawalVault = await loadContract<WithdrawalVault>("WithdrawalVault", withdrawalVaultAddress);

  await makeTx(
    withdrawalVault,
    "grantRole",
    [await withdrawalVault.ADD_FULL_WITHDRAWAL_REQUEST_ROLE(), validatorsExitBusOracleAddress],
    {
      from: deployer,
    },
  );

  // Burner
  const burner = await loadContract<Burner>("Burner", burnerAddress);
  // NB: REQUEST_BURN_SHARES_ROLE is already granted to Lido in Burner constructor
  waitTransactionsGroup.push(
    makeTx(burner, "grantRole", [await burner.REQUEST_BURN_SHARES_ROLE(), nodeOperatorsRegistryAddress], {
      from: deployer,
    }),
  );
  waitTransactionsGroup.push(
    makeTx(burner, "grantRole", [await burner.REQUEST_BURN_SHARES_ROLE(), simpleDvtApp], {
      from: deployer,
    }),
  );

  await Promise.all(waitTransactionsGroup);
}
