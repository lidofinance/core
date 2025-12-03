import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Lido } from "typechain-types";

import { ether, impersonate } from "lib";

import { deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Lido.sol:mintburning", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let accounting: HardhatEthersSigner;
  let burner: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let originalState: string;

  before(async () => {
    [deployer, user] = await ethers.getSigners();

    ({ lido, acl } = await deployLidoDao({ rootAccount: deployer, initialized: true }));
    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);

    const locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), user);

    accounting = await impersonate(await locator.accounting(), ether("100.0"));
    burner = await impersonate(await locator.burner(), ether("100.0"));

    lido = lido.connect(user);

    await lido.resume();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("mintShares", () => {
    it("Reverts when minter is not accounting", async () => {
      await expect(lido.mintShares(user, 1n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts when minting to zero address", async () => {
      await expect(lido.connect(accounting).mintShares(ZeroAddress, 1n)).to.be.revertedWith("MINT_TO_ZERO_ADDR");
    });

    it("if protocol is stopped", async () => {
      await lido.stop();

      await expect(lido.connect(accounting).mintShares(user, 1n)).to.be.revertedWith("CONTRACT_IS_STOPPED");
    });

    it("Mints shares to the recipient and fires the transfer events", async () => {
      await expect(lido.connect(accounting).mintShares(user, 1000n))
        .to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, user.address, 1000n)
        .to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, user.address, 999n);

      expect(await lido.sharesOf(user)).to.equal(1000n);
      expect(await lido.balanceOf(user)).to.equal(999n);
    });
  });

  context("burnShares", () => {
    it("Reverts when burner is not authorized", async () => {
      await expect(lido.burnShares(1n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Reverts when burning more than the owner owns", async () => {
      const sharesOfHolder = await lido.sharesOf(burner);

      await expect(lido.connect(burner).burnShares(sharesOfHolder + 1n)).to.be.revertedWith("BALANCE_EXCEEDED");
    });

    it("if protocol is stopped", async () => {
      await lido.stop();

      await expect(lido.connect(burner).burnShares(1n)).to.be.revertedWith("CONTRACT_IS_STOPPED");
    });

    it("Zero burn", async () => {
      const sharesOfHolder = await lido.sharesOf(burner);

      await expect(lido.connect(burner).burnShares(sharesOfHolder))
        .to.emit(lido, "SharesBurnt")
        .withArgs(burner.address, 0n, 0n, 0n);

      expect(await lido.sharesOf(burner)).to.equal(0n);
    });

    it("Burn shares from burner and emit SharesBurnt event", async () => {
      await lido.connect(accounting).mintShares(burner, 1000n);

      const sharesOfHolder = await lido.sharesOf(burner);

      await expect(lido.connect(burner).burnShares(sharesOfHolder))
        .to.emit(lido, "SharesBurnt")
        .withArgs(burner.address, await lido.getPooledEthByShares(1000n), 1000n, 1000n);

      expect(await lido.sharesOf(burner)).to.equal(0n);
    });
  });
});
