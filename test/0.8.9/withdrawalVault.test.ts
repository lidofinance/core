import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  ERC20Token__MockForWithdrawalVault,
  ERC721Token_MockForWithdrawalVault,
  Lido__MockForWithdrawalVault,
  WithdrawalVault,
} from "typechain-types";

import { certainAddress, MAX_UINT256, proxify, Snapshot } from "lib";

const PETRIFIED_VERSION = MAX_UINT256;

describe("WithdrawalVault.sol", () => {
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;

  let originalState: string;

  let lido: Lido__MockForWithdrawalVault;
  let lidoAddress: string;

  let impl: WithdrawalVault;
  let vault: WithdrawalVault;
  let vaultAddress: string;
  let oracleAddress: string;
  let triggerableExitAddress: string;

  before(async () => {
    [owner, user, treasury] = await ethers.getSigners();

    lido = await ethers.deployContract("Lido__MockForWithdrawalVault");
    lidoAddress = await lido.getAddress();

    oracleAddress = certainAddress("oracleAddress");
    triggerableExitAddress = certainAddress("triggerableExitAddress");

    impl = await ethers.deployContract("WithdrawalVault", [
      lidoAddress,
      treasury.address,
      oracleAddress,
      triggerableExitAddress,
    ]);

    [vault] = await proxify({ impl, admin: owner });

    vaultAddress = await vault.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constructor", () => {
    it("Reverts if the Lido address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [
          ZeroAddress,
          treasury.address,
          oracleAddress,
          triggerableExitAddress,
        ]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the treasury address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [lidoAddress, ZeroAddress, oracleAddress, triggerableExitAddress]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the oracle address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [lidoAddress, treasury.address, ZeroAddress, triggerableExitAddress]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the triggerableExit address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [lidoAddress, treasury.address, oracleAddress, ZeroAddress]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Sets initial properties", async () => {
      expect(await vault.LIDO()).to.equal(lidoAddress, "Lido address");
      expect(await vault.TREASURY()).to.equal(treasury.address, "Treasury address");
    });

    it("Petrifies the implementation", async () => {
      expect(await impl.getContractVersion()).to.equal(PETRIFIED_VERSION);
    });

    it("Returns 0 as the initial contract version", async () => {
      expect(await vault.getContractVersion()).to.equal(0n);
    });
  });

  context("initialize", () => {
    it("Reverts if the contract is already initialized", async () => {
      await vault.initialize();

      await expect(vault.initialize()).to.be.revertedWithCustomError(vault, "NonZeroContractVersionOnInit");
    });

    it("Initializes the contract", async () => {
      await expect(vault.initialize()).to.emit(vault, "ContractVersionSet").withArgs(1);
    });
  });

  context("withdrawWithdrawals", () => {
    beforeEach(async () => await vault.initialize());

    it("Reverts if the caller is not Lido", async () => {
      await expect(vault.connect(user).withdrawWithdrawals(0)).to.be.revertedWithCustomError(vault, "NotLido");
    });

    it("Reverts if amount is 0", async () => {
      await expect(lido.mock_withdrawFromVault(vaultAddress, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("Reverts if not enough funds are available", async () => {
      await expect(lido.mock_withdrawFromVault(vaultAddress, 1))
        .to.be.revertedWithCustomError(vault, "NotEnoughEther")
        .withArgs(1, 0);
    });

    it("Withdraws the requested amount", async () => {
      await setBalance(vaultAddress, 10);

      await expect(lido.mock_withdrawFromVault(vaultAddress, 1)).to.emit(lido, "WithdrawalsReceived").withArgs(1);
    });
  });

  context("recoverERC20", () => {
    let token: ERC20Token__MockForWithdrawalVault;
    let tokenAddress: string;

    before(async () => {
      token = await ethers.deployContract("ERC20Token__MockForWithdrawalVault", ["Test Token", "TT"]);

      tokenAddress = await token.getAddress();
    });

    it("Reverts if the token is not a contract", async () => {
      await expect(vault.recoverERC20(ZeroAddress, 1)).to.be.revertedWith("Address: call to non-contract");
    });

    it("Reverts if the recovered amount is 0", async () => {
      await expect(vault.recoverERC20(ZeroAddress, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("Transfers the requested amount", async () => {
      await token.mint(vaultAddress, 10);

      expect(await token.balanceOf(vaultAddress)).to.equal(10);
      expect(await token.balanceOf(treasury.address)).to.equal(0);

      await expect(vault.recoverERC20(tokenAddress, 1))
        .to.emit(vault, "ERC20Recovered")
        .withArgs(owner, tokenAddress, 1);

      expect(await token.balanceOf(vaultAddress)).to.equal(9);
      expect(await token.balanceOf(treasury.address)).to.equal(1);
    });
  });

  context("recoverERC721", () => {
    let token: ERC721Token_MockForWithdrawalVault;
    let tokenAddress: string;

    before(async () => {
      token = await ethers.deployContract("ERC721Token_MockForWithdrawalVault", ["Test NFT", "tNFT"]);

      tokenAddress = await token.getAddress();
    });

    it("Reverts if the token is not a contract", async () => {
      await expect(vault.recoverERC721(ZeroAddress, 0)).to.be.reverted;
    });

    it("Transfers the requested token id", async () => {
      await token.mint(vaultAddress, 1);

      expect(await token.ownerOf(1)).to.equal(vaultAddress);
      expect(await token.ownerOf(1)).to.not.equal(treasury.address);

      await expect(vault.recoverERC721(tokenAddress, 1))
        .to.emit(vault, "ERC721Recovered")
        .withArgs(owner, tokenAddress, 1);

      expect(await token.ownerOf(1)).to.equal(treasury.address);
    });
  });
});
