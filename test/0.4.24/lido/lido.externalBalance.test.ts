import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Lido, LidoLocator } from "typechain-types";

import { ether, impersonate, MAX_UINT256 } from "lib";

import { deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

const TOTAL_BASIS_POINTS = 10000n;

describe("Lido.sol:externalBalance", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let whale: HardhatEthersSigner;
  let accountingSigner: HardhatEthersSigner;

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

    accountingSigner = await impersonate(await locator.accounting(), ether("1"));

    // Add some ether to the protocol
    await lido.connect(whale).submit(ZeroAddress, { value: 1000n });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getMaxExternalBalanceBP", () => {
    it("Returns the correct value", async () => {
      expect(await lido.getMaxExternalBalanceBP()).to.equal(0n);
    });
  });

  context("setMaxExternalBalanceBP", () => {
    context("Reverts", () => {
      it("if caller is not authorized", async () => {
        await expect(lido.connect(whale).setMaxExternalBalanceBP(1)).to.be.revertedWith("APP_AUTH_FAILED");
      });

      it("if max external balance is greater than total basis points", async () => {
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

    it("Accepts max external balance of 0", async () => {
      await expect(lido.setMaxExternalBalanceBP(0n)).to.not.be.reverted;
    });

    it("Sets to max allowed value", async () => {
      await expect(lido.setMaxExternalBalanceBP(TOTAL_BASIS_POINTS)).to.not.be.reverted;

      expect(await lido.getMaxExternalBalanceBP()).to.equal(TOTAL_BASIS_POINTS);
    });
  });

  context("getExternalEther", () => {
    it("Returns the external ether value", async () => {
      await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);

      // Add some external ether to protocol
      const amountToMint = (await lido.getMaxAvailableExternalBalance()) - 1n;

      await lido.connect(accountingSigner).mintExternalShares(whale, amountToMint);

      expect(await lido.getExternalEther()).to.equal(amountToMint);
    });

    it("Returns zero when no external ether", async () => {
      expect(await lido.getExternalEther()).to.equal(0n);
    });
  });

  context("getMaxAvailableExternalBalance", () => {
    beforeEach(async () => {
      // Increase the external ether limit to 10%
      await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);
    });

    it("Returns the correct value", async () => {
      const expectedMaxExternalEther = await getExpectedMaxAvailableExternalBalance();

      expect(await lido.getMaxAvailableExternalBalance()).to.equal(expectedMaxExternalEther);
    });

    it("Returns zero after minting max available amount", async () => {
      const amountToMint = await lido.getMaxAvailableExternalBalance();

      await lido.connect(accountingSigner).mintExternalShares(whale, amountToMint);

      expect(await lido.getMaxAvailableExternalBalance()).to.equal(0n);
    });

    it("Returns zero when max external balance is set to zero", async () => {
      await lido.setMaxExternalBalanceBP(0n);

      expect(await lido.getMaxAvailableExternalBalance()).to.equal(0n);
    });

    it("Returns MAX_UINT256 when max external balance is set to 100%", async () => {
      await lido.setMaxExternalBalanceBP(TOTAL_BASIS_POINTS);

      expect(await lido.getMaxAvailableExternalBalance()).to.equal(MAX_UINT256);
    });

    it("Increases when total pooled ether increases", async () => {
      const initialMax = await lido.getMaxAvailableExternalBalance();

      // Add more ether to increase total pooled
      await lido.connect(whale).submit(ZeroAddress, { value: ether("10") });

      const newMax = await lido.getMaxAvailableExternalBalance();

      expect(newMax).to.be.gt(initialMax);
    });
  });

  context("mintExternalShares", () => {
    context("Reverts", () => {
      it("if receiver is zero address", async () => {
        await expect(lido.mintExternalShares(ZeroAddress, 1n)).to.be.revertedWith("MINT_RECEIVER_ZERO_ADDRESS");
      });

      it("if amount of shares is zero", async () => {
        await expect(lido.mintExternalShares(whale, 0n)).to.be.revertedWith("MINT_ZERO_AMOUNT_OF_SHARES");
      });

      // TODO: update the code and this test
      it("if staking is paused", async () => {
        await lido.pauseStaking();

        await expect(lido.mintExternalShares(whale, 1n)).to.be.revertedWith("STAKING_PAUSED");
      });

      it("if not authorized", async () => {
        // Increase the external ether limit to 10%
        await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);

        await expect(lido.connect(user).mintExternalShares(whale, 1n)).to.be.revertedWith("APP_AUTH_FAILED");
      });

      it("if amount exceeds limit for external ether", async () => {
        await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);
        const maxAvailable = await lido.getMaxAvailableExternalBalance();

        await expect(lido.connect(accountingSigner).mintExternalShares(whale, maxAvailable + 1n)).to.be.revertedWith(
          "EXTERNAL_BALANCE_LIMIT_EXCEEDED",
        );
      });
    });

    it("Mints shares correctly and emits events", async () => {
      // Increase the external ether limit to 10%
      await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);

      const amountToMint = await lido.getMaxAvailableExternalBalance();

      await expect(lido.connect(accountingSigner).mintExternalShares(whale, amountToMint))
        .to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, whale, amountToMint)
        .to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, whale, amountToMint)
        .to.emit(lido, "ExternalSharesMinted")
        .withArgs(whale, amountToMint, amountToMint);

      // Verify external balance was increased
      const externalEther = await lido.getExternalEther();
      expect(externalEther).to.equal(amountToMint);
    });
  });

  context("burnExternalShares", () => {
    context("Reverts", () => {
      it("if amount of shares is zero", async () => {
        await expect(lido.burnExternalShares(0n)).to.be.revertedWith("BURN_ZERO_AMOUNT_OF_SHARES");
      });

      it("if not authorized", async () => {
        await expect(lido.connect(user).burnExternalShares(1n)).to.be.revertedWith("APP_AUTH_FAILED");
      });

      it("if external balance is too small", async () => {
        await expect(lido.connect(accountingSigner).burnExternalShares(1n)).to.be.revertedWith("EXT_BALANCE_TOO_SMALL");
      });

      it("if trying to burn more than minted", async () => {
        await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);

        const amount = 100n;
        await lido.connect(accountingSigner).mintExternalShares(whale, amount);

        await expect(lido.connect(accountingSigner).burnExternalShares(amount + 1n)).to.be.revertedWith(
          "EXT_BALANCE_TOO_SMALL",
        );
      });
    });

    it("Burns shares correctly and emits events", async () => {
      // First mint some external shares
      await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);
      const amountToMint = await lido.getMaxAvailableExternalBalance();

      await lido.connect(accountingSigner).mintExternalShares(accountingSigner.address, amountToMint);

      // Now burn them
      const stethAmount = await lido.getPooledEthByShares(amountToMint);

      await expect(lido.connect(accountingSigner).burnExternalShares(amountToMint))
        .to.emit(lido, "Transfer")
        .withArgs(accountingSigner.address, ZeroAddress, stethAmount)
        .to.emit(lido, "TransferShares")
        .withArgs(accountingSigner.address, ZeroAddress, amountToMint)
        .to.emit(lido, "ExternalSharesBurned")
        .withArgs(accountingSigner.address, amountToMint, stethAmount);

      // Verify external balance was reduced
      const externalEther = await lido.getExternalEther();
      expect(externalEther).to.equal(0n);
    });

    it("Burns shares partially and after multiple mints", async () => {
      await lido.setMaxExternalBalanceBP(maxExternalBalanceBP);

      // Multiple mints
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner.address, 100n);
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner.address, 200n);

      // Burn partial amount
      await lido.connect(accountingSigner).burnExternalShares(150n);
      expect(await lido.getExternalEther()).to.equal(150n);

      // Burn remaining
      await lido.connect(accountingSigner).burnExternalShares(150n);
      expect(await lido.getExternalEther()).to.equal(0n);
    });
  });

  // Helpers

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
});