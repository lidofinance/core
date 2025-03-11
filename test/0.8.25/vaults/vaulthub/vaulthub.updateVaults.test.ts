import { expect } from "chai";
import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StETH__MockForVaultHub, VaultHub } from "typechain-types";
import { StakingVault__MockForVaultHub } from "typechain-types";

import { ether, proxify } from "lib";
import { certainAddress } from "lib/address";

import { Snapshot } from "test/suite";

const BASIS_POINTS = 10_000n;

describe("VaultHub.sol:updateVaults", () => {
  let admin: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let accounting: HardhatEthersSigner;
  let vaultHub: VaultHub;
  let vault: StakingVault__MockForVaultHub;
  let steth: StETH__MockForVaultHub;

  const shareLimit = ether("1.0");
  const reserveRatioBP = 10_00n; // 10.00%
  const rebalanceThresholdBP = 8_00n; // 8.00%
  const treasuryFeeBP = 5_00n; // 5.00%

  let setupState: string;
  before(async () => {
    [admin, vaultOwner, accounting] = await ethers.getSigners();

    // dummy addresses
    steth = await ethers.deployContract("StETH__MockForVaultHub", [ether("100.0")]);

    // deploy vault hub implementation
    const connectedVaultsLimit = 10;
    const relativeShareLimitBP = 1000; // 10%

    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      steth,
      accounting,
      connectedVaultsLimit,
      relativeShareLimitBP,
    ]);

    // put behind proxy
    [vaultHub] = await proxify({ impl: vaultHubImpl, admin });

    // initialize vault hub
    await expect(vaultHub.initialize(admin))
      .to.emit(vaultHub, "RoleGranted")
      .withArgs(vaultHub.DEFAULT_ADMIN_ROLE(), admin, admin);

    // grant vault master role for adding vaults
    await expect(vaultHub.grantRole(await vaultHub.VAULT_MASTER_ROLE(), admin))
      .to.emit(vaultHub, "RoleGranted")
      .withArgs(vaultHub.VAULT_MASTER_ROLE(), admin, admin);

    // deploy vault
    const depositContract = certainAddress("depositContract");
    vault = await ethers.deployContract("StakingVault__MockForVaultHub", [vaultHub, depositContract]);
    await vault.initialize(vaultOwner, vaultOwner, "0x");
    expect(await vault.owner()).to.equal(vaultOwner);
    expect(await vault.nodeOperator()).to.equal(vaultOwner);

    // add vault code hash

    await expect(vaultHub.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), admin))
      .to.emit(vaultHub, "RoleGranted")
      .withArgs(vaultHub.VAULT_REGISTRY_ROLE(), admin, admin);

    const vaultCode = await ethers.provider.getCode(await vault.getAddress());
    const vaultCodeHash = keccak256(vaultCode);
    await expect(vaultHub.addVaultProxyCodehash(vaultCodeHash))
      .to.emit(vaultHub, "VaultProxyCodehashAdded")
      .withArgs(vaultCodeHash);

    // connect vault

    await vaultHub
      .connect(admin)
      .connectVault(await vault.getAddress(), shareLimit, reserveRatioBP, rebalanceThresholdBP, treasuryFeeBP);

    expect(await vaultHub.vaultsCount()).to.equal(1);
  });

  beforeEach(async () => {
    setupState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(setupState);
  });

  it("updateVaults removes disconnected vaults", async function () {
    const initialDeposit = ether("1");
    const lockedBefore = await vault.locked();
    expect(lockedBefore).to.equal(initialDeposit);
    expect(await vault.valuation()).to.equal(0n);

    await vault.connect(vaultOwner).fund({ value: ether("10") });
    expect(await vault.valuation()).to.equal(ether("10"));
    expect(await vault.locked()).to.equal(lockedBefore);

    // for simplicity, 1 share = 1 stETH
    const stethToMint = ether("1");
    await vaultHub.connect(vaultOwner).mintShares(vault, vaultOwner, stethToMint);
    expect(await steth.balanceOf(vaultOwner)).to.equal(stethToMint);
    const expectedLocked = lockedBefore + (stethToMint * BASIS_POINTS) / (BASIS_POINTS - reserveRatioBP);
    expect(await vault.locked()).to.equal(expectedLocked);

    const stethToBurn = stethToMint;
    await vaultHub.connect(vaultOwner).transferAndBurnShares(vault, stethToBurn);
    expect(await steth.balanceOf(vaultOwner)).to.equal(0);
    expect(await vault.locked()).to.equal(expectedLocked);

    await vaultHub.connect(vaultOwner).selfDisconnect(vault);
    expect(await vaultHub["vaultSocket(address)"](vault)).to.deep.equal([
      await vault.getAddress(),
      0, // sharesMinted
      shareLimit,
      reserveRatioBP,
      rebalanceThresholdBP,
      treasuryFeeBP,
      true, // isDisconnected
    ]);

    // the vault is still in the vaults array
    expect(await vaultHub.vaultsCount()).to.equal(1);

    const vaultsRebase = await vaultHub.calculateVaultsRebase(
      ether("105"), // postTotalShares, 5% rewards
      ether("105"), // postTotalPooledEther, 5% rewards
      ether("100"), // preTotalShares
      ether("100"), // preTotalPooledEther
      (ether("5") * 5_00n) / BASIS_POINTS, // sharesToMintAsFees, e.g. 5% fees
    );
    expect(vaultsRebase[0]).to.deep.equal([0]);
    expect(vaultsRebase[1]).to.deep.equal([0]);
    expect(vaultsRebase[2]).to.deep.equal(0);

    const valuations = [await vault.valuation()];
    const inOutDeltas = [await vault.inOutDelta()];
    const locked = [0];
    const treasuryFeeShares = [0];
    await vaultHub.connect(accounting).updateVaults(valuations, inOutDeltas, locked, treasuryFeeShares);

    expect(await vaultHub.vaultsCount()).to.equal(0);
  });
});
