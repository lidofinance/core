import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { StETH__HarnessForVaultHub, VaultHub } from "typechain-types";

import { ether, MAX_UINT256 } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultHub.sol:pausableUntil", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let vaultHub: VaultHub;
  let steth: StETH__HarnessForVaultHub;

  let originalState: string;

  before(async () => {
    [deployer, user, stranger] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [user], { value: ether("1.0") });

    const vaultHubImpl = await ethers.deployContract("Accounting", [locator]);
    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const accounting = await ethers.getContractAt("Accounting", proxy);
    await accounting.initialize(deployer);

    vaultHub = await ethers.getContractAt("Accounting", proxy, user);
    await accounting.grantRole(await vaultHub.PAUSE_ROLE(), user);
    await accounting.grantRole(await vaultHub.RESUME_ROLE(), user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constants", () => {
    it("Returns the PAUSE_INFINITELY variable", async () => {
      expect(await vaultHub.PAUSE_INFINITELY()).to.equal(MAX_UINT256);
    });
  });

  context("initialState", () => {
    it("isPaused returns false", async () => {
      expect(await vaultHub.isPaused()).to.equal(false);
    });

    it("getResumeSinceTimestamp returns 0", async () => {
      expect(await vaultHub.getResumeSinceTimestamp()).to.equal(0);
    });
  });

  context("pauseFor", () => {
    it("reverts if no PAUSE_ROLE", async () => {
      await expect(vaultHub.connect(stranger).pauseFor(1000n))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.PAUSE_ROLE());
    });

    it("reverts if zero pause duration", async () => {
      await expect(vaultHub.pauseFor(0n)).to.be.revertedWithCustomError(vaultHub, "ZeroPauseDuration");
    });

    it("reverts if paused", async () => {
      await expect(vaultHub.pauseFor(1000n)).to.emit(vaultHub, "Paused");

      await expect(vaultHub.pauseFor(1000n)).to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("emits Paused event and change state", async () => {
      await expect(vaultHub.pauseFor(1000n)).to.emit(vaultHub, "Paused").withArgs(1000n);

      expect(await vaultHub.isPaused()).to.equal(true);
      expect(await vaultHub.getResumeSinceTimestamp()).to.equal((await time.latest()) + 1000);
    });

    it("works for MAX_UINT256 duration", async () => {
      await expect(vaultHub.pauseFor(MAX_UINT256)).to.emit(vaultHub, "Paused").withArgs(MAX_UINT256);

      expect(await vaultHub.isPaused()).to.equal(true);
      expect(await vaultHub.getResumeSinceTimestamp()).to.equal(MAX_UINT256);
    });
  });

  context("pauseUntil", () => {
    it("reverts if no PAUSE_ROLE", async () => {
      await expect(vaultHub.connect(stranger).pauseUntil(1000n))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.PAUSE_ROLE());
    });

    it("reverts if timestamp is in the past", async () => {
      await expect(vaultHub.pauseUntil(0)).to.be.revertedWithCustomError(vaultHub, "PauseUntilMustBeInFuture");
    });

    it("emits Paused event and change state", async () => {
      const timestamp = await time.latest();

      await expect(vaultHub.pauseUntil(timestamp + 1000)).to.emit(vaultHub, "Paused");
      //  .withArgs(timestamp + 1000 - await time.latest()); // how to use last block timestamp in assertions

      expect(await vaultHub.isPaused()).to.equal(true);
      expect(await vaultHub.getResumeSinceTimestamp()).to.greaterThanOrEqual((await time.latest()) + 1000);
    });

    it("works for MAX_UINT256 timestamp", async () => {
      await expect(vaultHub.pauseUntil(MAX_UINT256)).to.emit(vaultHub, "Paused").withArgs(MAX_UINT256);

      expect(await vaultHub.isPaused()).to.equal(true);
      expect(await vaultHub.getResumeSinceTimestamp()).to.equal(MAX_UINT256);
    });
  });

  context("resume", () => {
    it("reverts if no RESUME_ROLE", async () => {
      await expect(vaultHub.connect(stranger).resume())
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.RESUME_ROLE());
    });

    it("reverts if not paused", async () => {
      await expect(vaultHub.resume()).to.be.revertedWithCustomError(vaultHub, "PausedExpected");
    });

    it("reverts if already resumed", async () => {
      await expect(vaultHub.pauseFor(1000n)).to.emit(vaultHub, "Paused");
      await expect(vaultHub.resume()).to.emit(vaultHub, "Resumed");

      await expect(vaultHub.resume()).to.be.revertedWithCustomError(vaultHub, "PausedExpected");
    });

    it("emits Resumed event and change state", async () => {
      await expect(vaultHub.pauseFor(1000n)).to.emit(vaultHub, "Paused");

      await expect(vaultHub.resume()).to.emit(vaultHub, "Resumed");

      expect(await vaultHub.isPaused()).to.equal(false);
      expect(await vaultHub.getResumeSinceTimestamp()).to.equal(await time.latest());
    });
  });

  context("isPaused", () => {
    beforeEach(async () => {
      await expect(vaultHub.pauseFor(1000n)).to.emit(vaultHub, "Paused");
      expect(await vaultHub.isPaused()).to.equal(true);
    });

    it("reverts voluntaryDisconnect() if paused", async () => {
      await expect(vaultHub.voluntaryDisconnect(user)).to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("reverts mintSharesBackedByVault() if paused", async () => {
      await expect(vaultHub.mintSharesBackedByVault(stranger, user, 1000n)).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("reverts burnSharesBackedByVault() if paused", async () => {
      await expect(vaultHub.burnSharesBackedByVault(stranger, 1000n)).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("reverts rebalance() if paused", async () => {
      await expect(vaultHub.rebalance()).to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("reverts transferAndBurnSharesBackedByVault() if paused", async () => {
      await steth.connect(user).approve(vaultHub, 1000n);

      await expect(vaultHub.transferAndBurnSharesBackedByVault(stranger, 1000n)).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });
  });
});
