import { expect } from "chai";
import { ethers } from "hardhat";

import { BEACON_ROOTS_ADDRESS, ensureEIP4788BeaconBlockRootContractPresent, updateBeaconBlockRoot } from "lib";
import { prepareLocalMerkleTree } from "lib/pdg";

import { resetState } from "test/suite";

describe("Beacon root fixtures", function () {
  resetState(this);

  before(async () => {
    await ensureEIP4788BeaconBlockRootContractPresent();
  });

  it("preserves committed roots across subsequent transactions and root commits", async () => {
    const firstRoot = ethers.id("first fixture root");
    const firstTimestamp = await updateBeaconBlockRoot(firstRoot);
    const [signer] = await ethers.getSigners();
    await (await signer.sendTransaction({ to: signer.address })).wait();

    const secondRoot = ethers.id("second fixture root");
    const secondTimestamp = await updateBeaconBlockRoot(secondRoot);
    expect(secondTimestamp).to.be.greaterThan(firstTimestamp);

    for (const [timestamp, root] of [
      [firstTimestamp, firstRoot],
      [secondTimestamp, secondRoot],
    ] as const) {
      expect(await ethers.provider.call({ to: BEACON_ROOTS_ADDRESS, data: ethers.toBeHex(timestamp, 32) })).to.equal(
        root,
      );
    }
  });

  it("only mines the extra preservation block on Anvil", async () => {
    const before = await ethers.provider.getBlockNumber();
    const timestamp = await updateBeaconBlockRoot(ethers.id("block-count fixture"));
    const after = await ethers.provider.getBlock("latest");
    const client: string = await ethers.provider.send("web3_clientVersion", []);
    const anvil = client.toLowerCase().includes("anvil");
    expect(after!.number - before).to.equal(anvil ? 2 : 1);
    expect(after!.timestamp).to.equal(timestamp + (anvil ? 1 : 0));
  });

  it("returns a mined SSZ tree and confirms added validators before building proofs", async () => {
    const tree = await prepareLocalMerkleTree();
    const count = await tree.sszMerkleTree.leafCount();
    await tree.addValidator(tree.validatorAtIndex(0));
    expect(await tree.sszMerkleTree.leafCount()).to.equal(count + 1n);
    const { beaconBlockHeader } = await tree.commitChangesToBeaconRoot();
    expect(await tree.buildProof(1, beaconBlockHeader)).not.to.be.empty;
  });
});
