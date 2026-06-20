import { ethers } from "hardhat";

import { DEFAULT_ADMIN_ROLE } from "lib/constants";
import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { isDGDeploymentEnabled } from "lib/scratch";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const agent = state[Sk.appAgent].proxy.address;
  const voting = state[Sk.appVoting].proxy.address;
  const dgEnabled = isDGDeploymentEnabled();

  // `deferDgRenounce: true` keeps the deployer's DEFAULT_ADMIN_ROLE on the
  // contract until step 0160, which needs it to wire ResealManager
  // PAUSE/RESUME on each sealable before handing admin to Agent.
  const ozAdminTransfers = [
    { name: "Burner", address: state[Sk.burner].proxy.address },
    { name: "HashConsensus", address: state[Sk.hashConsensusForAccountingOracle].address },
    { name: "HashConsensus", address: state[Sk.hashConsensusForValidatorsExitBusOracle].address },
    { name: "StakingRouter", address: state[Sk.stakingRouter].proxy.address },
    { name: "AccountingOracle", address: state[Sk.accountingOracle].proxy.address },
    {
      name: "ValidatorsExitBusOracle",
      address: state[Sk.validatorsExitBusOracle].proxy.address,
      deferDgRenounce: true,
    },
    { name: "WithdrawalQueueERC721", address: state[Sk.withdrawalQueueERC721].proxy.address, deferDgRenounce: true },
    { name: "OracleDaemonConfig", address: state[Sk.oracleDaemonConfig].address },
    { name: "OracleReportSanityChecker", address: state[Sk.oracleReportSanityChecker].address },
    { name: "TriggerableWithdrawalsGateway", address: state[Sk.triggerableWithdrawalsGateway].address },
    { name: "VaultHub", address: state[Sk.vaultHub].proxy.address },
    { name: "PredepositGuarantee", address: state[Sk.predepositGuarantee].proxy.address },
    { name: "OperatorGrid", address: state[Sk.operatorGrid].proxy.address },
    { name: "LazyOracle", address: state[Sk.lazyOracle].proxy.address },
  ];

  for (const contract of ozAdminTransfers) {
    const contractInstance = await loadContract(contract.name, contract.address);
    await makeTx(contractInstance, "grantRole", [DEFAULT_ADMIN_ROLE, agent], { from: deployer });
    if (!dgEnabled || !contract.deferDgRenounce) {
      await makeTx(contractInstance, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });
    }
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
    state.burner.proxy.address,
  ];

  const sepoliaDepositAdapterAddress = state[Sk.sepoliaDepositAdapter]?.proxy?.address;
  if (sepoliaDepositAdapterAddress) {
    ossifiableProxyAdminChanges.push(sepoliaDepositAdapterAddress);
  }

  for (const proxyAddress of ossifiableProxyAdminChanges) {
    const proxy = await loadContract("OssifiableProxy", proxyAddress);
    await makeTx(proxy, "proxy__changeAdmin", [agent], { from: deployer });
  }

  if (sepoliaDepositAdapterAddress) {
    const sepoliaDepositAdapter = await loadContract("SepoliaDepositAdapter", sepoliaDepositAdapterAddress);
    await makeTx(sepoliaDepositAdapter, "transferOwnership", [agent], { from: deployer });
  }

  // Change DepositSecurityModule admin if not using a predefined address
  if (state[Sk.depositSecurityModule].deployParameters.usePredefinedAddressInstead === null) {
    const depositSecurityModule = await loadContract("DepositSecurityModule", state.depositSecurityModule.address);
    await makeTx(depositSecurityModule, "setOwner", [agent], { from: deployer });
  }

  // LidoTemplate ownership moves to Agent in step 0160 — its finalize
  // functions require the deployer to still be the template owner.

  // Transfer admin for WithdrawalsManagerProxy from deployer to voting
  const withdrawalsManagerProxy = await loadContract("WithdrawalsManagerProxy", state.withdrawalVault.proxy.address);
  await makeTx(withdrawalsManagerProxy, "proxy_changeAdmin", [voting], { from: deployer });
}
