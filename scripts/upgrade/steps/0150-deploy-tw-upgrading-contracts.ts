import { ethers } from "hardhat";

import { LidoLocator__factory } from "typechain-types";

import { deployWithoutProxy } from "lib/deploy";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployerSigner = await ethers.provider.getSigner();
  const deployer = deployerSigner.address;
  const state = readNetworkState();

  const locator = LidoLocator__factory.connect(getAddress(Sk.lidoLocator, state), deployerSigner);

  await deployWithoutProxy(Sk.TWVoteScript, "TWVoteScript", deployer, [
    state[Sk.appVoting].proxy.address,
    {
      // Contract addresses
      agent: getAddress(Sk.appAgent, state),
      lido_locator: state[Sk.lidoLocator].proxy.address,
      lido_locator_impl: await locator.getAddress(),
      validators_exit_bus_oracle: await locator.validatorsExitBusOracle(),
      validators_exit_bus_oracle_impl: state[Sk.validatorsExitBusOracle].implementation.address,
      triggerable_withdrawals_gateway: getAddress(Sk.triggerableWithdrawalsGateway, state),
      withdrawal_vault: await locator.withdrawalVault(),
      withdrawal_vault_impl: state[Sk.withdrawalVault].implementation.address,
      accounting_oracle: await locator.accountingOracle(),
      accounting_oracle_impl: state[Sk.accountingOracle].implementation.address,
      staking_router: await locator.stakingRouter(),
      staking_router_impl: state[Sk.stakingRouter].implementation.address,
      validator_exit_verifier: getAddress(Sk.validatorExitDelayVerifier, state),
      node_operators_registry: getAddress(Sk.appNodeOperatorsRegistry, state),
      node_operators_registry_impl: state[Sk.appNodeOperatorsRegistry].implementation.address,
      oracle_daemon_config: await locator.oracleDaemonConfig(),
      nor_app_repo: state[Sk.aragonNodeOperatorsRegistryAppRepo].proxy.address,

      // Other parameters
      node_operators_registry_app_id: state[Sk.appNodeOperatorsRegistry].aragonApp.id,
      nor_version: [6, 0, 0],
      vebo_consensus_version: 4,
      ao_consensus_version: 4,
      nor_exit_deadline_in_sec: 30 * 60, // 30 minutes
      exit_events_lookback_window_in_slots: 7200,
      nor_content_uri: state[Sk.appNodeOperatorsRegistry].aragonApp.contentURI,
    },
  ]);
}
