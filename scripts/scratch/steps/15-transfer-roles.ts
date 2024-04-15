import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { log } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

async function transferOZAdmin(contractName: string, contractAddress: string, currentAdmin: string, newAdmin: string) {
  log(`Transferring OZ admin of ${contractAddress} from ${currentAdmin} to ${newAdmin}`);
  const contract = await getContractAt(contractName, contractAddress);
  await makeTx(contract, "grantRole", [DEFAULT_ADMIN_ROLE, newAdmin], { from: currentAdmin });
  await makeTx(contract, "renounceRole", [DEFAULT_ADMIN_ROLE, currentAdmin], { from: currentAdmin });
  log.emptyLine();
}

async function changeOssifiableProxyAdmin(contractAddress: string, currentAdmin: string, newAdmin: string) {
  log(`Transferring OssifiableProxy admin of ${contractAddress} from ${currentAdmin} to ${newAdmin}`);
  const proxy = await getContractAt("OssifiableProxy", contractAddress);
  await makeTx(proxy, "proxy__changeAdmin", [newAdmin], { from: currentAdmin });
  log.emptyLine();
}

async function changeDepositSecurityModuleAdmin(contractAddress: string, currentAdmin: string, newAdmin: string) {
  log(`Changing DepositSecurityModule owner of ${contractAddress} from ${currentAdmin} to ${newAdmin}`);
  const depositSecurityModule = await getContractAt("DepositSecurityModule", contractAddress);
  await makeTx(depositSecurityModule, "setOwner", [newAdmin], { from: currentAdmin });
  log.emptyLine();
}

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const agent = state["app:aragon-agent"].proxy.address;

  await transferOZAdmin("Burner", state.burner.address, deployer, agent);
  await transferOZAdmin("HashConsensus", state.hashConsensusForAccountingOracle.address, deployer, agent);
  await transferOZAdmin("HashConsensus", state.hashConsensusForValidatorsExitBusOracle.address, deployer, agent);
  await transferOZAdmin("StakingRouter", state.stakingRouter.proxy.address, deployer, agent);
  await transferOZAdmin("AccountingOracle", state.accountingOracle.proxy.address, deployer, agent);
  await transferOZAdmin("ValidatorsExitBusOracle", state.validatorsExitBusOracle.proxy.address, deployer, agent);
  await transferOZAdmin("WithdrawalQueueERC721", state.withdrawalQueueERC721.proxy.address, deployer, agent);
  await transferOZAdmin("OracleDaemonConfig", state.oracleDaemonConfig.address, deployer, agent);
  await transferOZAdmin("OracleReportSanityChecker", state.oracleReportSanityChecker.address, deployer, agent);

  await changeOssifiableProxyAdmin(state.lidoLocator.proxy.address, deployer, agent);
  await changeOssifiableProxyAdmin(state.stakingRouter.proxy.address, deployer, agent);
  await changeOssifiableProxyAdmin(state.accountingOracle.proxy.address, deployer, agent);
  await changeOssifiableProxyAdmin(state.validatorsExitBusOracle.proxy.address, deployer, agent);
  await changeOssifiableProxyAdmin(state.withdrawalQueueERC721.proxy.address, deployer, agent);

  if (state[Sk.depositSecurityModule].deployParameters.usePredefinedAddressInstead === null) {
    await changeDepositSecurityModuleAdmin(state.depositSecurityModule.address, deployer, agent);
  }

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
