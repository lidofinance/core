import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Lido, LidoLocator } from "typechain-types";

import { advanceChainTime, ether, impersonate, MAX_UINT256 } from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";

import { deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Lido.sol:externalShares", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let whale: HardhatEthersSigner;
  let vaultHubSigner: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let locator: LidoLocator;

  let originalState: string;

  const maxExternalRatioBP = 1000n;

  before(async () => {
    [deployer, user, whale] = await ethers.getSigners();

    ({ lido, acl } = await deployLidoDao({ rootAccount: deployer, initialized: true }));

    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.STAKING_PAUSE_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);

    lido = lido.connect(user);

    await lido.resume();

    const locatorAddress = await lido.getLidoLocator();
    locator = await ethers.getContractAt("LidoLocator", locatorAddress, deployer);

    vaultHubSigner = await impersonate(await locator.vaultHub(), ether("1"));

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

  context("setMaxExternalRatioBP", () => {
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

      await lido.connect(vaultHubSigner).mintExternalShares(whale, amountToMint);

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

      await lido.connect(vaultHubSigner).mintExternalShares(whale, amountToMint);

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

    it("Returns zero when external shares exceed the max ratio threshold", async () => {
      const initialMaxShares = await lido.getMaxMintableExternalShares();
      await lido.connect(vaultHubSigner).mintExternalShares(whale, initialMaxShares);

      const lowerRatio = maxExternalRatioBP / 2n;
      await lido.setMaxExternalRatioBP(lowerRatio);

      expect(await lido.getMaxMintableExternalShares()).to.equal(0n);
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
      it("if amount of shares is zero", async () => {
        await expect(lido.connect(vaultHubSigner).mintExternalShares(whale, 0n)).to.be.revertedWith(
          "MINT_ZERO_AMOUNT_OF_SHARES",
        );
      });

      it("if not authorized", async () => {
        // Increase the external ether limit to 10%
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);

        await expect(lido.connect(user).mintExternalShares(whale, 1n)).to.be.revertedWith("APP_AUTH_FAILED");
      });

      it("if amount exceeds limit for external ether", async () => {
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);
        const maxAvailable = await lido.getMaxMintableExternalShares();

        await expect(lido.connect(vaultHubSigner).mintExternalShares(whale, maxAvailable + 1n)).to.be.revertedWith(
          "EXTERNAL_BALANCE_LIMIT_EXCEEDED",
        );
      });

      it("if protocol is stopped", async () => {
        await lido.stop();
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);

        await expect(lido.connect(vaultHubSigner).mintExternalShares(whale, 1n)).to.be.revertedWith(
          "CONTRACT_IS_STOPPED",
        );
      });

      it("if receiver is zero address", async () => {
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);
        await expect(lido.connect(vaultHubSigner).mintExternalShares(ZeroAddress, 1n)).to.be.revertedWith(
          "MINT_TO_ZERO_ADDR",
        );
      });

      it("if receiver is StETH token contract", async () => {
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);
        await expect(lido.connect(vaultHubSigner).mintExternalShares(lido, 1n)).to.be.revertedWith(
          "MINT_TO_STETH_CONTRACT",
        );
      });

      it("if minting would exceed staking limit", async () => {
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);
        await lido.setStakingLimit(10n, 1n);

        await expect(lido.connect(vaultHubSigner).mintExternalShares(whale, 11n)).to.be.revertedWith("STAKE_LIMIT");
      });

      it("reverts if staking is paused", async () => {
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);
        await lido.setStakingLimit(10n, 1n);
        await lido.pauseStaking();

        await expect(lido.connect(vaultHubSigner).mintExternalShares(whale, 11n)).to.be.revertedWith("STAKING_PAUSED");
      });
    });

    it("Mints shares correctly and emits events", async () => {
      // Increase the external ether limit to 10%
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);

      const sharesToMint = 1n;
      const etherToMint = await lido.getPooledEthByShares(sharesToMint);

      await expect(lido.connect(vaultHubSigner).mintExternalShares(whale, sharesToMint))
        .to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, whale, etherToMint)
        .to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, whale, sharesToMint)
        .to.emit(lido, "ExternalSharesMinted")
        .withArgs(whale, sharesToMint);

      // Verify external balance was increased
      const externalEther = await lido.getExternalEther();
      expect(externalEther).to.equal(etherToMint);
    });

    it("Mints maximum mintable external shares when already minted some", async () => {
      // Set the maximum external ratio to allow minting
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);

      const sharesToMintInitially = 12345n;
      await lido.connect(vaultHubSigner).mintExternalShares(whale, sharesToMintInitially);
      await expect(await lido.getExternalShares()).to.equal(sharesToMintInitially);

      // Get the maximum amount of external shares that can be minted
      const maxMintableShares = await lido.getMaxMintableExternalShares();

      // Mint the maximum amount of external shares
      const etherToMint = await lido.getPooledEthByShares(maxMintableShares);

      await expect(lido.connect(vaultHubSigner).mintExternalShares(whale, maxMintableShares))
        .to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, whale, etherToMint)
        .to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, whale, maxMintableShares)
        .to.emit(lido, "ExternalSharesMinted")
        .withArgs(whale, maxMintableShares);

      // Verify external balance was increased to the maximum mintable amount
      const initiallyMintedEther = await lido.getPooledEthByShares(sharesToMintInitially);
      const externalEther = await lido.getExternalEther();
      expect(externalEther).to.equal(initiallyMintedEther + etherToMint);
    });

    it("Decreases staking limit when minting", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
      await lido.setStakingLimit(ether("150"), ether("1"));

      const stakingLimitBefore = await lido.getCurrentStakeLimit();
      expect(stakingLimitBefore).to.equal(ether("150"));

      const sharesToMint = ether("1");
      const amountToMint = await lido.getPooledEthByShares(sharesToMint);
      await lido.connect(vaultHubSigner).mintExternalShares(whale, sharesToMint);

      const stakingLimitAfter = await lido.getCurrentStakeLimit();
      expect(stakingLimitAfter).to.equal(stakingLimitBefore - amountToMint);
    });

    it("Can decrease staking limit to 0", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
      await lido.setStakingLimit(10n, 0n); // 0 per block increase to make sure limit is 0 after external shares mint

      const stakingLimitBefore = await lido.getCurrentStakeLimit();
      expect(stakingLimitBefore).to.equal(10n);

      const amountToMint = 10n;
      const sharesToMint = await lido.getSharesByPooledEth(amountToMint);
      const expectedAmountToMint = await lido.getPooledEthByShares(sharesToMint);

      const difference = amountToMint - expectedAmountToMint;
      await lido.submit(ZeroAddress, { value: difference }); // to make staking limit 0 after external shares mint
      await lido.connect(vaultHubSigner).mintExternalShares(whale, sharesToMint);

      const stakingLimitAfter = await lido.getCurrentStakeLimit();
      expect(stakingLimitAfter).to.equal(0);
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
        await expect(lido.connect(vaultHubSigner).burnExternalShares(1n)).to.be.revertedWith("EXT_SHARES_TOO_SMALL");
      });

      it("if protocol is stopped", async () => {
        await lido.stop();

        await expect(lido.connect(vaultHubSigner).burnExternalShares(1n)).to.be.revertedWith("CONTRACT_IS_STOPPED");
      });

      it("if trying to burn more than minted", async () => {
        await lido.setMaxExternalRatioBP(maxExternalRatioBP);

        const amount = 100n;
        await lido.connect(vaultHubSigner).mintExternalShares(whale, amount);

        await expect(lido.connect(vaultHubSigner).burnExternalShares(amount + 1n)).to.be.revertedWith(
          "EXT_SHARES_TOO_SMALL",
        );
      });
    });

    it("Burns shares correctly and emits events", async () => {
      // First mint some external shares
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
      const amountToMint = await lido.getMaxMintableExternalShares();

      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, amountToMint);

      // Now burn them
      const stethAmount = await lido.getPooledEthByShares(amountToMint);

      await expect(lido.connect(vaultHubSigner).burnExternalShares(amountToMint))
        .to.emit(lido, "SharesBurnt")
        .withArgs(vaultHubSigner, stethAmount, stethAmount, amountToMint)
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(amountToMint);

      // Verify external balance was reduced
      const externalEther = await lido.getExternalEther();
      expect(externalEther).to.equal(0n);
    });

    it("Burns shares partially and after multiple mints", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);

      // Multiple mints
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, 100n);
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, 200n);

      // Burn partial amount
      await lido.connect(vaultHubSigner).burnExternalShares(150n);
      expect(await lido.getExternalShares()).to.equal(150n);

      // Burn remaining
      await lido.connect(vaultHubSigner).burnExternalShares(150n);
      expect(await lido.getExternalShares()).to.equal(0n);
    });

    it("Increases staking limit when burning", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
      await lido.setStakingLimit(10n, 10n);

      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, 1n);

      let limit = 9n;
      expect(await lido.getCurrentStakeLimit()).to.equal(limit);

      await lido.connect(vaultHubSigner).burnExternalShares(1n);
      limit += 1n; // for mining block with burning

      expect(await lido.getCurrentStakeLimit()).to.equal(limit + 1n);
    });

    it("Bypasses staking limit when burning more than staking limit", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, 5n);

      await lido.setStakingLimit(10n, 1n);
      expect(await lido.getCurrentStakeLimit()).to.equal(10n);

      const sharesToMint = 5n;
      const amountToMint = await lido.getPooledEthByShares(sharesToMint);
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, sharesToMint);

      let limit = 10n - amountToMint;
      expect(await lido.getCurrentStakeLimit()).to.equal(limit);

      const sharesToBurn = 10n;
      const amountToBurn = await lido.getPooledEthByShares(sharesToBurn);
      await lido.connect(vaultHubSigner).burnExternalShares(sharesToBurn);
      limit += 1n; // for mining block with burning

      expect(await lido.getCurrentStakeLimit()).to.equal(limit + amountToBurn);
    });

    it("Burns shares correctly when staking is paused", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
      await lido.setStakingLimit(ether("1500000"), ether("1000000"));

      const amountToMint = await lido.getMaxMintableExternalShares();
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, amountToMint);

      await lido.pauseStaking();

      await expect(lido.connect(vaultHubSigner).burnExternalShares(amountToMint))
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(amountToMint);
    });
  });

  context("rebalanceExternalEtherToInternal", () => {
    it("Reverts if amount of shares is zero", async () => {
      await expect(lido.connect(user).rebalanceExternalEtherToInternal(0n)).to.be.revertedWith("ZERO_VALUE");
    });

    it("Reverts if not authorized", async () => {
      await expect(lido.connect(user).rebalanceExternalEtherToInternal(0n, { value: 1n })).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Reverts if amount of ether is greater than minted shares", async () => {
      const amountETH = await lido.getPooledEthBySharesRoundUp(1n);
      const totalShares = await lido.getTotalShares();
      const totalPooledETH = await lido.getTotalPooledEther();
      const shares = (amountETH * totalShares) / totalPooledETH;
      await expect(
        lido.connect(vaultHubSigner).rebalanceExternalEtherToInternal(shares, { value: amountETH }),
      ).to.be.revertedWith("EXT_SHARES_TOO_SMALL");
    });

    it("Decreases external shares and increases the buffered ether", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);

      const amountToMint = await lido.getMaxMintableExternalShares();
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, amountToMint);

      const bufferedEtherBefore = await lido.getBufferedEther();

      const etherToRebalance = await lido.getPooledEthBySharesRoundUp(1n);
      const totalShares = await lido.getTotalShares();
      const totalPooledETH = await lido.getTotalPooledEther();
      const shares = (etherToRebalance * totalShares) / totalPooledETH;
      await lido.connect(vaultHubSigner).rebalanceExternalEtherToInternal(shares, {
        value: etherToRebalance,
      });

      expect(await lido.getExternalShares()).to.equal(amountToMint - 1n);
      expect(await lido.getBufferedEther()).to.equal(bufferedEtherBefore + etherToRebalance);
    });

    it("Reverts if amount of ether is less than required", async () => {
      const amountOfShares = 10n;
      const totalPooledETH = await lido.getTotalPooledEther();
      const totalShares = await lido.getTotalShares();
      const etherToRebalance = (amountOfShares * totalPooledETH - 1n) / totalShares + 1n; // roundUp
      await expect(
        lido.connect(vaultHubSigner).rebalanceExternalEtherToInternal(amountOfShares, {
          value: etherToRebalance - 1n, // less than required
        }),
      ).to.be.revertedWith("VALUE_SHARES_MISMATCH");
    });
  });

  context("Precision issues", () => {
    beforeEach(async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
    });

    it("Can mint and burn without precision loss", async () => {
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, 1n); // 1 wei
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, 1n); // 2 wei
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, 1n); // 3 wei
      await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, 1n); // 4 wei

      await expect(lido.connect(vaultHubSigner).burnExternalShares(4n)).not.to.be.reverted; // 4 * 1.5 = 6 wei
      expect(await lido.getExternalEther()).to.equal(0n);
      expect(await lido.getExternalShares()).to.equal(0n);
      expect(await lido.sharesOf(vaultHubSigner)).to.equal(0n);
    });

    it("Can mint and burn external shares without limit change after multiple loops", async () => {
      await lido.setMaxExternalRatioBP(maxExternalRatioBP);
      await lido.setStakingLimit(1000n, 100n);

      for (let i = 1n; i <= 500n; i++) {
        await lido.connect(vaultHubSigner).mintExternalShares(vaultHubSigner, i);
        await lido.connect(vaultHubSigner).burnExternalShares(i);
      }

      // need to mine a block to update the stake limit otherwise it will be 1000n + 100n (after burning)
      await advanceChainTime(1n);
      expect(await lido.getCurrentStakeLimit()).to.equal(1000n);
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
