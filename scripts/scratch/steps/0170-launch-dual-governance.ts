import { executeDGProposal } from "scripts/utils/upgrade";

import {
  ACL,
  Agent,
  IDualGovernance,
  IEmergencyProtectedTimelock,
  ValidatorsExitBusOracle,
  WithdrawalQueueERC721,
} from "typechain-types";

import {
  aclHasPermission,
  CREATE_PERMISSIONS_ROLE,
  ether,
  EXECUTE_ROLE,
  findEventsWithInterfaces,
  getAddress,
  impersonate,
  loadContract,
  log,
  PAUSE_ROLE,
  readNetworkState,
  RESUME_ROLE,
  RUN_SCRIPT_ROLE,
  Sk,
  tryGetAddress,
} from "lib";

export async function main() {
  const state = readNetworkState();

  const aclAddress = getAddress(Sk.aragonAcl, state);
  const votingAddress = getAddress(Sk.appVoting, state);
  const agentAddress = getAddress(Sk.appAgent, state);
  const wqAddress = getAddress(Sk.withdrawalQueueERC721, state);
  const veboAddress = getAddress(Sk.validatorsExitBusOracle, state);
  const adminExecutorAddress = tryGetAddress(Sk.dgAdminExecutor, state);
  const dualGovernanceAddress = tryGetAddress(Sk.dgDualGovernance, state);
  const timelockAddress = tryGetAddress(Sk.dgEmergencyProtectedTimelock, state);
  const resealManagerAddress = tryGetAddress(Sk.resealManager, state);

  if (!adminExecutorAddress || !dualGovernanceAddress || !timelockAddress || !resealManagerAddress) {
    throw new Error("DG addresses missing in state — step 0160 must run before this step");
  }

  // Idempotency: scratch deploy is replayed by integration tests (MODE=scratch
  // with --network local) against the same hardhat-node. The launch proposal
  // ends with Voting losing RUN_SCRIPT_ROLE on Agent — that's the unique
  // post-launch signal (timelock.getGovernance() is set to DG by step 0160's
  // forge deploy already, so it can't be used here). Re-running this step
  // would also fail because Agent — not Voting — is the permission manager
  // for those roles after the first run.
  const aclReadOnly = await loadContract<ACL>("ACL", aclAddress);
  if (!(await aclHasPermission(aclReadOnly, votingAddress, agentAddress, RUN_SCRIPT_ROLE))) {
    log(`Dual Governance already launched (Voting has no RUN_SCRIPT_ROLE on Agent), skipping`);
    return;
  }

  // Voting is the permission manager for Agent's RUN_SCRIPT_ROLE/EXECUTE_ROLE
  // (set in 0070). Impersonate it on the fork to grant the same powers to
  // AdminExecutor; that bridge lets DG drive Agent. Skipping the production
  // Aragon vote ceremony — scratch only needs the resulting topology.
  const voting = await impersonate(votingAddress, ether("100"));
  const acl = aclReadOnly.connect(voting);

  log("Granting AdminExecutor RUN_SCRIPT_ROLE on Agent");
  await (await acl.grantPermission(adminExecutorAddress, agentAddress, RUN_SCRIPT_ROLE)).wait();
  log("Granting AdminExecutor EXECUTE_ROLE on Agent");
  await (await acl.grantPermission(adminExecutorAddress, agentAddress, EXECUTE_ROLE)).wait();

  // Move the permission manager from Voting to Agent. After this, Voting can no
  // longer revoke AdminExecutor's powers — only Agent (driven by DG) can.
  log("Setting Agent as permission manager for RUN_SCRIPT_ROLE/EXECUTE_ROLE on Agent");
  await (await acl.setPermissionManager(agentAddress, agentAddress, RUN_SCRIPT_ROLE)).wait();
  await (await acl.setPermissionManager(agentAddress, agentAddress, EXECUTE_ROLE)).wait();

  // Mainnet omnibus items 28-30: route ACL CREATE_PERMISSIONS_ROLE through Agent.
  // Scratch's LidoTemplate (LidoTemplate.sol:681) puts it at Voting just like
  // mainnet's pre-DG state; without this migration Voting could keep creating
  // arbitrary permissions on DAO contracts, bypassing DG. Items 1-27 of the
  // mainnet omnibus don't apply here — LidoTemplate.sol:595-619 already creates
  // Lido / NOR / SDVT / Kernel / EVMScriptRegistry permissions with Agent as
  // grantee+manager.
  log("Migrating ACL CREATE_PERMISSIONS_ROLE: Voting → Agent");
  await (await acl.grantPermission(agentAddress, aclAddress, CREATE_PERMISSIONS_ROLE)).wait();
  await (await acl.revokePermission(votingAddress, aclAddress, CREATE_PERMISSIONS_ROLE)).wait();
  await (await acl.setPermissionManager(agentAddress, aclAddress, CREATE_PERMISSIONS_ROLE)).wait();

  // ResealManager needs PAUSE_ROLE/RESUME_ROLE on each sealable to (re)seal it.
  // On mainnet these are granted by the omnibus; here Agent (which holds
  // DEFAULT_ADMIN_ROLE on both contracts post-0150) does it directly.
  await grantResealManagerRoles({
    agent: agentAddress,
    resealManager: resealManagerAddress,
    wq: wqAddress,
    vebo: veboAddress,
  });

  // Launch DG proposal: revoke Voting's direct Agent control. Mirrors mainnet's
  // omnibus DG-proposal item — after this lands, Voting can only act on Lido
  // through DG, completing the migration.
  const dg = await loadContract<IDualGovernance>("IDualGovernance", dualGovernanceAddress, voting);
  const timelock = await loadContract<IEmergencyProtectedTimelock>(
    "IEmergencyProtectedTimelock",
    timelockAddress,
    voting,
  );
  const agent = await loadContract<Agent>("Agent", agentAddress, voting);

  const wrapAgentExecute = (target: string, payload: string) => ({
    target: agentAddress,
    value: 0n,
    payload: agent.interface.encodeFunctionData("execute", [target, 0n, payload]),
  });
  const calls = [
    wrapAgentExecute(
      aclAddress,
      acl.interface.encodeFunctionData("revokePermission", [votingAddress, agentAddress, RUN_SCRIPT_ROLE]),
    ),
    wrapAgentExecute(
      aclAddress,
      acl.interface.encodeFunctionData("revokePermission", [votingAddress, agentAddress, EXECUTE_ROLE]),
    ),
  ];

  log("Submitting DG launch proposal: revoke Voting's RUN_SCRIPT_ROLE/EXECUTE_ROLE on Agent");
  const submitReceipt = (await (await dg.submitProposal(calls, "scratch DG launch: route Voting through DG")).wait())!;
  const submitted = findEventsWithInterfaces(submitReceipt, "ProposalSubmitted", [dg.interface]);
  if (submitted.length === 0) {
    throw new Error("ProposalSubmitted event not found in submit receipt");
  }
  const proposalId = submitted[0].args.id as bigint;
  log(`Submitted: proposalId=${proposalId}`);

  await executeDGProposal({ dualGovernance: dg, timelock, signer: voting, proposalId });

  const governance = await timelock.getGovernance();
  if (governance.toLowerCase() !== dualGovernanceAddress.toLowerCase()) {
    throw new Error(`Expected timelock governance = ${dualGovernanceAddress}, got ${governance}`);
  }
  if (await timelock.isEmergencyModeActive()) throw new Error("Emergency mode unexpectedly active after launch");
  if (await aclHasPermission(acl, votingAddress, agentAddress, RUN_SCRIPT_ROLE)) {
    throw new Error("Voting still has RUN_SCRIPT_ROLE on Agent after launch proposal");
  }
  if (await aclHasPermission(acl, votingAddress, agentAddress, EXECUTE_ROLE)) {
    throw new Error("Voting still has EXECUTE_ROLE on Agent after launch proposal");
  }
  if (!(await aclHasPermission(acl, adminExecutorAddress, agentAddress, RUN_SCRIPT_ROLE))) {
    throw new Error("AdminExecutor lost RUN_SCRIPT_ROLE on Agent");
  }

  log.success("Dual Governance launched and verified end-to-end");
}

async function grantResealManagerRoles(opts: {
  agent: string;
  resealManager: string;
  wq: string;
  vebo: string;
}): Promise<void> {
  const agentSigner = await impersonate(opts.agent, ether("100"));
  const wq = await loadContract<WithdrawalQueueERC721>("WithdrawalQueueERC721", opts.wq, agentSigner);
  const vebo = await loadContract<ValidatorsExitBusOracle>("ValidatorsExitBusOracle", opts.vebo, agentSigner);

  for (const [label, c] of [
    ["WithdrawalQueueERC721", wq],
    ["ValidatorsExitBusOracle", vebo],
  ] as const) {
    await (await c.grantRole(PAUSE_ROLE, opts.resealManager)).wait();
    await (await c.grantRole(RESUME_ROLE, opts.resealManager)).wait();
    log(`Granted ResealManager PAUSE_ROLE/RESUME_ROLE on ${label} (${await c.getAddress()})`);
  }
}
