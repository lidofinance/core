import { ethers } from "hardhat";

import {
  Burner,
  LazyOracle,
  OperatorGrid,
  StakingRouter,
  TriggerableWithdrawalsGateway,
  ValidatorsExitBusOracle,
  VaultHub,
  WithdrawalQueueERC721,
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
  const burnerAddress = state[Sk.burner].proxy.address;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;
  const withdrawalQueueAddress = state[Sk.withdrawalQueueERC721].proxy.address;
  const accountingOracleAddress = state[Sk.accountingOracle].proxy.address;
  const accountingAddress = state[Sk.accounting].proxy.address;
  const validatorsExitBusOracleAddress = state[Sk.validatorsExitBusOracle].proxy.address;
  const depositSecurityModuleAddress = state[Sk.depositSecurityModule].address;
  const vaultHubAddress = state[Sk.vaultHub].proxy.address;
  const operatorGridAddress = state[Sk.operatorGrid].proxy.address;
  const triggerableWithdrawalsGatewayAddress = state[Sk.triggerableWithdrawalsGateway].address;
  const lazyOracleAddress = state[Sk.lazyOracle].proxy.address;
  const validatorExitDelayVerifierAddress = state[Sk.validatorExitDelayVerifier].address;

  // StakingRouter
  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.STAKING_MODULE_UNVETTING_ROLE(), depositSecurityModuleAddress],
    { from: deployer },
  );
  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE(), accountingOracleAddress],
    { from: deployer },
  );
  await makeTx(stakingRouter, "grantRole", [await stakingRouter.REPORT_REWARDS_MINTED_ROLE(), lidoAddress], {
    from: deployer,
  });
  await makeTx(stakingRouter, "grantRole", [await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), agentAddress], {
    from: deployer,
  });
  await makeTx(stakingRouter, "grantRole", [await stakingRouter.REPORT_REWARDS_MINTED_ROLE(), accountingAddress], {
    from: deployer,
  });
  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE(), triggerableWithdrawalsGatewayAddress],
    { from: deployer },
  );

  await makeTx(
    stakingRouter,
    "grantRole",
    [await stakingRouter.REPORT_VALIDATOR_EXITING_STATUS_ROLE(), validatorExitDelayVerifierAddress],
    { from: deployer },
  );

  // ValidatorsExitBusOracle
  if (gateSealAddress) {
    const validatorsExitBusOracle = await loadContract<ValidatorsExitBusOracle>(
      "ValidatorsExitBusOracle",
      validatorsExitBusOracleAddress,
    );
    await makeTx(validatorsExitBusOracle, "grantRole", [await validatorsExitBusOracle.PAUSE_ROLE(), gateSealAddress], {
      from: deployer,
    });
  } else {
    log(`GateSeal is not specified or deployed: skipping assigning PAUSE_ROLE of validatorsExitBusOracle`);
    log.emptyLine();
  }

  // TriggerableWithdrawalsGateway
  const triggerableWithdrawalsGateway = await loadContract<TriggerableWithdrawalsGateway>(
    "TriggerableWithdrawalsGateway",
    triggerableWithdrawalsGatewayAddress,
  );
  await makeTx(
    triggerableWithdrawalsGateway,
    "grantRole",
    [await triggerableWithdrawalsGateway.ADD_FULL_WITHDRAWAL_REQUEST_ROLE(), validatorsExitBusOracleAddress],
    { from: deployer },
  );

  // WithdrawalQueue
  const withdrawalQueue = await loadContract<WithdrawalQueueERC721>("WithdrawalQueueERC721", withdrawalQueueAddress);
  if (gateSealAddress) {
    await makeTx(withdrawalQueue, "grantRole", [await withdrawalQueue.PAUSE_ROLE(), gateSealAddress], {
      from: deployer,
    });
  } else {
    log(`GateSeal is not specified or deployed: skipping assigning PAUSE_ROLE of withdrawalQueue`);
    log.emptyLine();
  }

  await makeTx(withdrawalQueue, "grantRole", [await withdrawalQueue.FINALIZE_ROLE(), lidoAddress], {
    from: deployer,
  });

  await makeTx(withdrawalQueue, "grantRole", [await withdrawalQueue.ORACLE_ROLE(), accountingOracleAddress], {
    from: deployer,
  });

  // Burner
  const burner = await loadContract<Burner>("Burner", burnerAddress);
  const requestBurnSharesRole = await burner.REQUEST_BURN_SHARES_ROLE();
  // NB: REQUEST_BURN_SHARES_ROLE is already granted to Lido in Burner constructor
  // TODO: upon TW upgrade NOR dont need the role anymore
  await makeTx(burner, "grantRole", [requestBurnSharesRole, nodeOperatorsRegistryAddress], {
    from: deployer,
  });
  await makeTx(burner, "grantRole", [requestBurnSharesRole, simpleDvtApp], {
    from: deployer,
  });
  await makeTx(burner, "grantRole", [requestBurnSharesRole, accountingAddress], {
    from: deployer,
  });

  // VaultHub
  const vaultHub = await loadContract<VaultHub>("VaultHub", vaultHubAddress);
  await makeTx(vaultHub, "grantRole", [await vaultHub.VAULT_MASTER_ROLE(), agentAddress], {
    from: deployer,
  });
  await makeTx(vaultHub, "grantRole", [await vaultHub.REDEMPTION_MASTER_ROLE(), agentAddress], {
    from: deployer,
  });
  await makeTx(vaultHub, "grantRole", [await vaultHub.VALIDATOR_EXIT_ROLE(), agentAddress], {
    from: deployer,
  });

  // OperatorGrid
  const operatorGrid = await loadContract<OperatorGrid>("OperatorGrid", operatorGridAddress);
  await makeTx(operatorGrid, "grantRole", [await operatorGrid.REGISTRY_ROLE(), agentAddress], {
    from: deployer,
  });

  // LazyOracle
  const lazyOracle = await loadContract<LazyOracle>("LazyOracle", lazyOracleAddress);
  const updateSanityParamsRole = await lazyOracle.UPDATE_SANITY_PARAMS_ROLE();
  await makeTx(lazyOracle, "grantRole", [updateSanityParamsRole, agentAddress], { from: deployer });
}
