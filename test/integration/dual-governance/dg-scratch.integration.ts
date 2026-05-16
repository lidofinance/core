import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { executeDGProposal } from "scripts/utils/upgrade";

import { ACL, IDualGovernance, IEmergencyProtectedTimelock } from "typechain-types";

import {
  aclHasPermission,
  CREATE_PERMISSIONS_ROLE,
  ether,
  EXECUTE_ROLE,
  getAddress,
  impersonate,
  loadContract,
  PAUSE_ROLE,
  readNetworkState,
  RESUME_ROLE,
  RUN_SCRIPT_ROLE,
  Sk,
} from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Dual Governance scratch launch state", () => {
  let ctx: ProtocolContext;
  let suiteSnapshot: string;
  let testSnapshot: string;

  let acl: ACL;
  let dg: IDualGovernance;
  let timelock: IEmergencyProtectedTimelock;

  let aclAddress: string;
  let agentAddress: string;
  let votingAddress: string;
  let adminExecutor: string;
  let dualGovernance: string;
  let timelockAddress: string;
  let resealManager: string;
  let tiebreakerCoreCommittee: string;
  let tiebreakerSubCommittees: string[];

  before(async function () {
    ctx = await getProtocolContext();
    if (!ctx.isScratch) {
      // Post-launch topology asserted here is the end state of scratch step
      // 0160 (forge deploy + LidoTemplate.finalizePermissionsAfterDGDeployment).
      // On non-scratch contexts DG state may not match.
      this.skip();
    }
    if (process.env.DG_DEPLOYMENT_ENABLED === "false") {
      // Scratch deploy explicitly skipped DG via the opt-out toggle.
      this.skip();
    }

    suiteSnapshot = await Snapshot.take();

    const state = readNetworkState();
    aclAddress = getAddress(Sk.aragonAcl, state);
    agentAddress = ctx.signers.agent;
    votingAddress = ctx.signers.voting;
    adminExecutor = getAddress(Sk.dgAdminExecutor, state);
    dualGovernance = getAddress(Sk.dgDualGovernance, state);
    timelockAddress = getAddress(Sk.dgEmergencyProtectedTimelock, state);
    resealManager = getAddress(Sk.resealManager, state);
    tiebreakerCoreCommittee = getAddress(Sk.dgTiebreakerCoreCommittee, state);
    tiebreakerSubCommittees = state[Sk.dgTiebreakerSubCommittees].addresses;

    acl = ctx.contracts.acl;
    [dg, timelock] = await Promise.all([
      loadContract<IDualGovernance>("IDualGovernance", dualGovernance),
      loadContract<IEmergencyProtectedTimelock>("IEmergencyProtectedTimelock", timelockAddress),
    ]);
  });

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => {
    if (testSnapshot) await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    if (suiteSnapshot) await Snapshot.restore(suiteSnapshot);
  });

  it("populates all DG addresses in state", () => {
    for (const [name, addr] of Object.entries({
      adminExecutor,
      dualGovernance,
      timelock: timelockAddress,
      resealManager,
      tiebreakerCoreCommittee,
    })) {
      expect(addr, `${name} unset`).to.not.equal(ZeroAddress);
      expect(addr, `${name} not 0x address`).to.match(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(tiebreakerSubCommittees).to.have.length.gte(1);
  });

  it("registers DG as the timelock governance", async () => {
    expect(await timelock.getGovernance()).to.equal(dualGovernance);
    expect(await timelock.isEmergencyModeActive()).to.equal(false);
  });

  it("records no launch proposal (LidoTemplate finalize handles revocation directly)", async () => {
    expect(await timelock.getProposalsCount()).to.equal(0n);
  });

  it("grants AdminExecutor full Agent control and revokes it from Voting", async () => {
    expect(await aclHasPermission(acl, adminExecutor, agentAddress, RUN_SCRIPT_ROLE)).to.equal(true);
    expect(await aclHasPermission(acl, adminExecutor, agentAddress, EXECUTE_ROLE)).to.equal(true);
    expect(await aclHasPermission(acl, votingAddress, agentAddress, RUN_SCRIPT_ROLE)).to.equal(false);
    expect(await aclHasPermission(acl, votingAddress, agentAddress, EXECUTE_ROLE)).to.equal(false);
  });

  it("makes Agent the permission manager for its own RUN_SCRIPT_ROLE/EXECUTE_ROLE", async () => {
    expect(await acl.getPermissionManager(agentAddress, RUN_SCRIPT_ROLE)).to.equal(agentAddress);
    expect(await acl.getPermissionManager(agentAddress, EXECUTE_ROLE)).to.equal(agentAddress);
  });

  it("routes ACL CREATE_PERMISSIONS_ROLE through Agent (Voting can no longer create permissions)", async () => {
    expect(await aclHasPermission(acl, agentAddress, aclAddress, CREATE_PERMISSIONS_ROLE)).to.equal(true);
    expect(await aclHasPermission(acl, votingAddress, aclAddress, CREATE_PERMISSIONS_ROLE)).to.equal(false);
    expect(await acl.getPermissionManager(aclAddress, CREATE_PERMISSIONS_ROLE)).to.equal(agentAddress);
  });

  it("grants ResealManager PAUSE/RESUME on every sealable", async () => {
    for (const c of [ctx.contracts.withdrawalQueue, ctx.contracts.validatorsExitBusOracle]) {
      expect(await c.hasRole(PAUSE_ROLE, resealManager)).to.equal(true);
      expect(await c.hasRole(RESUME_ROLE, resealManager)).to.equal(true);
    }
  });

  it("routes a no-op DG proposal end-to-end through Voting → DG → AdminExecutor → Agent", async () => {
    const voting = await impersonate(votingAddress, ether("100"));
    const agentIface = (await loadContract("Agent", agentAddress)).interface;

    // ACL.getPermissionManager is a view; calling it via Agent.execute exercises the
    // full Voting → DG → AdminExecutor → Agent path without mutating state.
    const innerCall = acl.interface.encodeFunctionData("getPermissionManager", [agentAddress, RUN_SCRIPT_ROLE]);
    const agentExec = agentIface.encodeFunctionData("execute", [aclAddress, 0n, innerCall]);

    const before = await timelock.getProposalsCount();
    await (
      await dg.connect(voting).submitProposal([{ target: agentAddress, value: 0n, payload: agentExec }], "test no-op")
    ).wait();
    const proposalId = await timelock.getProposalsCount();
    expect(proposalId).to.equal(before + 1n);

    await executeDGProposal({ dualGovernance: dg, timelock, signer: voting, proposalId });
  });
});
