import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Lido, LidoLocator } from "typechain-types";

import { ether, impersonate } from "lib";

import { deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

const TOTAL_BASIS_POINTS = 10000n;

// TODO: add tests for MintExternalShares / BurnExternalShares
describe("Lido.sol:externalBalance", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let whale: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let locator: LidoLocator;

  let originalState: string;

  const maxExternalBalanceBP = 1000n;

  before(async () => {
    [deployer, user, whale] = await ethers.getSigners();

    ({ lido, acl } = await deployLidoDao({ rootAccount: deployer, initialized: true }));

    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.STAKING_PAUSE_ROLE(), deployer);

    lido = lido.connect(user);

    await lido.resumeStaking();

    const locatorAddress = await lido.getLidoLocator();
    locator = await ethers.getContractAt("LidoLocator", locatorAddress, deployer);

    // Add some ether to the protocol
    await lido.connect(whale).submit(ZeroAddress, { value: 1000n });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getMaxExternalBalanceBP", () => {
    it("should return the correct value", async () => {
      expect(await lido.getMaxExternalBalanceBP()).to.equal(0n);
    });
  });

  context("setMaxExternalBalanceBP", () => {
    context("Revers", () => {
      it("if APP_AUTH_FAILED", async () => {
        await expect(lido.connect(deployer).setMaxExternalBalanceBP(1)).to.be.revertedWith("APP_AUTH_FAILED");
      });

      it("if INVALID_MAX_EXTERNAL_BALANCE", async () => {
        await expect(lido.setMaxExternalBalanceBP(TOTAL_BASIS_POINTS + 1n)).to.be.revertedWith(
          "INVALID_MAX_EXTERNAL_BALANCE",
        );
      });
    });

    it("Updates the value and emits `MaxExternalBalanceBPSet`", async () => {
      const newMaxExternalBalanceBP = 100n;

      await expect(lido.setMaxExternalBalanceBP(newMaxExternalBalanceBP))
        .to.emit(lido, "MaxExternalBalanceBPSet")
        .withArgs(newMaxExternalBalanceBP);

      expect(await lido.getMaxExternalBalanceBP()).to.equal(newMaxExternalBalanceBP);
    });
  });

  context("getExternalEther", () => {
    it("returns the external ether value", async () => {
      await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);

      // Add some external ether to protocol
      const amountToMint = (await lido.getMaxAvailableExternalBalance()) - 1n;
      const accountingSigner = await impersonate(await locator.accounting(), ether("1"));
      await lido.connect(accountingSigner).mintExternalShares(whale, amountToMint);

      expect(await lido.getExternalEther()).to.equal(amountToMint);
    });
  });

  context("getMaxAvailableExternalBalance", () => {
    beforeEach(async () => {
      // Increase the external ether limit to 10%
      await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);
    });

    /**
     * Calculates the maximum additional stETH that can be added to external balance without exceeding limits
     *
     * Invariant: (currentExternal + x) / (totalPooled + x) <= maxBP / TOTAL_BP
     * Formula: x <= (maxBP * totalPooled - currentExternal * TOTAL_BP) / (TOTAL_BP - maxBP)
     */
    async function getExpectedMaxAvailableExternalBalance() {
      const totalPooledEther = await lido.getTotalPooledEther();
      const externalEther = await lido.getExternalEther();

      return (
        (maxExternalBalanceBP * totalPooledEther - externalEther * TOTAL_BASIS_POINTS) /
        (TOTAL_BASIS_POINTS - maxExternalBalanceBP)
      );
    }

    it("returns the correct value", async () => {
      const expectedMaxExternalEther = await getExpectedMaxAvailableExternalBalance();

      expect(await lido.getMaxAvailableExternalBalance()).to.equal(expectedMaxExternalEther);
    });

    it("holds when external ether value changes", async () => {
      const expectedMaxExternalEtherBefore = await getExpectedMaxAvailableExternalBalance();

      expect(await lido.getMaxAvailableExternalBalance()).to.equal(expectedMaxExternalEtherBefore);

      // Add all available external ether to protocol
      const amountToMint = await lido.getMaxAvailableExternalBalance();
      const accountingSigner = await impersonate(await locator.accounting(), ether("1"));
      await lido.connect(accountingSigner).mintExternalShares(whale, amountToMint);

      const expectedMaxExternalEtherAfter = await getExpectedMaxAvailableExternalBalance();

      expect(expectedMaxExternalEtherAfter).to.equal(0n);
    });
  });
});
