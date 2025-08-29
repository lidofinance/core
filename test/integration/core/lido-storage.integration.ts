import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, streccak, updateBalance } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Lido storage slots after V3", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let stEthHolder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();

    [stEthHolder, stranger] = await ethers.getSigners();
    await updateBalance(stranger.address, ether("100000000"));
    await updateBalance(stEthHolder.address, ether("100000000"));

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  it("Should have old storage slots zeroed in V3", async () => {
    const lido = ctx.contracts.lido;

    const oldStorageSlots = {
      DEPOSITED_VALIDATORS_POSITION: streccak("lido.Lido.depositedValidators"),
      CL_VALIDATORS_POSITION: streccak("lido.Lido.beaconValidators"),
      CL_BALANCE_POSITION: streccak("lido.Lido.beaconBalance"),
      BUFFERED_ETHER_POSITION: streccak("lido.Lido.bufferedEther"),
      TOTAL_SHARES_POSITION: streccak("lido.StETH.totalShares"),
      LIDO_LOCATOR_POSITION: streccak("lido.Lido.lidoLocator"),
    };

    for (const [key, value] of Object.entries(oldStorageSlots)) {
      const storageValue = await ethers.provider.getStorage(lido, value);
      expect(storageValue).to.equal(0n, `${key} storage slot at ${value} is not empty`);
    }
  });
});
