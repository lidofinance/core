import { expect } from "chai";
import { keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Sideloading,
  StakingVault__MockForSideloading,
  StETH__MockForSideloading,
  Swapper__Mock,
  SwapperAdapter__MockForSideloading,
} from "typechain-types";

import { certainAddress, ether, proxify } from "lib";

import { Snapshot } from "test/suite";

const BASIS_POINTS = 10000n;

describe("Sideloading.sol", () => {
  let admin: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let sideloading: Sideloading;
  let steth: StETH__MockForSideloading;
  let vault: StakingVault__MockForSideloading;
  let adapter: SwapperAdapter__MockForSideloading;
  let swapper: Swapper__Mock;

  let originalState: string;

  const config = {
    shareLimit: ether("90"),
    reserveRatioBP: 1000n,
    reserveRatioThresholdBP: 800n,
    treasuryFeeBP: 0n,
  };

  before(async () => {
    [admin, vaultOwner, stranger] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForSideloading");
    swapper = await ethers.deployContract("Swapper__Mock", [steth]);
    await setBalance(await swapper.getAddress(), ether("1000"));
    adapter = await ethers.deployContract("SwapperAdapter__MockForSideloading", [steth, swapper]);

    const sideloadingImpl = await ethers.deployContract("Sideloading", [steth]);
    [sideloading] = await proxify({ impl: sideloadingImpl, admin });

    await expect(sideloading.initialize(admin))
      .to.emit(sideloading, "RoleGranted")
      .withArgs(await sideloading.DEFAULT_ADMIN_ROLE(), admin, admin);
    expect(await sideloading.hasRole(await sideloading.DEFAULT_ADMIN_ROLE(), admin)).to.be.true;

    await grantRolesAndCheck(
      await Promise.all([
        sideloading.SIDELOADER_REGISTRY_SWITCH_ROLE(),
        sideloading.SIDELOADER_REGISTRY_RECORD_ROLE(),
        sideloading.VAULT_MASTER_ROLE(),
        sideloading.VAULT_REGISTRY_ROLE(),
        sideloading.PAUSE_ROLE(),
        sideloading.RESUME_ROLE(),
      ]),
    );

    await expect(sideloading.registerSideloader(adapter))
      .to.emit(sideloading, "SideloaderRegistered")
      .withArgs(admin, adapter);
    expect(await sideloading.isRegisteredSideloader(adapter)).to.be.true;

    vault = await ethers.deployContract("StakingVault__MockForSideloading", [vaultOwner]);
    const code = await ethers.provider.getCode(vault);
    await sideloading.addVaultProxyCodehash(keccak256(code));

    await sideloading.connectVault(
      vault,
      config.shareLimit,
      config.reserveRatioBP,
      config.reserveRatioThresholdBP,
      config.treasuryFeeBP,
    );
    expect(await vault.locked()).to.equal(ether("1"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("isSideloaderRegistryIgnored", () => {
    it("should return false by default", async () => {
      expect(await sideloading.isSideloaderRegistryIgnored()).to.be.false;
    });

    it("should return true if the registry is ignored", async () => {
      await expect(sideloading.ignoreSideloaderRegistry())
        .to.emit(sideloading, "SideloaderRegistryIgnored")
        .withArgs(admin);

      expect(await sideloading.isSideloaderRegistryIgnored()).to.be.true;
    });
  });

  context("isRegisteredSideloader", () => {
    it("should return false for unregistered sideloaders", async () => {
      const unregisteredSideloader = certainAddress("unregistered-sideloader");
      expect(await sideloading.isRegisteredSideloader(unregisteredSideloader)).to.be.false;
    });

    it("should return true for registered sideloaders", async () => {
      const registeredSideloader = certainAddress("registered-sideloader");

      await expect(sideloading.registerSideloader(registeredSideloader))
        .to.emit(sideloading, "SideloaderRegistered")
        .withArgs(admin, registeredSideloader);

      expect(await sideloading.isRegisteredSideloader(registeredSideloader)).to.be.true;
    });
  });

  context("ignoreSideloaderRegistry", () => {
    it("reverts if the caller is not a member of SIDELOADER_REGISTRY_SWITCH_ROLE", async () => {
      await expect(sideloading.connect(stranger).ignoreSideloaderRegistry())
        .to.be.revertedWithCustomError(sideloading, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await sideloading.SIDELOADER_REGISTRY_SWITCH_ROLE());
    });

    it("ignores the sideloader registry and emits the event", async () => {
      await expect(sideloading.ignoreSideloaderRegistry())
        .to.emit(sideloading, "SideloaderRegistryIgnored")
        .withArgs(admin);

      expect(await sideloading.isSideloaderRegistryIgnored()).to.be.true;
    });

    it("should revert if the registry is already ignored", async () => {
      await expect(sideloading.ignoreSideloaderRegistry())
        .to.emit(sideloading, "SideloaderRegistryIgnored")
        .withArgs(admin);

      await expect(sideloading.ignoreSideloaderRegistry()).to.be.revertedWithCustomError(
        sideloading,
        "SideloaderRegistryAlreadyIgnored",
      );

      expect(await sideloading.isSideloaderRegistryIgnored()).to.be.true;
    });
  });

  context("respectSideloaderRegistry", () => {
    it("reverts if the caller is not a member of SIDELOADER_REGISTRY_SWITCH_ROLE", async () => {
      await expect(sideloading.connect(stranger).respectSideloaderRegistry())
        .to.be.revertedWithCustomError(sideloading, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await sideloading.SIDELOADER_REGISTRY_SWITCH_ROLE());
    });

    it("respects the sideloader registry and emits the event", async () => {
      await expect(sideloading.ignoreSideloaderRegistry())
        .to.emit(sideloading, "SideloaderRegistryIgnored")
        .withArgs(admin);

      await expect(sideloading.respectSideloaderRegistry())
        .to.emit(sideloading, "SideloaderRegistryRespected")
        .withArgs(admin);

      expect(await sideloading.isSideloaderRegistryIgnored()).to.be.false;
    });

    it("reverts if the registry is not ignored", async () => {
      await expect(sideloading.respectSideloaderRegistry()).to.be.revertedWithCustomError(
        sideloading,
        "SideloaderRegistryAlreadyRespected",
      );
    });
  });

  context("registerSideloader", () => {
    it("reverts if the caller is not a member of SIDELOADER_REGISTRY_RECORD_ROLE", async () => {
      await expect(sideloading.connect(stranger).registerSideloader(adapter))
        .to.be.revertedWithCustomError(sideloading, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await sideloading.SIDELOADER_REGISTRY_RECORD_ROLE());
    });

    it("reverts if the sideloader is the zero address", async () => {
      await expect(sideloading.registerSideloader(ZeroAddress))
        .to.be.revertedWithCustomError(sideloading, "ZeroArgument")
        .withArgs("_sideloader");
    });

    it("registers a sideloader and emits the event", async () => {
      const someSideloader = certainAddress("some-sideloader");

      await expect(sideloading.registerSideloader(someSideloader))
        .to.emit(sideloading, "SideloaderRegistered")
        .withArgs(admin, someSideloader);

      expect(await sideloading.isRegisteredSideloader(someSideloader)).to.be.true;
    });

    it("reverts if the sideloader is already registered", async () => {
      await expect(sideloading.registerSideloader(adapter)).to.be.revertedWithCustomError(
        sideloading,
        "SideloaderAlreadyRegistered",
      );
    });
  });

  context("unregisterSideloader", () => {
    it("reverts if the caller is not a member of SIDELOADER_REGISTRY_RECORD_ROLE", async () => {
      await expect(sideloading.connect(stranger).unregisterSideloader(adapter))
        .to.be.revertedWithCustomError(sideloading, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await sideloading.SIDELOADER_REGISTRY_RECORD_ROLE());
    });

    it("reverts if the sideloader is the zero address", async () => {
      await expect(sideloading.unregisterSideloader(ZeroAddress))
        .to.be.revertedWithCustomError(sideloading, "ZeroArgument")
        .withArgs("_sideloader");
    });

    it("unregisters a sideloader and emits the event", async () => {
      const someSideloader = certainAddress("some-sideloader");

      await expect(sideloading.registerSideloader(someSideloader))
        .to.emit(sideloading, "SideloaderRegistered")
        .withArgs(admin, someSideloader);

      expect(await sideloading.isRegisteredSideloader(someSideloader)).to.be.true;

      await expect(sideloading.unregisterSideloader(someSideloader))
        .to.emit(sideloading, "SideloaderUnregistered")
        .withArgs(admin, someSideloader);

      expect(await sideloading.isRegisteredSideloader(someSideloader)).to.be.false;
    });

    it("reverts if the sideloader is not registered", async () => {
      await expect(sideloading.unregisterSideloader(certainAddress("unregistered-sideloader")))
        .to.be.revertedWithCustomError(sideloading, "SideloaderNotRegistered")
        .withArgs(certainAddress("unregistered-sideloader"));
    });
  });

  // TODO: test 1 share != 1 steth
  context("sideload", () => {
    it("reverts if the contract is paused", async () => {
      await expect(sideloading.pauseFor(1000)).to.emit(sideloading, "Paused").withArgs(1000);

      await expect(
        sideloading.connect(vaultOwner).sideload(vault, adapter, config.shareLimit, "0x"),
      ).to.be.revertedWithCustomError(sideloading, "ResumedExpected");
    });

    it("reverts if the vault is zero address", async () => {
      await expect(sideloading.connect(vaultOwner).sideload(ZeroAddress, adapter, config.shareLimit, "0x"))
        .to.be.revertedWithCustomError(sideloading, "ZeroArgument")
        .withArgs("_vault");
    });

    it("reverts if the amount of shares to sideload is zero", async () => {
      await expect(sideloading.connect(vaultOwner).sideload(vault, adapter, 0, "0x"))
        .to.be.revertedWithCustomError(sideloading, "ZeroArgument")
        .withArgs("_amountOfShares");
    });

    it("reverts if the sender is not the vault owner", async () => {
      await expect(sideloading.connect(stranger).sideload(vault, adapter, config.shareLimit, "0x"))
        .to.be.revertedWithCustomError(sideloading, "NotAuthorized")
        .withArgs("sideload", stranger);
    });

    it("reverts if the vault is not connected to the hub", async () => {
      const someVault = await ethers.deployContract("StakingVault__MockForSideloading", [vaultOwner]);
      await expect(sideloading.connect(vaultOwner).sideload(someVault, adapter, config.shareLimit, "0x"))
        .to.be.revertedWithCustomError(sideloading, "NotConnectedToHub")
        .withArgs(someVault);
    });

    it("reverts if the sideloader is not registered", async () => {
      await expect(
        sideloading
          .connect(vaultOwner)
          .sideload(vault, certainAddress("unregistered-sideloader"), config.shareLimit, "0x"),
      )
        .to.be.revertedWithCustomError(sideloading, "SideloaderNotRegistered")
        .withArgs(certainAddress("unregistered-sideloader"));
    });

    it("reverts if the amount of shares exceeds the share limit", async () => {
      await expect(sideloading.connect(vaultOwner).sideload(vault, adapter, config.shareLimit + 1n, "0x"))
        .to.be.revertedWithCustomError(sideloading, "ShareLimitExceeded")
        .withArgs(vault, config.shareLimit);
    });

    it("reverts if the valuation before sideloading is insufficient to cover the minimal reserve after sideloading", async () => {
      const sharesToSideload = config.shareLimit;
      const stethToSideload = await steth.getPooledEthByShares(sharesToSideload);
      const expectedLocked = (stethToSideload * BASIS_POINTS) / (BASIS_POINTS - config.reserveRatioBP);
      const requiredMinimumValuation = expectedLocked - stethToSideload;
      const insufficientValuation = requiredMinimumValuation - 1n;

      await expect(vault.connect(vaultOwner).fund({ value: insufficientValuation }))
        .to.emit(vault, "Mock__Funded")
        .withArgs(vaultOwner, insufficientValuation);
      expect(await ethers.provider.getBalance(vault)).to.equal(insufficientValuation);

      await expect(sideloading.connect(vaultOwner).sideload(vault, adapter, sharesToSideload, "0x"))
        .to.be.revertedWithCustomError(sideloading, "InsufficientValuationBeforeSideload")
        .withArgs(vault, requiredMinimumValuation, await vault.valuation());
    });

    it("reverts if the sideloader callback returns an incorrect hash", async () => {
      await adapter.makeHookReturnIncorrectHash();

      const data = "0x";
      const sharesToSideload = config.shareLimit;
      const stethToSideload = await steth.getPooledEthByShares(sharesToSideload);
      const expectedLocked = (stethToSideload * BASIS_POINTS) / (BASIS_POINTS - config.reserveRatioBP);
      const requiredMinimumValuation = expectedLocked - stethToSideload;

      await expect(vault.connect(vaultOwner).fund({ value: requiredMinimumValuation }))
        .to.emit(vault, "Mock__Funded")
        .withArgs(vaultOwner, requiredMinimumValuation);
      expect(await ethers.provider.getBalance(vault)).to.equal(requiredMinimumValuation);

      await expect(sideloading.connect(vaultOwner).sideload(vault, adapter, config.shareLimit, data))
        .to.be.revertedWithCustomError(sideloading, "SideloaderCallbackFailed")
        .withArgs(adapter, data);
    });

    it("reverts if the valuation after sideloading is insufficient to cover the locked amount", async () => {
      const sharesToSideload = config.shareLimit;
      const stethToSideload = await steth.getPooledEthByShares(sharesToSideload);
      const expectedLocked = (stethToSideload * BASIS_POINTS) / (BASIS_POINTS - config.reserveRatioBP);
      const requiredMinimumValuation = expectedLocked - stethToSideload;

      await expect(vault.connect(vaultOwner).fund({ value: requiredMinimumValuation }))
        .to.emit(vault, "Mock__Funded")
        .withArgs(vaultOwner, requiredMinimumValuation);
      const vaultBalance = await ethers.provider.getBalance(vault);
      expect(vaultBalance).to.equal(requiredMinimumValuation);

      const ratio = ether("0.999");
      await swapper.setSwapRatio(ratio);
      const expectedEthFromSwap = (stethToSideload * ratio) / ether("1");

      await expect(sideloading.connect(vaultOwner).sideload(vault, adapter, sharesToSideload, "0x"))
        .to.be.revertedWithCustomError(sideloading, "InsufficientValuationAfterSideload")
        .withArgs(vault, expectedLocked, vaultBalance + expectedEthFromSwap);
    });

    it("sideloads the vault valuation by minting shares to the sideloader", async () => {
      const sharesToSideload = config.shareLimit;
      const stethToSideload = await steth.getPooledEthByShares(sharesToSideload);
      const expectedLocked = (stethToSideload * BASIS_POINTS) / (BASIS_POINTS - config.reserveRatioBP);
      const requiredMinimumValuation = expectedLocked - stethToSideload;

      await expect(vault.connect(vaultOwner).fund({ value: requiredMinimumValuation }))
        .to.emit(vault, "Mock__Funded")
        .withArgs(vaultOwner, requiredMinimumValuation);
      expect(await ethers.provider.getBalance(vault)).to.equal(requiredMinimumValuation);

      await expect(sideloading.connect(vaultOwner).sideload(vault, adapter, sharesToSideload, "0x"))
        .to.emit(steth, "Mock__ExternalSharesMinted")
        .withArgs(adapter, sharesToSideload);

      expect(await vault.locked()).to.equal(expectedLocked);
      expect(await vault.valuation()).to.equal(expectedLocked);
    });

    it("sideloads if the sideloader is not registered but the registry is ignored", async () => {
      await expect(sideloading.unregisterSideloader(adapter))
        .to.emit(sideloading, "SideloaderUnregistered")
        .withArgs(admin, adapter);
      expect(await sideloading.isRegisteredSideloader(adapter)).to.be.false;

      await expect(sideloading.ignoreSideloaderRegistry())
        .to.emit(sideloading, "SideloaderRegistryIgnored")
        .withArgs(admin);

      expect(await sideloading.isSideloaderRegistryIgnored()).to.be.true;

      const sharesToSideload = config.shareLimit;
      const stethToSideload = await steth.getPooledEthByShares(sharesToSideload);
      const expectedLocked = (stethToSideload * BASIS_POINTS) / (BASIS_POINTS - config.reserveRatioBP);
      const requiredMinimumValuation = expectedLocked - stethToSideload;

      await expect(vault.connect(vaultOwner).fund({ value: requiredMinimumValuation }))
        .to.emit(vault, "Mock__Funded")
        .withArgs(vaultOwner, requiredMinimumValuation);
      expect(await ethers.provider.getBalance(vault)).to.equal(requiredMinimumValuation);

      await expect(sideloading.connect(vaultOwner).sideload(vault, adapter, sharesToSideload, "0x"))
        .to.emit(steth, "Mock__ExternalSharesMinted")
        .withArgs(adapter, sharesToSideload);

      expect(await vault.locked()).to.equal(expectedLocked);
      expect(await vault.valuation()).to.equal(expectedLocked);
    });

    it("sideloads if the initial locked is already greater than the resulting locked", async () => {
      // mint max shares
      const sharesToMint = config.shareLimit;
      const stethToMint = await steth.getPooledEthByShares(sharesToMint);
      const expectedValuation = (stethToMint * BASIS_POINTS) / (BASIS_POINTS - config.reserveRatioBP);

      await vault.connect(vaultOwner).fund({ value: expectedValuation });
      expect(await vault.valuation()).to.equal(expectedValuation);

      await sideloading.connect(vaultOwner).mintShares(vault, vaultOwner, sharesToMint);

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethToMint);
      // with max shares minted, the entire valuation should be locked
      const expectedLocked = await vault.valuation();
      expect(await vault.locked()).to.equal(expectedLocked);

      // now burn all the shares
      await steth.approve(sideloading, stethToMint);
      await sideloading.connect(vaultOwner).transferAndBurnShares(vault, sharesToMint);

      // the balance should be 0
      expect(await steth.balanceOf(vaultOwner)).to.equal(0);

      // but the locked amount should remain the same
      expect(await vault.locked()).to.equal(expectedLocked);

      // now we can sideload a smaller amount while the locked amount is greater
      const sharesToSideload = ether("1.0");
      const stethToSideload = await steth.getPooledEthByShares(sharesToSideload);

      await expect(sideloading.connect(vaultOwner).sideload(vault, adapter, sharesToSideload, "0x"))
        .to.emit(steth, "Mock__ExternalSharesMinted")
        .withArgs(adapter, sharesToSideload);

      // locked is the same as it was when we minted the max shares
      expect(await vault.locked()).to.equal(expectedLocked);
      // valuation is the old valuation + eth we got from the swapping sideloaded steth
      expect(await vault.valuation()).to.equal(expectedLocked + stethToSideload);
    });
  });

  async function grantRolesAndCheck(roles: string[]) {
    await Promise.all(
      roles.map(async (role) => {
        await expect(sideloading.grantRole(role, admin))
          .to.emit(sideloading, "RoleGranted")
          .withArgs(role, admin, admin);
        expect(await sideloading.hasRole(role, admin)).to.be.true;
      }),
    );
  }
});
