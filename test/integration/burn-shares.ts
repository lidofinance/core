import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, impersonate, log, trace } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { finalizeWithdrawalQueue, handleOracleReport } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

describe("Burn Shares", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let ethHolder: HardhatEthersSigner;
  let stEthHolder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const amount = ether("1");
  let sharesToBurn: bigint;
  let totalEth: bigint;
  let totalShares: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    [stEthHolder, ethHolder, stranger] = await ethers.getSigners();

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  it("Should finalize withdrawal queue", async () => {
    const { withdrawalQueue } = ctx.contracts;

    await finalizeWithdrawalQueue(ctx, stEthHolder, ethHolder);

    const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    const lastRequestId = await withdrawalQueue.getLastRequestId();

    expect(lastFinalizedRequestId).to.equal(lastRequestId);
  });

  it("Should allow stranger to submit ETH", async () => {
    const { lido } = ctx.contracts;

    const submitTx = await lido.connect(stranger).submit(ZeroAddress, { value: amount });
    await trace("lido.submit", submitTx);

    const stEthBefore = await lido.balanceOf(stranger.address);
    expect(stEthBefore).to.be.approximately(amount, 10n, "Incorrect stETH balance after submit");

    sharesToBurn = await lido.sharesOf(stranger.address);
    totalEth = await lido.totalSupply();
    totalShares = await lido.getTotalShares();

    log.debug("Shares state before", {
      "Stranger shares": sharesToBurn,
      "Total ETH": ethers.formatEther(totalEth),
      "Total shares": totalShares,
    });
  });

  it("Should not allow stranger to burn shares", async () => {
    const { burner } = ctx.contracts;
    const burnTx = burner.connect(stranger).commitSharesToBurn(sharesToBurn);

    await expect(burnTx).to.be.revertedWithCustomError(burner, "AppAuthLidoFailed");
  });

  it("Should burn shares after report", async () => {
    const { lido, burner } = ctx.contracts;

    const approveTx = await lido.connect(stranger).approve(burner.address, ether("1000000"));
    await trace("lido.approve", approveTx);

    const lidoSigner = await impersonate(lido.address);
    const burnTx = await burner.connect(lidoSigner).requestBurnSharesForCover(stranger, sharesToBurn);
    await trace("burner.requestBurnSharesForCover", burnTx);

    const { beaconValidators, beaconBalance } = await lido.getBeaconStat();

    await handleOracleReport(ctx, {
      beaconValidators,
      clBalance: beaconBalance,
      sharesRequestedToBurn: sharesToBurn,
      withdrawalVaultBalance: 0n,
      elRewardsVaultBalance: 0n,
    });

    const sharesToBurnAfter = await lido.sharesOf(stranger.address);
    const totalEthAfter = await lido.totalSupply();
    const totalSharesAfter = await lido.getTotalShares();

    log.debug("Shares state after", {
      "Stranger shares": sharesToBurnAfter,
      "Total ETH": ethers.formatEther(totalEthAfter),
      "Total shares": totalSharesAfter,
    });

    expect(sharesToBurnAfter).to.equal(0n, "Incorrect shares balance after burn");
    expect(totalEthAfter).to.equal(totalEth, "Incorrect total ETH supply after burn");
    expect(totalSharesAfter).to.equal(totalShares - sharesToBurn, "Incorrect total shares after burn");
  });
});
