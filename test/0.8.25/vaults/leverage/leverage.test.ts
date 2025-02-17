import { expect } from "chai";
import { keccak256,parseEther as ether } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Leverage,
  StakingVault__MockForLeverage,
  StETH__MockForLeverage,
  VaultFunder__MockForLeverage,
} from "typechain-types";

import { proxify } from "lib";

import { Snapshot } from "test/suite";

describe("Leverage.sol", () => {
  let admin: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;

  let leverage: Leverage;
  let steth: StETH__MockForLeverage;
  let vault: StakingVault__MockForLeverage;
  let recipient: VaultFunder__MockForLeverage;

  let originalState: string;

  const config = {
    shareLimit: ether("100"),
    reserveRatioBP: 1000n,
    reserveRatioThresholdBP: 800n,
    treasuryFeeBP: 0n,
  };

  before(async () => {
    [admin, vaultOwner] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForLeverage");

    const leverageImpl = await ethers.deployContract("Leverage", [steth]);
    [leverage] = await proxify({ impl: leverageImpl, admin });

    await leverage.initialize(admin);

    await leverage.grantRole(await leverage.FLASH_MINT_RECIPIENT_MANAGE_ROLE(), admin);
    expect(await leverage.hasRole(await leverage.FLASH_MINT_RECIPIENT_MANAGE_ROLE(), admin)).to.be.true;

    await leverage.grantRole(await leverage.VAULT_MASTER_ROLE(), admin);
    expect(await leverage.hasRole(await leverage.VAULT_MASTER_ROLE(), admin)).to.be.true;

    await leverage.grantRole(await leverage.VAULT_REGISTRY_ROLE(), admin);
    expect(await leverage.hasRole(await leverage.VAULT_REGISTRY_ROLE(), admin)).to.be.true;

    recipient = await ethers.deployContract("VaultFunder__MockForLeverage");
    await setBalance(await recipient.getAddress(), ether("1000"));
    expect(await ethers.provider.getBalance(await recipient.getAddress())).to.equal(ether("1000"));
    await leverage.allowFlashMintRecipient(recipient);
    expect(await leverage.isAllowedFlashMintRecipient(recipient)).to.be.true;

    vault = await ethers.deployContract("StakingVault__MockForLeverage", [vaultOwner]);
    const code = await ethers.provider.getCode(vault);
    await leverage.addVaultProxyCodehash(keccak256(code));

    await leverage.connectVault(
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

      await leverage.connect(vaultOwner).mintSharesRetrobackedByVault(vault, recipient, amount, data);
    });
  });
});
