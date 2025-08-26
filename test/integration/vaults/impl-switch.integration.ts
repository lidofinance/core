import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { PinnedBeaconProxy, VaultHub } from "typechain-types";

import { createVaultWithDashboard, getProtocolContext, ProtocolContext, setupLidoForVaults } from "lib/protocol";

describe("Switching vault implementation by spoofing ossification", () => {
  let owner: HardhatEthersSigner;

  let ctx: ProtocolContext;
  let vaultHub: VaultHub;
  let goodProxy: PinnedBeaconProxy;

  before(async () => {
    ctx = await getProtocolContext();

    await setupLidoForVaults(ctx);

    [owner] = await ethers.getSigners();
    vaultHub = ctx.contracts.vaultHub.connect(owner);

    ({ proxy: goodProxy } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      owner,
      owner,
    ));
  });

  it("connectVault reverts if the vault is ossified by checking the ossification on the proxy", async () => {
    const spoofImpl = await ethers.deployContract("StakingVault__OssifiedSpoof");

    // isOssified() returns false on the implementation
    expect(await spoofImpl.isOssified()).to.be.false;

    const badProxy = await ethers.deployContract("PinnedBeaconProxy__BeaconOverride", [
      spoofImpl,
      ctx.contracts.stakingVaultBeacon,
      "0x",
    ]);

    // proof that the constructor does not affect the runtime code (excepting the metadata, contract name, source mappings, etc.)
    const goodProxyCode = stripMetadata(await ethers.provider.getCode(goodProxy));
    const badProxyCode = stripMetadata(await ethers.provider.getCode(badProxy));
    expect(goodProxyCode).to.equal(badProxyCode);

    const vault = await ethers.getContractAt("StakingVault__OssifiedSpoof", badProxy);
    await vault.setPendingOwner(vaultHub);

    await expect(vaultHub.connectVault(vault)).to.be.revertedWithCustomError(vaultHub, "VaultOssified");
  });
});

function stripMetadata(bytecode: string) {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  // Last 2 bytes (4 hex chars) encode the CBOR length (big-endian) per solc.
  const cborLen = parseInt(hex.slice(-4), 16);
  const totalMetaHexLen = cborLen * 2 + 4; // CBOR + the 2 length bytes
  return "0x" + hex.slice(0, hex.length - totalMetaHexLen);
}
