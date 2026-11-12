import { expect } from "chai";
import { Contract, Interface, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { readNetworkState, Sk } from "lib/state-file";

import { Snapshot } from "test/suite";

const DUAL_GOVERNANCE_ABI = [
  "function getEffectiveState() view returns (uint8)",
  "function getResealManager() view returns (address)",
  "function getVetoSignallingEscrow() view returns (address)",
  "function getProposer(address proposerAccount) view returns ((address account, address executor))",
  "function submitProposal((address target, uint96 value, bytes payload)[] calls, string metadata) returns (uint256)",
  "function scheduleProposal(uint256 proposalId)",
];

const TIMELOCK_ABI = [
  "function getGovernance() view returns (address)",
  "function getAdminExecutor() view returns (address)",
  "function getAfterSubmitDelay() view returns (uint32)",
  "function getAfterScheduleDelay() view returns (uint32)",
  "function getProposalsCount() view returns (uint256)",
  "function getProposalDetails(uint256 proposalId) view returns ((uint256 id, address executor, uint40 submittedAt, uint40 scheduledAt, uint8 status))",
  "function execute(uint256 proposalId)",
];

const ESCROW_ABI = [
  "function lockStETH(uint256 amount) returns (uint256)",
  "function unlockStETH() returns (uint256)",
  "function getRageQuitSupport() view returns (uint128)",
  "function getMinAssetsLockDuration() view returns (uint32)",
  "function getVetoerDetails(address vetoer) view returns ((uint256 unstETHIdsCount, uint128 stETHLockedShares, uint128 unstETHLockedShares, uint40 lastAssetsLockTimestamp))",
];

const AGENT_ABI = ["function execute(address target, uint256 ethValue, bytes data)"];

// Dual Governance raises these errors in its libraries; the contracts above bubble them up.
const dualGovernanceErrors = {
  interface: new Interface([
    "error ProposerNotRegistered(address proposerAccount)",
    "error AfterSubmitDelayNotPassed(uint256 proposalId)",
    "error AfterScheduleDelayNotPassed(uint256 proposalId)",
    "error MinAssetsLockDurationNotPassed(uint40 lockDurationExpiresAt)",
  ]),
};

const NORMAL_STATE = 1n;
const SUBMITTED = 1n;
const SCHEDULED = 2n;
const EXECUTED = 3n;

const RUN_SCRIPT_ROLE = ethers.id("RUN_SCRIPT_ROLE");
const EXECUTE_ROLE = ethers.id("EXECUTE_ROLE");

describe("Integration: Dual Governance", () => {
  let ctx: ProtocolContext;
  let dualGovernance: Contract;
  let timelock: Contract;
  let agent: Contract;
  let adminExecutor: string;
  let resealManager: string;

  let voting: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let suiteSnapshot: string;
  let testSnapshot: string;

  before(async function () {
    ctx = await getProtocolContext();

    // Mainnet and Hoodi run Dual Governance; scratch deploys it only with a `dualGovernance` section.
    const state = readNetworkState();
    const dualGovernanceAddress = state[Sk.dgDualGovernance]?.proxy?.address;
    if (!dualGovernanceAddress) return this.skip();

    suiteSnapshot = await Snapshot.take();

    dualGovernance = new ethers.Contract(dualGovernanceAddress, DUAL_GOVERNANCE_ABI, ethers.provider);
    timelock = new ethers.Contract(state[Sk.dgEmergencyProtectedTimelock].proxy.address, TIMELOCK_ABI, ethers.provider);
    agent = new ethers.Contract(ctx.signers.agent, AGENT_ABI, ethers.provider);
    adminExecutor = await timelock.getAdminExecutor();
    resealManager = state[Sk.resealManager].address;

    voting = await ctx.getSigner("voting");
    [stranger] = await ethers.getSigners();
  });

  beforeEach(async () => (testSnapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(testSnapshot));

  after(async () => {
    if (suiteSnapshot) await Snapshot.restore(suiteSnapshot);
  });

  it("governs the timelock and takes proposals from the DAO's voting", async () => {
    expect(await timelock.getGovernance()).to.equal(await dualGovernance.getAddress());
    expect(await dualGovernance.getResealManager()).to.equal(resealManager);
    expect(await dualGovernance.getEffectiveState()).to.equal(NORMAL_STATE);

    const proposer = await dualGovernance.getProposer(voting.address);
    expect(proposer.account).to.equal(voting.address);
    expect(proposer.executor).to.equal(adminExecutor);
  });

  it("gives only the admin executor the Agent's RUN_SCRIPT_ROLE and EXECUTE_ROLE", async () => {
    const { acl } = ctx.contracts;
    const hasPermission = acl["hasPermission(address,address,bytes32)"];

    for (const role of [RUN_SCRIPT_ROLE, EXECUTE_ROLE]) {
      expect(await hasPermission(adminExecutor, ctx.signers.agent, role)).to.equal(true);
      expect(await hasPermission(ctx.signers.voting, ctx.signers.agent, role)).to.equal(false);
      expect(await acl.getPermissionManager(ctx.signers.agent, role)).to.equal(ctx.signers.agent);
    }

    await expect(
      (agent.connect(voting) as Contract).execute(await ctx.contracts.lido.getAddress(), 0n, "0x"),
    ).to.be.revertedWith("APP_AUTH_FAILED");
  });

  it("lets the reseal manager pause and resume the withdrawal queue and the exit bus oracle", async () => {
    for (const sealable of [ctx.contracts.withdrawalQueue, ctx.contracts.validatorsExitBusOracle]) {
      expect(await sealable.hasRole(await sealable.PAUSE_ROLE(), resealManager)).to.equal(true);
      expect(await sealable.hasRole(await sealable.RESUME_ROLE(), resealManager)).to.equal(true);
    }
  });

  it("executes a proposal of the DAO's voting after the timelock: the Agent sets Lido's staking limit", async () => {
    const { acl, lido } = ctx.contracts;
    const maxStakeLimit = ether("12345");
    const stakeLimitIncreasePerBlock = ether("1.5");

    const stakingControlRole = await lido.STAKING_CONTROL_ROLE();
    const agentCalls = [];
    if (!(await acl["hasPermission(address,address,bytes32)"](ctx.signers.agent, lido.address, stakingControlRole))) {
      agentCalls.push({
        target: acl.address,
        data: acl.interface.encodeFunctionData("grantPermission", [
          ctx.signers.agent,
          lido.address,
          stakingControlRole,
        ]),
      });
    }
    agentCalls.push({
      target: lido.address,
      data: lido.interface.encodeFunctionData("setStakingLimit", [maxStakeLimit, stakeLimitIncreasePerBlock]),
    });
    const calls = agentCalls.map(({ target, data }) => ({
      target: ctx.signers.agent,
      value: 0n,
      payload: agent.interface.encodeFunctionData("execute", [target, 0n, data]),
    }));

    await expect((dualGovernance.connect(stranger) as Contract).submitProposal(calls, "Stranger"))
      .to.be.revertedWithCustomError(dualGovernanceErrors, "ProposerNotRegistered")
      .withArgs(stranger.address);

    const proposalId = (await timelock.getProposalsCount()) + 1n;
    await (dualGovernance.connect(voting) as Contract).submitProposal(calls, "Set Lido's staking limit");
    const submitted = await timelock.getProposalDetails(proposalId);
    expect(submitted.executor).to.equal(adminExecutor);
    expect(submitted.status).to.equal(SUBMITTED);

    await expect((dualGovernance.connect(stranger) as Contract).scheduleProposal(proposalId))
      .to.be.revertedWithCustomError(dualGovernanceErrors, "AfterSubmitDelayNotPassed")
      .withArgs(proposalId);

    await advanceChainTime(BigInt(await timelock.getAfterSubmitDelay()));
    await (dualGovernance.connect(stranger) as Contract).scheduleProposal(proposalId);
    expect((await timelock.getProposalDetails(proposalId)).status).to.equal(SCHEDULED);

    await expect((timelock.connect(stranger) as Contract).execute(proposalId))
      .to.be.revertedWithCustomError(dualGovernanceErrors, "AfterScheduleDelayNotPassed")
      .withArgs(proposalId);

    await advanceChainTime(BigInt(await timelock.getAfterScheduleDelay()));
    await (timelock.connect(stranger) as Contract).execute(proposalId);
    expect((await timelock.getProposalDetails(proposalId)).status).to.equal(EXECUTED);

    const stakeLimit = await lido.getStakeLimitFullInfo();
    expect(stakeLimit.isStakingLimitSet).to.equal(true);
    expect(stakeLimit.maxStakeLimit).to.equal(maxStakeLimit);
    expect(stakeLimit.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimit / stakeLimitIncreasePerBlock);
  });

  it("counts stETH locked in the signalling escrow as rage quit support and returns it after the lock", async () => {
    const { lido } = ctx.contracts;
    const escrow = new ethers.Contract(await dualGovernance.getVetoSignallingEscrow(), ESCROW_ABI, stranger);

    // At most 0.1% of all stETH, below any first seal, so Dual Governance stays in its normal state.
    const totalPooledEther = await lido.getTotalPooledEther();
    const amount = totalPooledEther / 1000n < ether("1") ? totalPooledEther / 1000n : ether("1");
    await lido.connect(stranger).submit(ZeroAddress, { value: amount });
    const sharesBefore = await lido.sharesOf(stranger);
    const lockedShares = await lido.getSharesByPooledEth(amount);
    const supportBefore = await escrow.getRageQuitSupport();

    await lido.connect(stranger).approve(await escrow.getAddress(), amount);
    await escrow.lockStETH(amount);

    expect((await escrow.getVetoerDetails(stranger.address)).stETHLockedShares).to.equal(lockedShares);
    expect(await lido.sharesOf(stranger)).to.equal(sharesBefore - lockedShares);
    expect(await escrow.getRageQuitSupport()).to.be.gt(supportBefore);
    expect(await dualGovernance.getEffectiveState()).to.equal(NORMAL_STATE);

    await expect(escrow.unlockStETH()).to.be.revertedWithCustomError(
      dualGovernanceErrors,
      "MinAssetsLockDurationNotPassed",
    );

    await advanceChainTime(BigInt(await escrow.getMinAssetsLockDuration()) + 1n);
    await escrow.unlockStETH();

    expect((await escrow.getVetoerDetails(stranger.address)).stETHLockedShares).to.equal(0n);
    expect(await lido.sharesOf(stranger)).to.equal(sharesBefore);
    expect(await escrow.getRageQuitSupport()).to.equal(supportBefore);
  });
});
