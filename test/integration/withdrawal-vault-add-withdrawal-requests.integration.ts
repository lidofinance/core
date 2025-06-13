// ToDo: add integration tests for the withdrawal vault
import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { WithdrawalVault } from "typechain-types";

import { ether, readWithdrawalRequests } from "lib";
import { impersonate } from "lib/account";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { encodeEIP7002Payload } from "test/0.8.9/withdrawalVault/eip7002Mock";
import { Snapshot } from "test/suite";

// TODO: enable when upgrade for TW will enable
describe.skip("WithdrawalVault: addWithdrawalRequests Integration", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let withdrawalVault: WithdrawalVault;
  let withdrawalVaultAddress: string;
  let stranger: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  let gateway: HardhatEthersSigner;

  // Example 48-byte pubkeys
  const PUBKEYS = ["0x" + "aa".repeat(48), "0x" + "bb".repeat(48)];
  const AMOUNTS = [0n, 123456n];

  before(async () => {
    snapshot = await Snapshot.take();

    ctx = await getProtocolContext();
    [, stranger] = await ethers.getSigners();
    withdrawalVault = ctx.contracts.withdrawalVault;
    withdrawalVaultAddress = await withdrawalVault.getAddress();
    gateway = await impersonate(await ctx.contracts.triggerableWithdrawalsGateway.getAddress(), ether("100"));
  });

  after(async () => await Snapshot.restore(snapshot));

  it("should revert if called by non-gateway", async () => {
    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    await expect(
      withdrawalVault
        .connect(stranger)
        .addWithdrawalRequests(PUBKEYS, AMOUNTS, { value: withdrawalFee * BigInt(PUBKEYS.length) }),
    ).to.be.revertedWithCustomError(withdrawalVault, "NotTriggerableWithdrawalsGateway");
  });

  it("should revert on empty pubkeys array", async () => {
    await expect(
      withdrawalVault.connect(gateway).addWithdrawalRequests([], [], { value: 0 }),
    ).to.be.revertedWithCustomError(withdrawalVault, "ZeroArgument");
  });

  it("should revert on mismatched pubkeys/amounts length", async () => {
    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    await expect(
      withdrawalVault.connect(gateway).addWithdrawalRequests([PUBKEYS[0]], AMOUNTS, { value: withdrawalFee }),
    ).to.be.revertedWithCustomError(withdrawalVault, "ArraysLengthMismatch");
  });

  it("should revert on incorrect fee", async () => {
    await expect(
      withdrawalVault.connect(gateway).addWithdrawalRequests(PUBKEYS, AMOUNTS, { value: 0 }),
    ).to.be.revertedWithCustomError(withdrawalVault, "IncorrectFee");
  });

  it("should emit WithdrawalRequestAdded for each request", async () => {
    //Clear any existing withdrawal requests before adding new ones
    while ((await readWithdrawalRequests()).length > 0) {
      /* empty */
    }

    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    const totalFee = withdrawalFee * BigInt(PUBKEYS.length);
    await expect(withdrawalVault.connect(gateway).addWithdrawalRequests(PUBKEYS, AMOUNTS, { value: totalFee }))
      .to.emit(withdrawalVault, "WithdrawalRequestAdded")
      .withArgs(encodeEIP7002Payload(PUBKEYS[0], AMOUNTS[0]))
      .and.to.emit(withdrawalVault, "WithdrawalRequestAdded")
      .withArgs(encodeEIP7002Payload(PUBKEYS[1], AMOUNTS[1]));

    const requests = await readWithdrawalRequests();
    expect(requests.length).to.equal(PUBKEYS.length);

    expect(requests[0].address.toLocaleLowerCase()).to.equal(withdrawalVaultAddress.toLocaleLowerCase());
    expect(requests[0].pubkey).to.equal(PUBKEYS[0]);
    expect(requests[0].amount).to.equal(AMOUNTS[0]);

    expect(requests[1].address.toLocaleLowerCase()).to.equal(withdrawalVaultAddress.toLocaleLowerCase());
    expect(requests[1].pubkey).to.equal(PUBKEYS[1]);
    expect(requests[1].amount).to.equal(AMOUNTS[1]);

    expect((await readWithdrawalRequests()).length).to.equal(0);
  });
});
