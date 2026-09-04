import { deployWithoutProxy, getDeployerState } from "#lib/deploy.js";
import { cy, log } from "#lib/log.js";
import { Sk, updateObjectInState } from "#lib/state-file.js";

export async function main() {
  const { deployer, state } = await getDeployerState();

  let depositContractAddress = state.chainSpec.depositContract;
  if (depositContractAddress) {
    log(`Using DepositContract at: ${cy(depositContractAddress)}`);
    return;
  }

  depositContractAddress = (await deployWithoutProxy(Sk.depositContract, "DepositContract", deployer)).address;

  updateObjectInState(Sk.chainSpec, {
    depositContract: depositContractAddress,
  });
}
