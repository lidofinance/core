import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  ERC20__Harness,
  ERC721__Harness,
  Lido__MockForWithdrawalVault,
  WithdrawalsPredeployed_Mock,
  WithdrawalVault,
} from "typechain-types";

import { MAX_UINT256, proxify } from "lib";

import { Snapshot } from "test/suite";

import {
  deployWithdrawalsPredeployedMock,
  tesWithdrawalRequestsBehavior,
} from "./lib/withdrawalCredentials/withdrawalRequests.behaviour";

const PETRIFIED_VERSION = MAX_UINT256;

describe("WithdrawalVault.sol", () => {
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let validatorsExitBus: HardhatEthersSigner;

  let originalState: string;

  let lido: Lido__MockForWithdrawalVault;
  let lidoAddress: string;

  let withdrawalsPredeployed: WithdrawalsPredeployed_Mock;

  let impl: WithdrawalVault;
  let vault: WithdrawalVault;
  let vaultAddress: string;

  const getWithdrawalCredentialsContract = () => vault.connect(validatorsExitBus);
  const getWithdrawalsPredeployedContract = () => withdrawalsPredeployed.connect(user);

  before(async () => {
    [owner, user, treasury, validatorsExitBus] = await ethers.getSigners();

    withdrawalsPredeployed = await deployWithdrawalsPredeployedMock();

    lido = await ethers.deployContract("Lido__MockForWithdrawalVault");
    lidoAddress = await lido.getAddress();

    impl = await ethers.deployContract("WithdrawalVault", [lidoAddress, treasury.address, validatorsExitBus.address]);

    [vault] = await proxify({ impl, admin: owner });

    vaultAddress = await vault.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constructor", () => {
    it("Reverts if the Lido address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [ZeroAddress, treasury.address, validatorsExitBus.address]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the treasury address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [lidoAddress, ZeroAddress, validatorsExitBus.address]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the validator exit buss address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [lidoAddress, treasury.address, ZeroAddress]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Sets initial properties", async () => {
      expect(await vault.LIDO()).to.equal(lidoAddress, "Lido address");
      expect(await vault.TREASURY()).to.equal(treasury.address, "Treasury address");
      expect(await vault.VALIDATORS_EXIT_BUS()).to.equal(validatorsExitBus.address, "Validator exit bus address");
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
      await expect(vault.initialize())
        .to.emit(vault, "ContractVersionSet")
        .withArgs(1)
        .and.to.emit(vault, "ContractVersionSet")
        .withArgs(2);
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

  context("addWithdrawalRequests", () => {
    it("Reverts if the caller is not Validator Exit Bus", async () => {
      await expect(vault.connect(user).addWithdrawalRequests(["0x1234"], [0n])).to.be.revertedWithCustomError(
        vault,
        "NotValidatorExitBus",
      );
    });

    tesWithdrawalRequestsBehavior(getWithdrawalCredentialsContract, getWithdrawalsPredeployedContract);
  });
});
