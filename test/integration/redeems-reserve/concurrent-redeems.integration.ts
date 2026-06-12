import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  doReport,
  redeemExact,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT_PER_REDEEMER = ether("500");
const RATIO_BP = 500n;

describe("Integration: Redeems reserve — multiple REDEEMERs sharing the reserve", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let admin: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [admin, alice, bob, carol] = await ethers.getSigners();

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](admin.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(admin.address, lido.address, role);
    }

    fix = await setupVault(ctx, admin, [alice, bob, carol]);

    for (const signer of [alice, bob, carol]) {
      await lido.connect(signer).submit(ZeroAddress, { value: DEPOSIT_PER_REDEEMER });
    }
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

  it("three REDEEMERs split the reserve in the same frame; counters accumulate and reconcile on report", async () => {
    const { lido } = ctx.contracts;
    await seedReserve(ctx, alice, admin, { deposit: 0n, redeemsReserveRatioBP: RATIO_BP });

    const reserve = await lido.getRedeemsReserve();
    const slice = reserve / 5n;

    const bufferedBefore = await lido.getBufferedEther();
    const lidoBalanceBefore = await ethers.provider.getBalance(await lido.getAddress());

    await redeemExact(lido, alice, fix, slice);
    await redeemExact(lido, bob, fix, slice);
    await redeemExact(lido, carol, fix, slice);

    const aliceShares = await lido.getSharesByPooledEth(slice);
    const aliceEther = await lido.getPooledEthByShares(aliceShares);
    const bobShares = await lido.getSharesByPooledEth(slice);
    const bobEther = await lido.getPooledEthByShares(bobShares);
    const carolShares = await lido.getSharesByPooledEth(slice);
    const carolEther = await lido.getPooledEthByShares(carolShares);
    const totalRedeemedEther = aliceEther + bobEther + carolEther;
    const totalRedeemedShares = aliceShares + bobShares + carolShares;

    expect(await fix.vault.getRedeemed()).to.deep.equal([totalRedeemedEther, totalRedeemedShares]);
    expect(await fix.vault.getReserveBalance()).to.equal(reserve);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(reserve - totalRedeemedEther);
    expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
    expect(await ethers.provider.getBalance(await lido.getAddress())).to.equal(lidoBalanceBefore);

    await doReport(ctx);

    expect(await fix.vault.getRedeemed()).to.deep.equal([0n, 0n]);
    expect(await lido.getBufferedEther()).to.equal(bufferedBefore - totalRedeemedEther);
    await assertReserveAllocationInvariant(lido);
  });
});
