import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const agent = state["app:aragon-agent"].proxy.address;

  // Transfer OZ admin roles for various contracts
  const ozAdminTransfers = [
    { name: "Burner", address: state.burner.address },
    { name: "HashConsensus", address: state.hashConsensusForAccountingOracle.address },
    { name: "HashConsensus", address: state.hashConsensusForValidatorsExitBusOracle.address },
    { name: "StakingRouter", address: state.stakingRouter.proxy.address },
    { name: "AccountingOracle", address: state.accountingOracle.proxy.address },
    { name: "ValidatorsExitBusOracle", address: state.validatorsExitBusOracle.proxy.address },
    { name: "WithdrawalQueueERC721", address: state.withdrawalQueueERC721.proxy.address },
    { name: "OracleDaemonConfig", address: state.oracleDaemonConfig.address },
    { name: "OracleReportSanityChecker", address: state.oracleReportSanityChecker.address },
  ];

  for (const contract of ozAdminTransfers) {
    const contractInstance = await getContractAt(contract.name, contract.address);
    await makeTx(contractInstance, "grantRole", [DEFAULT_ADMIN_ROLE, agent], { from: deployer });
    await makeTx(contractInstance, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });
  }

  // Change admin for OssifiableProxy contracts
  const ossifiableProxyAdminChanges = [
    state.lidoLocator.proxy.address,
    state.stakingRouter.proxy.address,
    state.accountingOracle.proxy.address,
    state.validatorsExitBusOracle.proxy.address,
    state.withdrawalQueueERC721.proxy.address,
  ];

  for (const proxyAddress of ossifiableProxyAdminChanges) {
    const proxy = await getContractAt("OssifiableProxy", proxyAddress);
    await makeTx(proxy, "proxy__changeAdmin", [agent], { from: deployer });
  }

  // Change DepositSecurityModule admin if not using predefined address
  if (state[Sk.depositSecurityModule].deployParameters.usePredefinedAddressInstead === null) {
    const depositSecurityModule = await getContractAt("DepositSecurityModule", state.depositSecurityModule.address);
    await makeTx(depositSecurityModule, "setOwner", [agent], { from: deployer });
  }
}
