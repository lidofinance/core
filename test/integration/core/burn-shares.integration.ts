import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, impersonate, log } from "lib";
import { getProtocolContext, handleOracleReport, ProtocolContext } from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

describe("Scenario: Burn Shares", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let stranger: HardhatEthersSigner;

  const amount = ether("1");
  let sharesToBurn: bigint;
  let internalEth: bigint;
  let internalShares: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    [stranger] = await ethers.getSigners();

    snapshot = await Snapshot.take();
  });

  beforeEach(bailOnFailure);

  after(async () => await Snapshot.restore(snapshot));

  it("Should allow stranger to submit ETH", async () => {
    const { lido } = ctx.contracts;

    await lido.connect(stranger).submit(ZeroAddress, { value: amount });

    const stEthBefore = await lido.balanceOf(stranger.address);
    expect(stEthBefore).to.be.approximately(amount, 10n, "Incorrect stETH balance after submit");

    sharesToBurn = await lido.sharesOf(stranger.address);
    internalEth = (await lido.totalSupply()) - (await lido.getExternalEther());
    internalShares = (await lido.getTotalShares()) - (await lido.getExternalShares());

    log.debug("Shares state before", {
      "Stranger shares": sharesToBurn,
      "Total ETH": ethers.formatEther(internalEth),
      "Total shares": internalShares,
    });
  });

  it("Should not allow stranger to burn shares", async () => {
    const { burner } = ctx.contracts;
    const burnTx = burner.connect(stranger).commitSharesToBurn(sharesToBurn);

    await expect(burnTx).to.be.revertedWithCustomError(burner, "AppAuthFailed");
  });

  it("Should burn shares after report", async () => {
    const { lido, burner, accounting } = ctx.contracts;

    await lido.connect(stranger).approve(burner.address, ether("1000000"));

    const accountingSigner = await impersonate(accounting.address, ether("1"));
    await burner.connect(accountingSigner).requestBurnSharesForCover(stranger, sharesToBurn);

    const { beaconValidators, beaconBalance } = await lido.getBeaconStat();

    await handleOracleReport(ctx, {
      beaconValidators,
      clBalance: beaconBalance,
      sharesRequestedToBurn: sharesToBurn,
      withdrawalVaultBalance: 0n,
      elRewardsVaultBalance: 0n,
      vaultsDataTreeRoot: ethers.ZeroHash,
      vaultsDataTreeCid: "",
    });

    const sharesToBurnAfter = await lido.sharesOf(stranger.address);
    const internalEthAfter = (await lido.totalSupply()) - (await lido.getExternalEther());
    const internalSharesAfter = (await lido.getTotalShares()) - (await lido.getExternalShares());

    log.debug("Shares state after", {
      "Stranger shares": sharesToBurnAfter,
      "Total ETH": ethers.formatEther(internalEthAfter),
      "Total shares": internalSharesAfter,
    });

    expect(sharesToBurnAfter).to.equal(0n, "Incorrect shares balance after burn");
    expect(internalEthAfter).to.equal(internalEth, "Incorrect total ETH supply after burn");
    expect(internalSharesAfter).to.equal(internalShares - sharesToBurn, "Incorrect total shares after burn");
  });
});
