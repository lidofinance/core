import { id } from "ethers";
import { ethers } from "hardhat";

import { IAccessControl, ICircuitBreaker } from "typechain-types";

import {
  type DeploymentState,
  ether,
  getAddressValidated,
  getSubAddressValidated,
  impersonate,
  isContractDeployed,
  loadContract,
  log,
  readNetworkState,
  Sk,
} from "lib";

const PAUSE_ROLE = id("PAUSE_ROLE");
const I_ACCESS_CONTROL_ARTIFACT = "@openzeppelin/contracts-v5.2/access/IAccessControl.sol:IAccessControl";

type MigrationTarget = {
  label: string;
  pausable: string;
  gateSeal: string;
  pauser: string;
};

export async function main() {
  const state = readNetworkState();
  const cbAddress = requireStateAddress(state, Sk.circuitBreaker);
  if (!(await isContractDeployed(cbAddress))) {
    throw new Error(`CircuitBreaker is not deployed at ${cbAddress}`);
  }

  const agent = requireStateAddress(state, Sk.appAgent);
  const agentSigner = await impersonate(agent, ether("100"));
  const cb = await loadContract<ICircuitBreaker>("ICircuitBreaker", cbAddress, agentSigner);

  const targets = getMigrationTargets(state);

  log.splitter();
  log.header("[Mocks] Apply CircuitBreaker Pauser migration (GateSeal->CircuitBreaker)");

  for (const t of targets) {
    log(`Check ${t.label}[${t.pausable}]`);
    const p = await loadContract<IAccessControl>(I_ACCESS_CONTROL_ARTIFACT, t.pausable, agentSigner);

    if (await p.hasRole(PAUSE_ROLE, t.gateSeal)) {
      await p.revokeRole(PAUSE_ROLE, t.gateSeal);
      // await makeTx(p, "revokeRole", [PAUSE_ROLE, t.gateSeal], { from: agent, gas: 200000n }, false);
      log.success(`Revoking PAUSE_ROLE from GateSeal (${t.gateSeal}) for ${t.label}`);
    }

    if (!(await p.hasRole(PAUSE_ROLE, cbAddress))) {
      await p.grantRole(PAUSE_ROLE, cbAddress);
      // await makeTx(p, "grantRole", [PAUSE_ROLE, cbAddress], { from: agent, gas: 200000n }, false);
      log.success(`Granting PAUSE_ROLE to CircuitBreaker (${cbAddress}) for ${t.label}`);
    }
    if ((await cb.getPauser(t.pausable)) != t.pausable) {
      await cb.registerPauser(t.pausable, t.pauser);
      // await makeTx(cb, "registerPauser", [t.pausable, t.pauser], { from: agent, gas: 300000n }, false);
      log.success(`Registering pauser (${t.pauser}) for ${t.label}`);
    }
  }
}

function getMigrationTargets(state: DeploymentState): MigrationTarget[] {
  const coreGateSeal = requireStateAddress(state, Sk.gateSeal);
  const triggerableWithdrawalsGateSeal = requireStateAddress(state, Sk.gateSealTW);
  const vaultsGateSeal = requireStateAddress(state, Sk.gateSealV3);
  const csmGateSeal = requireAddress(`${Sk.sm_CSM}.gateSeal.address`, state[Sk.sm_CSM]?.gateSeal?.address);

  // ex. GateSeal committee -> Circuit Breaker Committee
  const cbCommittee = requireAddress(`${Sk.gateSeal}.sealingCommittee`, state[Sk.gateSeal]?.sealingCommittee);
  const csmCommittee = requireAddress(
    `${Sk.sm_CSM}.gateSeal.sealingCommittee`,
    state[Sk.sm_CSM]?.gateSeal?.sealingCommittee,
  );

  return [
    {
      label: "WithdrawalQueue",
      pausable: requireStateAddress(state, Sk.withdrawalQueueERC721),
      gateSeal: coreGateSeal,
      pauser: cbCommittee,
    },
    {
      label: "ValidatorsExitBusOracle",
      pausable: requireStateAddress(state, Sk.validatorsExitBusOracle),
      gateSeal: triggerableWithdrawalsGateSeal,
      pauser: cbCommittee,
    },
    {
      label: "TriggerableWithdrawalsGateway",
      pausable: requireStateAddress(state, Sk.triggerableWithdrawalsGateway),
      gateSeal: triggerableWithdrawalsGateSeal,
      pauser: cbCommittee,
    },
    {
      label: "VaultHub",
      pausable: requireStateAddress(state, Sk.vaultHub),
      gateSeal: vaultsGateSeal,
      pauser: cbCommittee,
    },
    {
      label: "PredepositGuarantee",
      pausable: requireStateAddress(state, Sk.predepositGuarantee),
      gateSeal: vaultsGateSeal,
      pauser: cbCommittee,
    },
    {
      label: "CSModule",
      pausable: requireStateAddress(state, Sk.sm_CSM),
      gateSeal: csmGateSeal,
      pauser: csmCommittee,
    },
    {
      label: "CSAccounting",
      pausable: requireSubStateAddress(state, Sk.sm_CSM, "accounting"),
      gateSeal: csmGateSeal,
      pauser: csmCommittee,
    },
    {
      label: "CSFeeOracle",
      pausable: requireSubStateAddress(state, Sk.sm_CSM, "feeOracle"),
      gateSeal: csmGateSeal,
      pauser: csmCommittee,
    },
    {
      label: "CSVerifierV2",
      pausable: requireSubStateAddress(state, Sk.sm_CSM, "verifier"),
      gateSeal: csmGateSeal,
      pauser: csmCommittee,
    },
    {
      label: "CSVettedGate",
      pausable: requireSubStateAddress(state, Sk.sm_CSM, "vettedGate"),
      gateSeal: csmGateSeal,
      pauser: csmCommittee,
    },
    {
      label: "CSEjector",
      pausable: requireSubStateAddress(state, Sk.sm_CSM, "ejector"),
      gateSeal: csmGateSeal,
      pauser: csmCommittee,
    },
  ];
}

function requireStateAddress(state: DeploymentState, key: Sk): string {
  return requireAddress(key, getAddressValidated(key, state));
}

function requireSubStateAddress(state: DeploymentState, key: Sk, subKey: string): string {
  return requireAddress(`${key}.${subKey}`, getSubAddressValidated(key, subKey, state));
}

function requireAddress(label: string, address: string | null | undefined): string {
  if (!address) {
    throw new Error(`Missing ${label} address in network state`);
  }
  return ethers.getAddress(address);
}
