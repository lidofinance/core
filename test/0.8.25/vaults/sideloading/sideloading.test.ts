import { expect } from "chai";
import { formatEther, keccak256,parseEther as ether } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Sideloading__Harness,
  StakingVault__MockForSideloading,
  StETH__MockForSideloading,
  Swapper__Mock,
  SwapperAdapter__MockForSideloading,
} from "typechain-types";

import { proxify } from "lib";

import { Snapshot } from "test/suite";

const BASIS_POINTS = 10000n;

describe("Sideloading.sol", () => {
  let admin: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;

  let sideloading: Sideloading__Harness;
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
    [admin, vaultOwner] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForSideloading");
    swapper = await ethers.deployContract("Swapper__Mock", [steth]);
    await setBalance(await swapper.getAddress(), ether("1000"));
    adapter = await ethers.deployContract("SwapperAdapter__MockForSideloading", [steth, swapper]);

    const sideloadingImpl = await ethers.deployContract("Sideloading__Harness", [steth]);
    [sideloading] = await proxify({ impl: sideloadingImpl, admin });

    await expect(sideloading.initialize(admin))
      .to.emit(sideloading, "RoleGranted")
      .withArgs(await sideloading.DEFAULT_ADMIN_ROLE(), admin, admin);
    expect(await sideloading.hasRole(await sideloading.DEFAULT_ADMIN_ROLE(), admin)).to.be.true;

    await expect(sideloading.grantRole(await sideloading.SIDELOADER_REGISTRY_RECORD_ROLE(), admin))
      .to.emit(sideloading, "RoleGranted")
      .withArgs(await sideloading.SIDELOADER_REGISTRY_RECORD_ROLE(), admin, admin);
    expect(await sideloading.hasRole(await sideloading.SIDELOADER_REGISTRY_RECORD_ROLE(), admin)).to.be.true;

    await expect(sideloading.grantRole(await sideloading.VAULT_MASTER_ROLE(), admin))
      .to.emit(sideloading, "RoleGranted")
      .withArgs(await sideloading.VAULT_MASTER_ROLE(), admin, admin);
    expect(await sideloading.hasRole(await sideloading.VAULT_MASTER_ROLE(), admin)).to.be.true;

    await expect(sideloading.grantRole(await sideloading.VAULT_REGISTRY_ROLE(), admin))
      .to.emit(sideloading, "RoleGranted")
      .withArgs(await sideloading.VAULT_REGISTRY_ROLE(), admin, admin);
    expect(await sideloading.hasRole(await sideloading.VAULT_REGISTRY_ROLE(), admin)).to.be.true;

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

  context("sideload happy path", () => {
    it("should mint shares", async () => {
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

      console.log(formatEther(await vault.locked()));
      console.log(formatEther(await vault.valuation()));
      expect(await vault.locked()).to.equal(expectedLocked);
      expect(await vault.valuation()).to.equal(expectedLocked);
      // expect(await steth.balanceOf(sideloader)).to.equal(sharesToSideload);
      // expect(await vault.locked()).to.equal(expectedLocked);
    });
  });
});
