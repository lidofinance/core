import { ethers } from "hardhat";
import { DaoCall, executeScratchDecision } from "scripts/utils/scratch-governance";

import { ACL } from "typechain-types";

import { cy, loadContract, log } from "lib";
import { readNetworkState, Sk } from "lib/state-file";

// The launch puts the Agent under Dual Governance as mainnet's launch omnibus did
// (dual-governance scripts/launch/mainnet/DGLaunchOmnibusMainnet.sol, items 31-38 and 52).
// WithdrawalQueue and ValidatorsExitBusOracle stay paused until the protocol is activated, so they
// are not yet sealable withdrawal blockers: Dual Governance refuses a paused sealable.
const RUN_SCRIPT_ROLE = ethers.id("RUN_SCRIPT_ROLE");
const EXECUTE_ROLE = ethers.id("EXECUTE_ROLE");
const PAUSE_ROLE = ethers.id("PAUSE_ROLE");
const RESUME_ROLE = ethers.id("RESUME_ROLE");

const accessControl = new ethers.Interface(["function grantRole(bytes32,address)"]);

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  if (!state[Sk.dgDualGovernance]?.proxy?.address) {
    log("Dual Governance is not deployed, the Agent stays under Voting");
    log.emptyLine();
    return;
  }

  const agent = state[Sk.appAgent].proxy.address;
  const voting = state[Sk.appVoting].proxy.address;
  const adminExecutor = ethers.getAddress(state[Sk.dgDualGovernance].deployArtifact.admin_executor);
  const resealManager = state[Sk.resealManager].address;
  const acl = await loadContract<ACL>("ACL", state[Sk.aragonAcl].proxy.address);

  // Items 35-38: the reseal manager may pause and resume the withdrawal queue and the exit bus oracle.
  const sealables = [state[Sk.withdrawalQueueERC721].proxy.address, state[Sk.validatorsExitBusOracle].proxy.address];
  const resealCalls: DaoCall[] = sealables.flatMap((sealable) =>
    [PAUSE_ROLE, RESUME_ROLE].map((role) => ({
      to: sealable,
      data: accessControl.encodeFunctionData("grantRole", [role, resealManager]),
    })),
  );
  await executeScratchDecision(
    { description: "Scratch Dual Governance launch: reseal manager roles", agent: resealCalls },
    state,
  );

  // Items 31-34 and the result of item 52: the admin executor alone holds the Agent's roles, and the
  // Agent manages them, so every DAO decision that needs the Agent passes through Dual Governance.
  const agentRoleCalls: DaoCall[] = [RUN_SCRIPT_ROLE, EXECUTE_ROLE].flatMap((role) => [
    { to: acl.address, data: acl.interface.encodeFunctionData("grantPermission", [adminExecutor, agent, role]) },
    { to: acl.address, data: acl.interface.encodeFunctionData("revokePermission", [voting, agent, role]) },
    { to: acl.address, data: acl.interface.encodeFunctionData("setPermissionManager", [agent, agent, role]) },
  ]);
  // A separate vote: in one vote Voting would lose the Agent's roles before it makes the Agent's calls.
  await executeScratchDecision(
    { description: "Scratch Dual Governance launch: Agent roles", voting: agentRoleCalls },
    state,
  );

  for (const role of [RUN_SCRIPT_ROLE, EXECUTE_ROLE]) {
    if (
      !(await acl["hasPermission(address,address,bytes32)"](adminExecutor, agent, role)) ||
      (await acl["hasPermission(address,address,bytes32)"](voting, agent, role)) ||
      ethers.getAddress(await acl.getPermissionManager(agent, role)) !== ethers.getAddress(agent)
    ) {
      throw new Error(`The Agent's role ${role} did not move to Dual Governance`);
    }
  }

  log(`The Agent is under Dual Governance: admin executor ${cy(adminExecutor)}`);
  log.emptyLine();
}
