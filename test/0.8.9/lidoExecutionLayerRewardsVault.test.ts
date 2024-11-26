import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ERC721__Harness,
  Lido__MockForElRewardsVault,
  LidoExecutionLayerRewardsVault,
  StETH__Harness,
} from "typechain-types";

import { batch, certainAddress, ether, impersonate } from "lib";

import { Snapshot } from "test/suite";

describe("LidoExecutionLayerRewardsVault.sol", () => {
  let deployer: HardhatEthersSigner;
  let anyone: HardhatEthersSigner;
  let lidoAsSigner: HardhatEthersSigner;

  let vault: LidoExecutionLayerRewardsVault;
  let lido: Lido__MockForElRewardsVault;

  let originalState: string;

  const treasury = certainAddress("test:elRewardsVault:treasury");

  before(async () => {
    [deployer, anyone] = await ethers.getSigners();

    lido = await ethers.deployContract("Lido__MockForElRewardsVault", deployer);
    vault = await ethers.deployContract("LidoExecutionLayerRewardsVault", [lido, treasury], deployer);

    lidoAsSigner = await impersonate(await lido.getAddress(), ether("100.0"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("Reverts if Lido is zero address", async () => {
      await expect(
        ethers.deployContract("LidoExecutionLayerRewardsVault", [ZeroAddress, treasury], deployer),
      ).to.be.revertedWith("LIDO_ZERO_ADDRESS");
    });

    it("Reverts if Treasury is zero address", async () => {
      await expect(
        ethers.deployContract("LidoExecutionLayerRewardsVault", [lido, ZeroAddress], deployer),
      ).to.be.revertedWith("TREASURY_ZERO_ADDRESS");
    });

    it("Sets Lido and Treasury addresses", async () => {
      expect(await vault.LIDO()).to.equal(lido);
      expect(await vault.TREASURY()).to.equal(treasury);
    });
  });

  context("receive", () => {
    it("Receives ether and emits `ETHReceived`", async () => {
      const balanceBefore = await ethers.provider.getBalance(vault);
      const transferAmount = ether("10.0");

      await expect(
        anyone.sendTransaction({
          to: vault,
          value: transferAmount,
        }),
      )
        .to.emit(vault, "ETHReceived")
        .withArgs(transferAmount);

      expect(await ethers.provider.getBalance(vault)).to.equal(balanceBefore + transferAmount);
    });
  });

  context("withdrawRewards", () => {
    beforeEach(async () => {
      vault = vault.connect(lidoAsSigner);
    });

    it("Reverts if the caller is not Lido", async () => {
      await expect(vault.connect(anyone).withdrawRewards(0n)).to.be.revertedWith("ONLY_LIDO_CAN_WITHDRAW");
    });

    it("Does not withdraw if called with 0 max amount", async () => {
      // top up vault
      await anyone.sendTransaction({
        to: vault,
        value: ether("1.0"),
      });

      const before = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        vaultBalance: ethers.provider.getBalance(vault),
      });

      const maxAmount = 0n;
      // base fee can't be 0
      // so in order to account for gas price, we have to extract the receipt
      // but now we cant use chai `expect(...).emits` to check events
      // TODO: find a good way to obtain `tx.fee` and use `emits`
      const receipt = await vault.withdrawRewards(maxAmount).then((tx) => tx.wait());

      if (!receipt) {
        throw Error("Receipt missing");
      }

      expect(receipt.logs.length).to.equal(0);

      const after = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        vaultBalance: ethers.provider.getBalance(vault),
      });

      expect(after.lidoBalance).to.equal(before.lidoBalance - receipt.fee);
      expect(after.vaultBalance).to.equal(before.vaultBalance);
    });

    it("Does not withdraw if the vault balance is zero", async () => {
      const before = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        vaultBalance: ethers.provider.getBalance(vault),
      });

      expect(before.vaultBalance).to.equal(0n);

      const maxAmount = 1n;
      // base fee can't be 0
      // so in order to account for gas price, we have to extract the receipt
      // but now we cant use chai `expect(...).emits` to check events
      // TODO: find a good way to obtain `tx.fee` and use `emits`
      const receipt = await vault.withdrawRewards(maxAmount).then((tx) => tx.wait());

      if (!receipt) {
        throw Error("Receipt missing");
      }

      expect(receipt.logs.length).to.equal(0);

      const after = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        vaultBalance: ethers.provider.getBalance(vault),
      });

      expect(after.lidoBalance).to.equal(before.lidoBalance - receipt.fee);
      expect(after.vaultBalance).to.equal(before.vaultBalance);
    });

    it("Withdraws the specified max amount if the vault balance is greater", async () => {
      // top up vault
      await anyone.sendTransaction({
        to: vault,
        value: ether("10.0"),
      });

      const before = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        vaultBalance: ethers.provider.getBalance(vault),
      });

      const maxAmount = ether("3.0");
      // base fee can't be 0
      // so in order to account for gas price, we have to extract the receipt
      // but now we cant use chai `expect(...).emits` to check events
      // TODO: find a good way to obtain `tx.fee` and use `emits`
      const receipt = await vault.withdrawRewards(maxAmount).then((tx) => tx.wait());

      if (!receipt) {
        throw Error("Receipt missing");
      }

      const after = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        vaultBalance: ethers.provider.getBalance(vault),
      });

      expect(after.lidoBalance).to.equal(before.lidoBalance + maxAmount - receipt.fee);
      expect(after.vaultBalance).to.equal(before.vaultBalance - maxAmount);
    });

    it("Withdraws the entire vault balance if the specified max amount is greater", async () => {
      // top up vault
      await anyone.sendTransaction({
        to: vault,
        value: ether("3.0"),
      });

      const before = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        vaultBalance: ethers.provider.getBalance(vault),
      });

      const maxAmount = ether("10.0");
      // base fee can't be 0
      // so in order to account for gas price, we have to extract the receipt
      // but now we cant use chai `expect(...).emits` to check events
      // TODO: find a good way to obtain `tx.fee` and use `emits`
      const receipt = await vault.withdrawRewards(maxAmount).then((tx) => tx.wait());

      if (!receipt) {
        throw Error("Receipt missing");
      }

      const after = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        vaultBalance: ethers.provider.getBalance(vault),
      });

      expect(after.lidoBalance).to.equal(before.lidoBalance + before.vaultBalance - receipt.fee);
      expect(after.vaultBalance).to.equal(0n);
    });

    it("Returns the amount withdrawn", async () => {
      await anyone.sendTransaction({
        to: vault,
        value: ether("10.0"),
      });

      const maxAmount = ether("5.0");

      const amount = await vault.withdrawRewards.staticCall(maxAmount);

      expect(amount).to.equal(maxAmount);
    });
  });

  context("recoverERC20", () => {
    let token: StETH__Harness;

    beforeEach(async () => {
      const tokensToMint = ether("10.0");
      token = await ethers.deployContract("StETH__Harness", [vault], { value: tokensToMint, from: deployer });

      expect(await token.balanceOf(vault)).to.equal(tokensToMint);

      vault = vault.connect(anyone);
    });

    it("Reverts if the recover amount is zero", async () => {
      await expect(vault.recoverERC20(token, 0n)).to.be.revertedWith("ZERO_RECOVERY_AMOUNT");
    });

    it("Transfers the tokens to Treasury", async () => {
      const before = await batch({
        treasuryBalance: token.balanceOf(treasury),
        vaultBalance: token.balanceOf(vault),
      });

      await expect(vault.recoverERC20(token, before.vaultBalance))
        .to.emit(vault, "ERC20Recovered")
        .withArgs(anyone.address, await token.getAddress(), before.vaultBalance)
        .and.to.emit(token, "Transfer")
        .withArgs(await vault.getAddress(), treasury, before.vaultBalance);

      const after = await batch({
        treasuryBalance: token.balanceOf(treasury),
        vaultBalance: token.balanceOf(vault),
      });

      expect(after.treasuryBalance).to.equal(before.treasuryBalance + before.vaultBalance);
      expect(after.vaultBalance).to.equal(0n);
    });
  });

  context("recoverERC721", () => {
    let nft: ERC721__Harness;
    const tokenId = 1n;

    beforeEach(async () => {
      nft = await ethers.deployContract("ERC721__Harness", ["NFTMock", "NFT"], deployer);
      await nft.mint(vault, tokenId);
      expect(await nft.ownerOf(tokenId)).to.equal(await vault.getAddress());

      vault = vault.connect(anyone);
    });

    it("Transfers the NFT to Treasury", async () => {
      await expect(vault.recoverERC721(nft, tokenId))
        .to.emit(vault, "ERC721Recovered")
        .withArgs(anyone.address, await nft.getAddress(), tokenId)
        .and.to.emit(nft, "Transfer")
        .withArgs(await vault.getAddress(), treasury, tokenId);

      expect(await nft.ownerOf(tokenId)).to.equal(treasury);
    });
  });
});
