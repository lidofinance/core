import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import { seedReserve, setupVault, VaultFixture } from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const REDEEM_AMOUNT = ether("1");

describe("Integration: Redeems reserve — redeem blocked states", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder] = await ethers.getSigners();
    reserveManager = holder;

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }

    fix = await setupVault(ctx, reserveManager);
  });

  beforeEach(async () => {
    await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    testSnapshot = await Snapshot.take();

    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("reverts redeem with LidoStopped when the protocol is stopped", async () => {
    const { lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");

    await lido.connect(agent).stop();
    expect(await lido.isStopped()).to.equal(true);

    await lido.connect(holder).approve(fix.address, REDEEM_AMOUNT + 10n, { gasPrice: 0 });
    await expect(
      fix.vault.connect(holder).redeem(REDEEM_AMOUNT, holder.address, { gasPrice: 0 }),
    ).to.be.revertedWithCustomError(fix.vault, "LidoStopped");
  });

  it("resumes redeems after the protocol is resumed", async () => {
    const { lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");

    await lido.connect(agent).stop();
    await lido.connect(agent).resume();
    expect(await lido.isStopped()).to.equal(false);

    await lido.connect(holder).approve(fix.address, REDEEM_AMOUNT + 10n, { gasPrice: 0 });
    await expect(fix.vault.connect(holder).redeem(REDEEM_AMOUNT, holder.address, { gasPrice: 0 })).to.emit(
      fix.vault,
      "Redeemed",
    );
  });

  it("reverts redeem with WithdrawalQueuePaused when the WQ is paused", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const agentSigner = await impersonate(agent.address, ether("1"));

    const pauseRole = await withdrawalQueue.PAUSE_ROLE();
    if (!(await withdrawalQueue.hasRole(pauseRole, agent.address))) {
      const adminRole = await withdrawalQueue.DEFAULT_ADMIN_ROLE();
      const adminHolder = await withdrawalQueue.getRoleMember(adminRole, 0);
      const adminSigner = await impersonate(adminHolder, ether("1"));
      await withdrawalQueue.connect(adminSigner).grantRole(pauseRole, agent.address);
    }

    await withdrawalQueue.connect(agentSigner).pauseFor(1_000n);
    expect(await withdrawalQueue.isPaused()).to.equal(true);

    await lido.connect(holder).approve(fix.address, REDEEM_AMOUNT + 10n, { gasPrice: 0 });
    await expect(
      fix.vault.connect(holder).redeem(REDEEM_AMOUNT, holder.address, { gasPrice: 0 }),
    ).to.be.revertedWithCustomError(fix.vault, "WithdrawalQueuePaused");
  });
});
