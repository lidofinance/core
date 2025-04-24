import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  ERC20__Harness,
  ERC721__Harness,
  Lido__MockForWithdrawalVault,
  WithdrawalVault__Harness,
} from "typechain-types";

import { MAX_UINT256, proxify, streccak } from "lib";

import { Snapshot } from "test/suite";

const PETRIFIED_VERSION = MAX_UINT256;

const ADD_WITHDRAWAL_REQUEST_ROLE = streccak("ADD_WITHDRAWAL_REQUEST_ROLE");

describe("WithdrawalVault.sol", () => {
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let validatorsExitBus: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  let lido: Lido__MockForWithdrawalVault;
  let lidoAddress: string;

  let impl: WithdrawalVault__Harness;
  let vault: WithdrawalVault__Harness;
  let vaultAddress: string;

  before(async () => {
    [owner, treasury, validatorsExitBus, stranger] = await ethers.getSigners();

    lido = await ethers.deployContract("Lido__MockForWithdrawalVault");
    lidoAddress = await lido.getAddress();

    impl = await ethers.deployContract("WithdrawalVault__Harness", [lidoAddress, treasury.address], owner);

    [vault] = await proxify({ impl, admin: owner });
    vaultAddress = await vault.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constructor", () => {
    it("Reverts if the Lido address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [ZeroAddress, treasury.address]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the treasury address is zero", async () => {
      await expect(ethers.deployContract("WithdrawalVault", [lidoAddress, ZeroAddress])).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress",
      );
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
    it("Should revert if the contract is already initialized", async () => {
      await vault.initialize(owner);

      await expect(vault.initialize(owner))
        .to.be.revertedWithCustomError(vault, "UnexpectedContractVersion")
        .withArgs(2, 0);
    });

    it("Initializes the contract", async () => {
      await expect(vault.initialize(owner)).to.emit(vault, "ContractVersionSet").withArgs(2);
    });

    it("Should revert if admin address is zero", async () => {
      await expect(vault.initialize(ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Should set admin role during initialization", async () => {
      const adminRole = await vault.DEFAULT_ADMIN_ROLE();
      expect(await vault.getRoleMemberCount(adminRole)).to.equal(0);
      expect(await vault.hasRole(adminRole, owner)).to.equal(false);

      await vault.initialize(owner);

      expect(await vault.getRoleMemberCount(adminRole)).to.equal(1);
      expect(await vault.hasRole(adminRole, owner)).to.equal(true);
      expect(await vault.hasRole(adminRole, stranger)).to.equal(false);
    });
  });

  context("finalizeUpgrade_v2()", () => {
    it("Should revert with UnexpectedContractVersion error when called on implementation", async () => {
      await expect(impl.finalizeUpgrade_v2(owner))
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(MAX_UINT256, 1);
    });

    it("Should revert with UnexpectedContractVersion error when called on deployed from scratch WithdrawalVaultV2", async () => {
      await vault.initialize(owner);

      await expect(vault.finalizeUpgrade_v2(owner))
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(2, 1);
    });

    context("Simulate upgrade from v1", () => {
      beforeEach(async () => {
        await vault.harness__initializeContractVersionTo(1);
      });

      it("Should revert if admin address is zero", async () => {
        await expect(vault.finalizeUpgrade_v2(ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      });

      it("Should set correct contract version", async () => {
        expect(await vault.getContractVersion()).to.equal(1);
        await vault.finalizeUpgrade_v2(owner);
        expect(await vault.getContractVersion()).to.be.equal(2);
      });

      it("Should set admin role during finalization", async () => {
        const adminRole = await vault.DEFAULT_ADMIN_ROLE();
        expect(await vault.getRoleMemberCount(adminRole)).to.equal(0);
        expect(await vault.hasRole(adminRole, owner)).to.equal(false);

        await vault.finalizeUpgrade_v2(owner);

        expect(await vault.getRoleMemberCount(adminRole)).to.equal(1);
        expect(await vault.hasRole(adminRole, owner)).to.equal(true);
        expect(await vault.hasRole(adminRole, stranger)).to.equal(false);
      });
    });
  });

  context("Access control", () => {
    it("Returns ACL roles", async () => {
      expect(await vault.ADD_WITHDRAWAL_REQUEST_ROLE()).to.equal(ADD_WITHDRAWAL_REQUEST_ROLE);
    });

    it("Sets up roles", async () => {
      await vault.initialize(owner);

      expect(await vault.getRoleMemberCount(ADD_WITHDRAWAL_REQUEST_ROLE)).to.equal(0);
      expect(await vault.hasRole(ADD_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus)).to.equal(false);

      await vault.connect(owner).grantRole(ADD_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus);

      expect(await vault.getRoleMemberCount(ADD_WITHDRAWAL_REQUEST_ROLE)).to.equal(1);
      expect(await vault.hasRole(ADD_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus)).to.equal(true);
    });
  });

  context("withdrawWithdrawals", () => {
    beforeEach(async () => await vault.initialize(owner));

    it("Reverts if the caller is not Lido", async () => {
      await expect(vault.connect(stranger).withdrawWithdrawals(0)).to.be.revertedWithCustomError(vault, "NotLido");
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
    let token: ERC20__Harness;
    let tokenAddress: string;

    before(async () => {
      token = await ethers.deployContract("ERC20__Harness", ["Test Token", "TT"]);

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
    let token: ERC721__Harness;
    let tokenAddress: string;

    before(async () => {
      token = await ethers.deployContract("ERC721__Harness", ["Test NFT", "tNFT"]);

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
