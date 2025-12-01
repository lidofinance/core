import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mine } from "@nomicfoundation/hardhat-network-helpers";

import { Lido } from "typechain-types";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Staking limits", () => {
  let ctx: ProtocolContext;
  let lido: Lido;
  let snapshot: string;
  let testSnapshot: string;
  let stranger: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    lido = ctx.contracts.lido;
    agent = await ctx.getSigner("agent");
    const acl = ctx.contracts.acl.connect(agent);

    [stranger] = await ethers.getSigners();

    const lidoAddress = await lido.getAddress();
    const agentAddress = await agent.getAddress();
    await acl.connect(agent).grantPermission(agentAddress, lidoAddress, await lido.PAUSE_ROLE());
    await acl.connect(agent).grantPermission(agentAddress, lidoAddress, await lido.RESUME_ROLE());
    await acl.connect(agent).grantPermission(agentAddress, lidoAddress, await lido.STAKING_CONTROL_ROLE());
    await acl.connect(agent).grantPermission(agentAddress, lidoAddress, await lido.STAKING_PAUSE_ROLE());
  });

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => await Snapshot.restore(snapshot));

  it("Should have expected staking limit info", async () => {
    const info = await lido.getStakeLimitFullInfo();

    expect(info.isStakingPaused_).to.be.false;
    expect(info.isStakingLimitSet).to.be.true;
    expect(info.currentStakeLimit).to.be.lte(ether("150000"));
    expect(info.currentStakeLimit).to.be.gt(0);
    expect(info.maxStakeLimit).to.equal(ether("150000"));
    expect(info.prevStakeLimit).to.be.lte(ether("150000"));
  });

  it("Should have staking not paused initially", async () => {
    expect(await lido.isStakingPaused()).to.be.false;
  });

  it("Should not allow stranger to pause staking", async () => {
    await expect(lido.connect(stranger).pauseStaking()).to.be.revertedWith("APP_AUTH_FAILED");

    await lido.connect(agent).pauseStaking();
    expect(await lido.isStakingPaused()).to.be.true;
  });

  it("Should prevent staking when paused", async () => {
    await lido.connect(agent).pauseStaking();

    await expect(lido.connect(stranger).submit(ethers.ZeroAddress, { value: ether("1") })).to.be.revertedWith(
      "STAKING_PAUSED",
    );
  });

  it("Should only allow authorized accounts to resume staking", async () => {
    await lido.connect(agent).pauseStaking();

    await expect(lido.connect(stranger).resumeStaking()).to.be.revertedWith("APP_AUTH_FAILED");

    await lido.connect(agent).resumeStaking();
    expect(await lido.isStakingPaused()).to.be.false;
  });

  it("Should allow staking after resumed", async () => {
    await lido.connect(agent).pauseStaking();
    await lido.connect(agent).resumeStaking();

    await lido.connect(stranger).submit(ethers.ZeroAddress, { value: ether("1") });
  });

  it("Should only allow authorized accounts to set staking limit", async () => {
    await expect(lido.connect(stranger).setStakingLimit(ether("1"), ether("0.01"))).to.be.revertedWith(
      "APP_AUTH_FAILED",
    );

    await lido.connect(agent).setStakingLimit(ether("1"), ether("0.01"));
  });

  it("Should return correct staking limit after setting", async () => {
    const limit = ether("1");

    await lido.connect(agent).setStakingLimit(limit, ether("0.01"));
    expect(await lido.getCurrentStakeLimit()).to.equal(limit);
  });

  it("Should not allow zero max stake limit", async () => {
    await expect(lido.connect(agent).setStakingLimit(0, 0)).to.be.revertedWith("ZERO_MAX_STAKE_LIMIT");
  });

  it("Should not allow max stake limit above uint256", async () => {
    const maxUint256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

    await expect(lido.connect(agent).setStakingLimit(maxUint256, maxUint256)).to.be.revertedWith(
      "TOO_LARGE_MAX_STAKE_LIMIT",
    );
  });

  it("Should prevent staking above limit", async () => {
    await lido.connect(agent).setStakingLimit(ether("1"), ether("0.01"));

    await expect(lido.connect(stranger).submit(ethers.ZeroAddress, { value: ether("10") })).to.be.revertedWith(
      "STAKE_LIMIT",
    );
  });

  it("Should only allow authorized accounts to remove staking limit", async () => {
    await expect(lido.connect(stranger).removeStakingLimit()).to.be.revertedWith("APP_AUTH_FAILED");

    await lido.connect(agent).removeStakingLimit();
  });

  it("Should allow staking above limit after removal", async () => {
    await lido.connect(agent).setStakingLimit(ether("1"), ether("0.01"));
    await lido.connect(agent).removeStakingLimit();

    await lido.connect(stranger).submit(ethers.ZeroAddress, { value: ether("10") });
  });

  it("Should prevent staking when protocol is stopped", async () => {
    await lido.connect(agent).stop();

    await expect(lido.connect(stranger).submit(ethers.ZeroAddress, { value: ether("1") })).to.be.revertedWith(
      "STAKING_PAUSED",
    );

    await lido.connect(agent).resume();
  });

  it("Should mint correct stETH amount when staking", async () => {
    const stakeAmount = ether("1");

    const balanceBefore = await lido.balanceOf(stranger.address);
    await lido.connect(stranger).submit(ethers.ZeroAddress, { value: stakeAmount });
    const balanceAfter = await lido.balanceOf(stranger.address);

    expect(balanceAfter - balanceBefore).to.be.gte(stakeAmount - 2n);
  });

  const testCases = [
    { maxLimit: 10n ** 6n, limitPerBlock: 10n ** 4n },
    { maxLimit: 10n ** 12n, limitPerBlock: 10n ** 10n },
    { maxLimit: 10n ** 18n, limitPerBlock: 10n ** 16n },
  ];

  for (const { maxLimit, limitPerBlock } of testCases) {
    it(`Should update staking limits correctly with max=${maxLimit}, perBlock=${limitPerBlock}`, async () => {
      const localSnapshot = await Snapshot.take();

      // Set staking limit
      await lido.connect(agent).setStakingLimit(maxLimit, limitPerBlock);

      // Get initial stake limit
      const stakingLimitBefore = await lido.getCurrentStakeLimit();
      expect(stakingLimitBefore).to.equal(maxLimit);

      // Submit stake
      await lido.connect(stranger).submit(ethers.ZeroAddress, { value: limitPerBlock });

      // Check limit decreased by submitted amount
      const stakingLimitAfterSubmit = await lido.getCurrentStakeLimit();
      expect(stakingLimitAfterSubmit).to.equal(stakingLimitBefore - limitPerBlock);

      await mine(1);

      // Check limit restored to max
      const stakingLimitAfterBlock = await lido.getCurrentStakeLimit();
      expect(stakingLimitAfterBlock).to.equal(stakingLimitBefore);

      await Snapshot.restore(localSnapshot);
    });
  }

  context("Staking limit events", () => {
    it("Should emit correct event when setting staking limit", async () => {
      const maxLimit = ether("1000");
      const limitPerBlock = ether("100");

      await expect(lido.connect(agent).setStakingLimit(maxLimit, limitPerBlock))
        .to.emit(lido, "StakingLimitSet")
        .withArgs(maxLimit, limitPerBlock);

      const info = await lido.getStakeLimitFullInfo();
      expect(info.isStakingLimitSet).to.be.true;
    });

    it("Should emit correct event when changing staking limit", async () => {
      const initialMax = ether("1000");
      const initialPerBlock = ether("100");
      await lido.connect(agent).setStakingLimit(initialMax, initialPerBlock);

      const newMax = ether("2000");
      const newPerBlock = ether("200");
      await expect(lido.connect(agent).setStakingLimit(newMax, newPerBlock))
        .to.emit(lido, "StakingLimitSet")
        .withArgs(newMax, newPerBlock);

      const info = await lido.getStakeLimitFullInfo();
      expect(info.isStakingLimitSet).to.be.true;
    });

    it("Should emit correct event when removing staking limit", async () => {
      const maxLimit = ether("1000");
      const limitPerBlock = ether("100");
      await lido.connect(agent).setStakingLimit(maxLimit, limitPerBlock);

      await expect(lido.connect(agent).removeStakingLimit()).to.emit(lido, "StakingLimitRemoved");

      const info = await lido.getStakeLimitFullInfo();
      expect(info.isStakingLimitSet).to.be.false;
    });
  });
});
