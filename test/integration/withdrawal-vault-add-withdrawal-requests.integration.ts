// ToDo: add integration tests for the withdrawal vault
import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { WithdrawalVault } from "typechain-types";

import { EIP7002_ADDRESS, ether } from "lib";
import { impersonate } from "lib/account";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { encodeEIP7002Payload } from "test/0.8.9/withdrawalVault/eip7002Mock";
import { Snapshot } from "test/suite";

describe("Integration: WithdrawalVault: addWithdrawalRequests", () => {
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
    const withdrawalFee = await withdrawalVault.getWithdrawalRequestFee();
    const totalFee = withdrawalFee * BigInt(PUBKEYS.length);
    const tx = await withdrawalVault.connect(gateway).addWithdrawalRequests(PUBKEYS, AMOUNTS, { value: totalFee });
    await expect(tx)
      .to.emit(withdrawalVault, "WithdrawalRequestAdded")
      .withArgs(encodeEIP7002Payload(PUBKEYS[0], AMOUNTS[0]))
      .and.to.emit(withdrawalVault, "WithdrawalRequestAdded")
      .withArgs(encodeEIP7002Payload(PUBKEYS[1], AMOUNTS[1]));

    // Anvil processes the EIP-7002 queue at block end, before a post-mining
    // eth_call can inspect it. The native predeploy's anonymous logs record the
    // accepted requests: sender[20] ++ pubkey[48] ++ amount[8, big-endian].
    const receipt = await tx.wait();
    const requests = receipt!.logs.filter((log) => log.address.toLowerCase() === EIP7002_ADDRESS.toLowerCase());
    expect(requests.map((log) => log.topics)).to.deep.equal(PUBKEYS.map(() => []));
    expect(requests).to.have.length(PUBKEYS.length);
    requests.forEach((log, i) => {
      const data = Buffer.from(log.data.slice(2), "hex");
      expect(data.length).to.equal(76);
      expect(ethers.getAddress("0x" + data.subarray(0, 20).toString("hex"))).to.equal(withdrawalVaultAddress);
      expect("0x" + data.subarray(20, 68).toString("hex")).to.equal(PUBKEYS[i]);
      expect(data.readBigUInt64BE(68)).to.equal(AMOUNTS[i]);
    });
  });
});
