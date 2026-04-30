import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { RedeemsBuffer } from "typechain-types";

import { ether, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { proxify } from "lib/proxy";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  assertReserveState,
  captureBufferState,
  captureState,
  doReport,
  installRedeemsBufferOnLido,
  redeemExact,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;

describe("Integration: RedeemsBuffer upgrade (drain via report + atomic swap)", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let extraHolder: HardhatEthersSigner;

  let oldFix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [admin, holder, extraHolder] = await ethers.getSigners();

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](admin.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(admin.address, lido.address, role);
    }

    oldFix = await setupVault(ctx, admin, [holder]);
  });

  beforeEach(async () => {
    await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  async function deployBuffer(): Promise<RedeemsBuffer> {
    const { lido, burner, withdrawalQueue, hashConsensus } = ctx.contracts;
    const factory = await ethers.getContractFactory("RedeemsBuffer");
    const impl = await factory
      .connect(admin)
      .deploy(await lido.getAddress(), await burner.getAddress(), await withdrawalQueue.getAddress(), await hashConsensus.getAddress());
    const [vault] = (await proxify({ impl, admin })) as [RedeemsBuffer, unknown];
    await vault.initialize(admin.address);
    return vault;
  }

  async function wireNewBufferRoles(vault: RedeemsBuffer) {
    const { burner } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    for (const role of [await vault.PAUSE_ROLE(), await vault.RESUME_ROLE(), await vault.RECOVER_ROLE()]) {
      await vault.connect(admin).grantRole(role, admin.address);
    }
    const redeemerRole = await vault.REDEEMER_ROLE();
    await vault.connect(admin).grantRole(redeemerRole, admin.address);
    await vault.connect(admin).grantRole(redeemerRole, holder.address);
    await burner.connect(agent).grantRole(await burner.REQUEST_BURN_SHARES_ROLE(), await vault.getAddress());
  }

  async function drainViaRatioZero() {
    await ctx.contracts.lido.connect(admin).setRedeemsReserveTargetRatio(0n);
    await doReport(ctx);
  }

  it("happy path: drain via ratio=0 report, then atomic swap to a new buffer", async () => {
    const { lido } = ctx.contracts;

    await seedReserve(ctx, holder, admin, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });
    assertReserveState(await captureState(lido), RATIO_BP);
    expect(await oldFix.vault.getReserveBalance()).to.equal(await lido.getRedeemsReserveTarget());

    await drainViaRatioZero();
    expect(await oldFix.vault.getReserveBalance()).to.equal(0n);
    expect(await oldFix.vault.getRedeemed()).to.deep.equal([0n, 0n]);

    const newVault = await deployBuffer();
    const newAddress = await newVault.getAddress();

    await expect(installRedeemsBufferOnLido(ctx, newAddress))
      .to.emit(lido, "RedeemsBufferSet")
      .withArgs(newAddress);

    expect(await lido.getRedeemsBuffer()).to.equal(newAddress);
    expect(await oldFix.vault.isPaused()).to.equal(true);
    expect(await ethers.provider.getBalance(oldFix.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(newAddress)).to.equal(0n);

    await wireNewBufferRoles(newVault);
    await lido.connect(admin).setRedeemsReserveTargetRatio(RATIO_BP);
    await doReport(ctx);

    const refilled = await lido.getRedeemsReserveTarget();
    expect(await lido.getRedeemsReserve()).to.equal(refilled);
    expect(await newVault.getReserveBalance()).to.equal(refilled);
    expect(await ethers.provider.getBalance(newAddress)).to.equal(refilled);

    await redeemExact(lido, holder, { vault: newVault, address: newAddress }, refilled / 4n);
    await assertReserveAllocationInvariant(lido);
  });

  it("setRedeemsBuffer reverts when the old buffer has non-zero reserve balance", async () => {
    await seedReserve(ctx, holder, admin, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });
    const reserve = await ctx.contracts.lido.getRedeemsReserve();

    await expect(installRedeemsBufferOnLido(ctx, ZeroAddress))
      .to.be.revertedWithCustomError(oldFix.vault, "BufferNotReconciled")
      .withArgs(reserve, 0n, 0n);
  });

  it("setRedeemsBuffer reverts when in-flight redeem snapshots are non-zero", async () => {
    const { lido } = ctx.contracts;
    await seedReserve(ctx, holder, admin, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });

    const reserve = await lido.getRedeemsReserve();
    const redeemAmount = reserve / 4n;
    const consumedShares = await lido.getSharesByPooledEth(redeemAmount);
    const consumedEther = await lido.getPooledEthByShares(consumedShares);
    await redeemExact(lido, holder, oldFix, redeemAmount);

    await expect(installRedeemsBufferOnLido(ctx, ZeroAddress))
      .to.be.revertedWithCustomError(oldFix.vault, "BufferNotReconciled")
      .withArgs(reserve, consumedEther, consumedShares);
  });

  it("disable: drained buffer detaches and the next report allocates the freed ETH normally", async () => {
    const { lido } = ctx.contracts;

    await seedReserve(ctx, holder, admin, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });
    assertReserveState(await captureState(lido), RATIO_BP);

    await drainViaRatioZero();

    const bufferedAtDisable = await lido.getBufferedEther();
    const lidoBalanceAtDisable = await ethers.provider.getBalance(await lido.getAddress());

    await installRedeemsBufferOnLido(ctx, ZeroAddress);

    expect(await lido.getRedeemsBuffer()).to.equal(ZeroAddress);
    expect(await oldFix.vault.isPaused()).to.equal(true);
    expect(await oldFix.vault.getReserveBalance()).to.equal(0n);
    expect(await ethers.provider.getBalance(oldFix.address)).to.equal(0n);
    expect(await lido.getBufferedEther()).to.equal(bufferedAtDisable);
    expect(await ethers.provider.getBalance(await lido.getAddress())).to.equal(lidoBalanceAtDisable);

    await doReport(ctx);

    const after = await captureBufferState(ctx);
    expect(after.reserve).to.equal(0n);
    expect(after.reserveTarget).to.equal(0n);
    expect(await ethers.provider.getBalance(oldFix.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(await lido.getAddress())).to.equal(after.buffered);
    await assertReserveAllocationInvariant(lido);
  });
});
