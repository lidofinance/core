import { ethers } from "hardhat";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const agent = state["app:aragon-agent"].proxy.address;

  // Transfer OZ admin roles for various contracts
  const ozAdminTransfers = [
    { name: "Burner", address: state[Sk.burner].address },
    { name: "HashConsensus", address: state[Sk.hashConsensusForAccountingOracle].address },
    { name: "HashConsensus", address: state[Sk.hashConsensusForValidatorsExitBusOracle].address },
    { name: "StakingRouter", address: state[Sk.stakingRouter].proxy.address },
    { name: "AccountingOracle", address: state[Sk.accountingOracle].proxy.address },
    { name: "ValidatorsExitBusOracle", address: state[Sk.validatorsExitBusOracle].proxy.address },
    { name: "WithdrawalQueueERC721", address: state[Sk.withdrawalQueueERC721].proxy.address },
    { name: "OracleDaemonConfig", address: state[Sk.oracleDaemonConfig].address },
    { name: "OracleReportSanityChecker", address: state[Sk.oracleReportSanityChecker].address },
    { name: "VaultHub", address: state[Sk.vaultHub].proxy.address },
    { name: "PredepositGuarantee", address: state[Sk.predepositGuarantee].proxy.address },
    { name: "OperatorGrid", address: state[Sk.operatorGrid].proxy.address },
  ];

  for (const contract of ozAdminTransfers) {
    const contractInstance = await loadContract(contract.name, contract.address);
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
    state.accounting.proxy.address,
    state.vaultHub.proxy.address,
    state.predepositGuarantee.proxy.address,
    state.operatorGrid.proxy.address,
    state.lazyOracle.proxy.address,
  ];

  for (const proxyAddress of ossifiableProxyAdminChanges) {
    const proxy = await loadContract("OssifiableProxy", proxyAddress);
    await makeTx(proxy, "proxy__changeAdmin", [agent], { from: deployer });
  }

  // Change DepositSecurityModule admin if not using a predefined address
  if (state[Sk.depositSecurityModule].deployParameters.usePredefinedAddressInstead === null) {
    const depositSecurityModule = await loadContract("DepositSecurityModule", state.depositSecurityModule.address);
    await makeTx(depositSecurityModule, "setOwner", [agent], { from: deployer });
  }

  // Transfer ownership of LidoTemplate to agent
  const lidoTemplate = await loadContract("LidoTemplate", state[Sk.lidoTemplate].address);
  await makeTx(lidoTemplate, "setOwner", [agent], { from: deployer });
}
