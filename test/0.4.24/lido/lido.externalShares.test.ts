import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Lido, LidoLocator } from "typechain-types";

import { ether, impersonate, MAX_UINT256 } from "lib";

import { deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

const TOTAL_BASIS_POINTS = 10000n;

describe("Lido.sol:externalShares", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let whale: HardhatEthersSigner;
  let accountingSigner: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let locator: LidoLocator;

  let originalState: string;

  const maxExternalRatioBP = 1000n;

  before(async () => {
    [deployer, user, whale] = await ethers.getSigners();

    ({ lido, acl } = await deployLidoDao({ rootAccount: deployer, initialized: true }));

    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);

    lido = lido.connect(user);

    await lido.resume();

    const locatorAddress = await lido.getLidoLocator();
    locator = await ethers.getContractAt("LidoLocator", locatorAddress, deployer);

    accountingSigner = await impersonate(await locator.accounting(), ether("1"));

    // Add some ether to the protocol
    await lido.connect(whale).submit(ZeroAddress, { value: ether("1000") });

    // Burn some shares to make share rate fractional
    const burner = await impersonate(await locator.burner(), ether("1"));
    await lido.connect(whale).transfer(burner, ether("500"));
    await lido.connect(burner).burnShares(ether("500"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getMaxExternalBalanceBP", () => {
    it("Returns the correct value", async () => {
      expect(await lido.getMaxExternalRatioBP()).to.equal(0n);
    });
  });

  context("setMaxExternalBalanceBP", () => {
    context("Reverts", () => {
      it("if caller is not authorized", async () => {
        await expect(lido.connect(whale).setMaxExternalRatioBP(1)).to.be.revertedWith("APP_AUTH_FAILED");
      });

      it("if max external ratio is greater than total basis points", async () => {
        await expect(lido.setMaxExternalRatioBP(TOTAL_BASIS_POINTS + 1n)).to.be.revertedWith(
          "INVALID_MAX_EXTERNAL_RATIO",
        );
      });
    });

    it("Updates the value and emits `MaxExternalRatioBPSet`", async () => {
      const newMaxExternalRatioBP = 100n;

      await expect(lido.setMaxExternalRatioBP(newMaxExternalRatioBP))
        .to.emit(lido, "MaxExternalRatioBPSet")
        .withArgs(newMaxExternalRatioBP);

      expect(await lido.getMaxExternalRatioBP()).to.equal(newMaxExternalRatioBP);
    });

    it("Accepts max external ratio of 0", async () => {
      await expect(lido.setMaxExternalRatioBP(0n)).to.not.be.reverted;
    });

    it("Sets to max allowed value", async () => {
      await expect(lido.setMaxExternalRatioBP(TOTAL_BASIS_POINTS)).to.not.be.reverted;

      expect(await lido.getMaxExternalRatioBP()).to.equal(TOTAL_BASIS_POINTS);
    });
  });

  context("getExternalEther", () => {
    it("Returns the external ether value", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);

      // Add some external ether to protocol
      const amountToMint = (await lido.getMaxMintableExternalShares()) - 1n;

      await lido.connect(accountingSigner).mintExternalShares(whale, amountToMint);

      expect(await lido.getExternalShares()).to.equal(amountToMint);
    });

    it("Returns zero when no external shares", async () => {
      expect(await lido.getExternalShares()).to.equal(0n);
    });
  });

  context("getMaxMintableExternalShares", () => {
    beforeEach(async () => {
      // Increase the external ether limit to 10%
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
    });

    it("Returns the correct value", async () => {
      const expectedMaxExternalShares = await getExpectedMaxMintableExternalShares();

      expect(await lido.getMaxMintableExternalShares()).to.equal(expectedMaxExternalShares);
    });

    it("Returns zero after minting max available amount", async () => {
      const amountToMint = await lido.getMaxMintableExternalShares();

      await lido.connect(accountingSigner).mintExternalShares(whale, amountToMint);

      expect(await lido.getMaxMintableExternalShares()).to.equal(0n);
    });

    it("Returns zero when max external ratio is set to zero", async () => {
      await lido.setMaxExternalRatioBP(0n);

      expect(await lido.getMaxMintableExternalShares()).to.equal(0n);
    });

    it("Returns MAX_UINT256 when max external ratio is set to 100%", async () => {
      await lido.setMaxExternalRatioBP(TOTAL_BASIS_POINTS);

      expect(await lido.getMaxMintableExternalShares()).to.equal(MAX_UINT256);
    });

    it("Increases when total pooled ether increases", async () => {
      const initialMax = await lido.getMaxMintableExternalShares();

      // Add more ether to increase total pooled
      await lido.connect(whale).submit(ZeroAddress, { value: ether("10") });

      const newMax = await lido.getMaxMintableExternalShares();

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

      it("if not authorized", async () => {
        // Increase the external ether limit to 10%
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);

        await expect(lido.connect(user).mintExternalShares(whale, 1n)).to.be.revertedWith("APP_AUTH_FAILED");
      });

      it("if amount exceeds limit for external ether", async () => {
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);
        const maxAvailable = await lido.getMaxMintableExternalShares();

        await expect(lido.connect(accountingSigner).mintExternalShares(whale, maxAvailable + 1n)).to.be.revertedWith(
          "EXTERNAL_BALANCE_LIMIT_EXCEEDED",
        );
      });

      it("if protocol is stopped", async () => {
        await lido.stop();
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);

        await expect(lido.connect(accountingSigner).mintExternalShares(whale, 1n)).to.be.revertedWith(
          "CONTRACT_IS_STOPPED",
        );
      });
    });

    it("Mints shares correctly and emits events", async () => {
      // Increase the external ether limit to 10%
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);

      const sharesToMint = 1n;
      const etherToMint = await lido.getPooledEthByShares(sharesToMint);

      await expect(lido.connect(accountingSigner).mintExternalShares(whale, sharesToMint))
        .to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, whale, etherToMint)
        .to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, whale, sharesToMint)
        .to.emit(lido, "ExternalSharesMinted")
        .withArgs(whale, sharesToMint, etherToMint);

      // Verify external balance was increased
      const externalEther = await lido.getExternalEther();
      expect(externalEther).to.equal(etherToMint);
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
        await expect(lido.connect(accountingSigner).burnExternalShares(1n)).to.be.revertedWith("EXT_SHARES_TOO_SMALL");
      });

      it("if protocol is stopped", async () => {
        await lido.stop();

        await expect(lido.connect(accountingSigner).burnExternalShares(1n)).to.be.revertedWith("CONTRACT_IS_STOPPED");
      });

      it("if trying to burn more than minted", async () => {
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);

        const amount = 100n;
        await lido.connect(accountingSigner).mintExternalShares(whale, amount);

        await expect(lido.connect(accountingSigner).burnExternalShares(amount + 1n)).to.be.revertedWith(
          "EXT_SHARES_TOO_SMALL",
        );
      });
    });

    it("Burns shares correctly and emits events", async () => {
      // First mint some external shares
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
      const amountToMint = await lido.getMaxMintableExternalShares();

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
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);

      // Multiple mints
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner.address, 100n);
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner.address, 200n);

      // Burn partial amount
      await lido.connect(accountingSigner).burnExternalShares(150n);
      expect(await lido.getExternalShares()).to.equal(150n);

      // Burn remaining
      await lido.connect(accountingSigner).burnExternalShares(150n);
      expect(await lido.getExternalShares()).to.equal(0n);
    });
  });

  context("rebalanceExternalEtherToInternal", () => {
    it("Reverts if amount of shares is zero", async () => {
      await expect(lido.connect(user).rebalanceExternalEtherToInternal()).to.be.revertedWith("ZERO_VALUE");
    });

    it("Reverts if not authorized", async () => {
      await expect(lido.connect(user).rebalanceExternalEtherToInternal({ value: 1n })).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Reverts if amount of ether is greater than minted shares", async () => {
      await expect(
        lido
          .connect(accountingSigner)
          .rebalanceExternalEtherToInternal({ value: await lido.getPooledEthBySharesRoundUp(1n) }),
      ).to.be.revertedWith("EXT_SHARES_TOO_SMALL");
    });

    it("Decreases external shares and increases the buffered ether", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);

      const amountToMint = await lido.getMaxMintableExternalShares();
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner.address, amountToMint);

      const bufferedEtherBefore = await lido.getBufferedEther();

      const etherToRebalance = await lido.getPooledEthBySharesRoundUp(1n);

      await lido.connect(accountingSigner).rebalanceExternalEtherToInternal({
        value: etherToRebalance,
      });

      expect(await lido.getExternalShares()).to.equal(amountToMint - 1n);
      expect(await lido.getBufferedEther()).to.equal(bufferedEtherBefore + etherToRebalance);
    });
  });

  context("Precision issues", () => {
    beforeEach(async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
    });

    it("Can mint and burn without precision loss", async () => {
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner, 1n); // 1 wei
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner, 1n); // 2 wei
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner, 1n); // 3 wei
      await lido.connect(accountingSigner).mintExternalShares(accountingSigner, 1n); // 4 wei

      await expect(lido.connect(accountingSigner).burnExternalShares(4n)).not.to.be.reverted; // 4 * 1.5 = 6 wei
      expect(await lido.getExternalEther()).to.equal(0n);
      expect(await lido.getExternalShares()).to.equal(0n);
      expect(await lido.sharesOf(accountingSigner)).to.equal(0n);
    });
  });

  // Helpers

  /**
   * Calculates the maximum additional stETH that can be added to external balance without exceeding limits
   *
   * Invariant: (currentExternal + x) / (totalPooled + x) <= maxBP / TOTAL_BP
   * Formula: x <= (maxBP * totalPooled - currentExternal * TOTAL_BP) / (TOTAL_BP - maxBP)
   */
  async function getExpectedMaxMintableExternalShares() {
    const totalShares = await lido.getTotalShares();
    const externalShares = await lido.getExternalShares();

    return (
      (totalShares * maxExternalRatioBP - externalShares * TOTAL_BASIS_POINTS) /
      (TOTAL_BASIS_POINTS - maxExternalRatioBP)
    );
  }
});
