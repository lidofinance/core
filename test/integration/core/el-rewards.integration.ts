import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

describe("Scenario: EL rewards distribution", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let stranger: HardhatEthersSigner;

  const REWARD_AMOUNT = ether("1");

  before(async () => {
    ctx = await getProtocolContext();
    [stranger] = await ethers.getSigners();
    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  beforeEach(bailOnFailure);

  it("Should have correct initial values", async () => {
    const { lido, locator, elRewardsVault } = ctx.contracts;

    expect(await elRewardsVault.LIDO()).to.equal(lido.address);
    expect(await elRewardsVault.TREASURY()).to.equal(await locator.treasury());

    expect(await locator.elRewardsVault()).to.equal(elRewardsVault.address);
  });

  it("Should emit event when receiving ETH", async () => {
    const { elRewardsVault } = ctx.contracts;

    const balanceBefore = await ethers.provider.getBalance(elRewardsVault.address);

    const tx = await stranger.sendTransaction({
      to: elRewardsVault.address,
      value: REWARD_AMOUNT,
    });
    const receipt = (await tx.wait()) as ContractTransactionReceipt;

    const balanceAfter = await ethers.provider.getBalance(elRewardsVault.address);

    expect(balanceAfter - balanceBefore).to.equal(REWARD_AMOUNT);

    const ethReceivedEvent = ctx.getEvents(receipt, "ETHReceived")[0];
    expect(ethReceivedEvent?.args[0]).to.equal(REWARD_AMOUNT);
  });

  it("Should not allow stranger to receive EL rewards", async () => {
    const { lido, locator } = ctx.contracts;

    expect(await locator.elRewardsVault()).to.not.equal(stranger.address);
    await expect(lido.connect(stranger).receiveELRewards({ value: REWARD_AMOUNT })).to.be.reverted;
  });

  it("receiveELRewards called by EL Rewards Vault moves rewards to Lido", async () => {
    const { lido, elRewardsVault } = ctx.contracts;

    const vaultBalanceBefore = await ethers.provider.getBalance(elRewardsVault.address);
    await stranger.sendTransaction({
      to: elRewardsVault.address,
      value: REWARD_AMOUNT,
    });
    const vaultBalanceAfter = await ethers.provider.getBalance(elRewardsVault.address);
    expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(REWARD_AMOUNT);

    const lidoBalanceBefore = await ethers.provider.getBalance(lido.address);
    const totalRewardsCollectedBefore = await lido.getTotalELRewardsCollected();

    const elRewardsVaultSigner = await ethers.getImpersonatedSigner(elRewardsVault.address);
    const tx = await lido.connect(elRewardsVaultSigner).receiveELRewards({ value: REWARD_AMOUNT });
    const receipt = (await tx.wait()) as ContractTransactionReceipt;

    const elRewardsReceivedEvents = ctx.getEvents(receipt, "ELRewardsReceived");
    expect(elRewardsReceivedEvents).to.have.length(1);
    expect(elRewardsReceivedEvents[0].args[0]).to.equal(REWARD_AMOUNT);

    expect(await lido.getTotalELRewardsCollected()).to.equal(totalRewardsCollectedBefore + REWARD_AMOUNT);
    const elRewardsVaultBalanceAfter = await ethers.provider.getBalance(elRewardsVault.address);
    expect(elRewardsVaultBalanceAfter).to.equal(vaultBalanceAfter - REWARD_AMOUNT - receipt.gasUsed * receipt.gasPrice);
    expect(await ethers.provider.getBalance(lido.address)).to.equal(lidoBalanceBefore + REWARD_AMOUNT);
  });
});
