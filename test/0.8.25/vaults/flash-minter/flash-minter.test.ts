import { expect } from "chai";
import { keccak256, parseEther as ether } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  FlashMinter__Harness,
  StakingVault__MockForFlashMinter,
  StETH__MockForFlashMinter,
  VaultFunder__MockForFlashMinter,
} from "typechain-types";

import { proxify } from "lib";

import { Snapshot } from "test/suite";

describe("FlashMinter.sol", () => {
  let admin: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;

  let flashMinter: FlashMinter__Harness;
  let steth: StETH__MockForFlashMinter;
  let vault: StakingVault__MockForFlashMinter;
  let recipient: VaultFunder__MockForFlashMinter;

  let originalState: string;

  const config = {
    shareLimit: ether("100"),
    reserveRatioBP: 1000n,
    reserveRatioThresholdBP: 800n,
    treasuryFeeBP: 0n,
  };

  before(async () => {
    [admin, vaultOwner] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForFlashMinter");

    const flashMinterImpl = await ethers.deployContract("FlashMinter__Harness", [steth]);
    [flashMinter] = await proxify({ impl: flashMinterImpl, admin });

    await flashMinter.initialize(admin);

    await flashMinter.grantRole(await flashMinter.FLASH_MINT_RECIPIENT_REGISTRY_ROLE(), admin);
    expect(await flashMinter.hasRole(await flashMinter.FLASH_MINT_RECIPIENT_REGISTRY_ROLE(), admin)).to.be.true;

    await flashMinter.grantRole(await flashMinter.VAULT_MASTER_ROLE(), admin);
    expect(await flashMinter.hasRole(await flashMinter.VAULT_MASTER_ROLE(), admin)).to.be.true;

    await flashMinter.grantRole(await flashMinter.VAULT_REGISTRY_ROLE(), admin);
    expect(await flashMinter.hasRole(await flashMinter.VAULT_REGISTRY_ROLE(), admin)).to.be.true;

    recipient = await ethers.deployContract("VaultFunder__MockForFlashMinter");
    await setBalance(await recipient.getAddress(), ether("1000"));
    expect(await ethers.provider.getBalance(await recipient.getAddress())).to.equal(ether("1000"));
    await flashMinter.registerFlashMintRecipient(recipient);
    expect(await flashMinter.isRegisteredFlashMintRecipient(recipient)).to.be.true;

    vault = await ethers.deployContract("StakingVault__MockForFlashMinter", [vaultOwner]);
    const code = await ethers.provider.getCode(vault);
    await flashMinter.addVaultProxyCodehash(keccak256(code));

    await flashMinter.connectVault(
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

  context("flash mint", () => {
    it("should mint shares", async () => {
      const amount = config.shareLimit;
      // fund vault with 2x amount to test valuation just to be well over the reserve ratio
      // TODO: calculate precise fund amount based on vault reserve ratio
      const data = recipient.interface.encodeFunctionData("fundVault", [await vault.getAddress(), amount * 2n]);

      await flashMinter.connect(vaultOwner).flashMintShares(vault, recipient, amount, data);
    });
  });
});
