import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { before, beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Burner,
  Burner__MockForMigration,
  ERC20__Harness,
  ERC721__Harness,
  LidoLocator,
  OssifiableProxy__factory,
  StETH__Harness,
} from "typechain-types";

import { batch, certainAddress, ether, impersonate } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Burner.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let stethSigner: HardhatEthersSigner;
  let accountingSigner: HardhatEthersSigner;

  let burner: Burner;
  let steth: StETH__Harness;
  let locator: LidoLocator;
  let oldBurner: Burner__MockForMigration;

  const treasury = certainAddress("test:burner:treasury");
  const accounting = certainAddress("test:burner:accounting");
  const coverSharesBurnt = 0n;
  const nonCoverSharesBurnt = 0n;

  const oldCoverSharesBurnRequested = 100n;
  const oldNonCoverSharesBurnRequested = 200n;
  const oldTotalCoverSharesBurnt = 300n;
  const oldTotalNonCoverSharesBurnt = 400n;

  let originalState: string;

  async function deployBurner() {
    let burner_: Burner;
    burner_ = await ethers.getContractFactory("Burner").then((f) => f.connect(deployer).deploy(locator, steth));
    const proxyFactory = new OssifiableProxy__factory(deployer);
    const burnerProxy = await proxyFactory.deploy(
      await burner_.getAddress(),
      await deployer.getAddress(),
      new Uint8Array(),
    );
    burner_ = burner_.attach(await burnerProxy.getAddress()) as Burner;
    return burner_;
  }

  before(async () => {
    [deployer, admin, holder, stranger] = await ethers.getSigners();

    locator = await deployLidoLocator({ treasury, accounting }, deployer);
    steth = await ethers.deployContract("StETH__Harness", [holder], { value: ether("10.0"), from: deployer });

    burner = await deployBurner();

    const isMigrationAllowed = false;
    await burner.initialize(admin, isMigrationAllowed);

    steth = steth.connect(holder);
    burner = burner.connect(holder);

    stethSigner = await impersonate(await steth.getAddress(), ether("1.0"));

    // Accounting is granted the permission to burn shares as a part of the protocol setup
    accountingSigner = await impersonate(accounting, ether("1.0"));
    await burner.connect(admin).grantRole(await burner.REQUEST_BURN_SHARES_ROLE(), accountingSigner);

    oldBurner = await ethers.deployContract("Burner__MockForMigration", []);
    await oldBurner
      .connect(admin)
      .setSharesRequestedToBurn(oldCoverSharesBurnRequested, oldNonCoverSharesBurnRequested);
    await oldBurner.connect(admin).setSharesBurnt(oldTotalCoverSharesBurnt, oldTotalNonCoverSharesBurnt);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    context("Reverts", () => {
      it("if locator is zero address", async () => {
        await expect(ethers.getContractFactory("Burner").then((f) => f.connect(deployer).deploy(ZeroAddress, steth)))
          .to.be.revertedWithCustomError(burner, "ZeroAddress")
          .withArgs("_locator");
      });

      it("if stETH is zero address", async () => {
        await expect(ethers.getContractFactory("Burner").then((f) => f.connect(deployer).deploy(locator, ZeroAddress)))
          .to.be.revertedWithCustomError(burner, "ZeroAddress")
          .withArgs("_stETH");
      });
    });
  });

  context("initialize", () => {
    it("if admin is zero address", async () => {
      await expect(burner.connect(admin).initialize(ZeroAddress, false))
        .to.be.revertedWithCustomError(burner, "ZeroAddress")
        .withArgs("_admin");
    });

    it("Sets up roles, addresses and shares burnt", async () => {
      const adminRole = await burner.DEFAULT_ADMIN_ROLE();
      expect(await burner.getRoleMemberCount(adminRole)).to.equal(1);
      expect(await burner.hasRole(adminRole, admin)).to.equal(true);

      const requestBurnSharesRole = await burner.REQUEST_BURN_SHARES_ROLE();
      expect(await burner.getRoleMemberCount(requestBurnSharesRole)).to.equal(1);
      expect(await burner.hasRole(requestBurnSharesRole, accounting)).to.equal(true);

      expect(await burner.LIDO()).to.equal(steth);
      expect(await burner.LOCATOR()).to.equal(locator);

      expect(await burner.getCoverSharesBurnt()).to.equal(coverSharesBurnt);
      expect(await burner.getNonCoverSharesBurnt()).to.equal(nonCoverSharesBurnt);
    });

    it("Sets isMigrationAllowed correctly", async () => {
      const burnerMigrationOn = await deployBurner();
      await burnerMigrationOn.connect(admin).initialize(admin, true);
      expect(await burnerMigrationOn.isMigrationAllowed()).to.equal(true);

      const burnerMigrationOff = await deployBurner();
      await burnerMigrationOff.connect(admin).initialize(admin, false);
      expect(await burnerMigrationOff.isMigrationAllowed()).to.equal(false);
    });
  });

  context("migration", () => {
    context("Reverts", () => {
      it("if called by non-Lido", async () => {
        await expect(burner.connect(stranger).migrate(ZeroAddress)).to.be.revertedWithCustomError(
          burner,
          "OnlyLidoCanMigrate",
        );
      });

      it("if old burner address is zero", async () => {
        await expect(burner.connect(stethSigner).migrate(ZeroAddress))
          .to.be.revertedWithCustomError(burner, "ZeroAddress")
          .withArgs("_oldBurner");
      });

      it("if migration is not allowed", async () => {
        const burnerMigrationOff = await deployBurner();
        await burnerMigrationOff.connect(admin).initialize(admin, false);

        const anyAddress = deployer.address;
        await expect(burnerMigrationOff.connect(stethSigner).migrate(anyAddress)).to.be.revertedWithCustomError(
          burnerMigrationOff,
          "MigrationNotAllowedOrAlreadyMigrated",
        );
      });

      it("if migration is already performed", async () => {
        const burnerMigrationOn = await deployBurner();
        await burnerMigrationOn.initialize(admin, true);

        await burnerMigrationOn.connect(stethSigner).migrate(oldBurner.target);
        expect(await burnerMigrationOn.isMigrationAllowed()).to.equal(false);

        await expect(burnerMigrationOn.connect(stethSigner).migrate(oldBurner.target)).to.be.revertedWithCustomError(
          burnerMigrationOn,
          "MigrationNotAllowedOrAlreadyMigrated",
        );
      });

      it("if burner is not initialized", async () => {
        const burnerMigrationOn = await deployBurner();
        await expect(burnerMigrationOn.connect(stethSigner).migrate(oldBurner.target)).to.be.revertedWithCustomError(
          burnerMigrationOn,
          "UnexpectedContractVersion",
        );
      });
    });

    it("Migrates state from old burner correctly", async () => {
      const burnerMigrationOn = await deployBurner();
      await burnerMigrationOn.connect(deployer).initialize(deployer, true);

      await burnerMigrationOn.connect(stethSigner).migrate(oldBurner.target);

      expect(await burnerMigrationOn.getCoverSharesBurnt()).to.equal(oldTotalCoverSharesBurnt);
      expect(await burnerMigrationOn.getNonCoverSharesBurnt()).to.equal(oldTotalNonCoverSharesBurnt);
      const [coverShares, nonCoverShares] = await burnerMigrationOn.getSharesRequestedToBurn();
      expect(coverShares).to.equal(oldCoverSharesBurnRequested);
      expect(nonCoverShares).to.equal(oldNonCoverSharesBurnRequested);
    });
  });

  let burnAmount: bigint;
  let burnAmountInShares: bigint;

  async function setupBurnStETH() {
    // holder does not yet have permission
    const requestBurnMyStethRole = await burner.REQUEST_BURN_MY_STETH_ROLE();
    expect(await burner.hasRole(requestBurnMyStethRole, holder)).to.equal(false);

    await burner.connect(admin).grantRole(requestBurnMyStethRole, holder);

    // holder now has the permission
    expect(await burner.hasRole(requestBurnMyStethRole, holder)).to.equal(true);

    burnAmount = await steth.balanceOf(holder);
    burnAmountInShares = await steth.getSharesByPooledEth(burnAmount);

    await expect(steth.approve(burner, burnAmount))
      .to.emit(steth, "Approval")
      .withArgs(holder.address, await burner.getAddress(), burnAmount);

    expect(await steth.allowance(holder, burner)).to.equal(burnAmount);
  }

  context("requestBurnMyStETHForCover", () => {
    beforeEach(async () => await setupBurnStETH());

    context("Reverts", () => {
      it("if the caller does not have the permission", async () => {
        await expect(
          burner.connect(stranger).requestBurnMyStETHForCover(burnAmount),
        ).to.be.revertedWithOZAccessControlError(stranger.address, await burner.REQUEST_BURN_MY_STETH_ROLE());
      });

      it("if the burn amount is zero", async () => {
        await expect(burner.requestBurnMyStETHForCover(0n)).to.be.revertedWithCustomError(burner, "ZeroBurnAmount");
      });
    });

    it("Requests the specified amount of stETH to burn for cover", async () => {
      const balancesBefore = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      await expect(burner.connect(holder).requestBurnMyStETHForCover(burnAmount))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, await burner.getAddress(), burnAmount)
        .and.to.emit(burner, "StETHBurnRequested")
        .withArgs(true, holder.address, burnAmount, burnAmountInShares);

      const balancesAfter = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      expect(balancesAfter.holderBalance).to.equal(balancesBefore.holderBalance - burnAmount);
      expect(balancesAfter.sharesRequestToBurn["coverShares"]).to.equal(
        balancesBefore.sharesRequestToBurn["coverShares"] + burnAmountInShares,
      );
    });
  });

  context("requestBurnMyStETH/requestBurnMyShares", () => {
    beforeEach(async () => await setupBurnStETH());

    context("Reverts", () => {
      it("if the caller does not have the permission", async () => {
        await expect(burner.connect(stranger).requestBurnMyStETH(burnAmount)).to.be.revertedWithOZAccessControlError(
          stranger.address,
          await burner.REQUEST_BURN_MY_STETH_ROLE(),
        );

        await expect(burner.connect(stranger).requestBurnMyShares(burnAmount)).to.be.revertedWithOZAccessControlError(
          stranger.address,
          await burner.REQUEST_BURN_MY_STETH_ROLE(),
        );
      });

      it("if the burn amount is zero", async () => {
        await expect(burner.requestBurnMyStETH(0n)).to.be.revertedWithCustomError(burner, "ZeroBurnAmount");
        await expect(burner.requestBurnMyShares(0n)).to.be.revertedWithCustomError(burner, "ZeroBurnAmount");
      });
    });

    it("Requests the specified amount of stETH to burn by requestBurnMyStETH", async () => {
      const balancesBefore = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      await expect(burner.connect(holder).requestBurnMyStETH(burnAmount))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, await burner.getAddress(), burnAmount)
        .and.to.emit(burner, "StETHBurnRequested")
        .withArgs(false, holder.address, burnAmount, burnAmountInShares);

      const balancesAfter = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      expect(balancesAfter.holderBalance).to.equal(balancesBefore.holderBalance - burnAmount);
      expect(balancesAfter.sharesRequestToBurn["nonCoverShares"]).to.equal(
        balancesBefore.sharesRequestToBurn["nonCoverShares"] + burnAmountInShares,
      );
    });

    it("Requests the specified amount of stETH to burn by requestBurnMyShares", async () => {
      const balancesBefore = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      await expect(burner.connect(holder).requestBurnMyShares(burnAmountInShares))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, await burner.getAddress(), burnAmount)
        .and.to.emit(burner, "StETHBurnRequested")
        .withArgs(false, holder.address, burnAmount, burnAmountInShares);

      const balancesAfter = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      expect(balancesAfter.holderBalance).to.equal(balancesBefore.holderBalance - burnAmount);
      expect(balancesAfter.sharesRequestToBurn["nonCoverShares"]).to.equal(
        balancesBefore.sharesRequestToBurn["nonCoverShares"] + burnAmountInShares,
      );
    });
  });

  async function setupBurnShares() {
    burnAmount = await steth.balanceOf(holder);
    burnAmountInShares = await steth.getSharesByPooledEth(burnAmount);

    await expect(steth.approve(burner, burnAmount))
      .to.emit(steth, "Approval")
      .withArgs(holder.address, await burner.getAddress(), burnAmount);

    expect(await steth.allowance(holder, burner)).to.equal(burnAmount);
  }

  context("requestBurnSharesForCover", () => {
    beforeEach(async () => await setupBurnShares());

    context("Reverts", () => {
      it("if the caller does not have the permission", async () => {
        await expect(
          burner.connect(stranger).requestBurnSharesForCover(holder, burnAmount),
        ).to.be.revertedWithOZAccessControlError(stranger.address, await burner.REQUEST_BURN_SHARES_ROLE());
      });

      it("if the burn amount is zero", async () => {
        await expect(
          burner.connect(accountingSigner).requestBurnSharesForCover(holder, 0n),
        ).to.be.revertedWithCustomError(burner, "ZeroBurnAmount");
      });
    });

    it("Requests the specified amount of holder's shares to burn for cover", async () => {
      const balancesBefore = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      await expect(burner.connect(accountingSigner).requestBurnSharesForCover(holder, burnAmount))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, await burner.getAddress(), burnAmount)
        .and.to.emit(burner, "StETHBurnRequested")
        .withArgs(true, accounting, burnAmount, burnAmountInShares);

      const balancesAfter = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      expect(balancesAfter.holderBalance).to.equal(balancesBefore.holderBalance - burnAmount);
      expect(balancesAfter.sharesRequestToBurn["coverShares"]).to.equal(
        balancesBefore.sharesRequestToBurn["coverShares"] + burnAmountInShares,
      );
    });
  });

  context("requestBurnShares", () => {
    beforeEach(async () => await setupBurnShares());

    context("Reverts", () => {
      it("if the caller does not have the permission", async () => {
        await expect(
          burner.connect(stranger).requestBurnShares(holder, burnAmount),
        ).to.be.revertedWithOZAccessControlError(stranger.address, await burner.REQUEST_BURN_SHARES_ROLE());
      });

      it("if the burn amount is zero", async () => {
        await expect(burner.connect(accountingSigner).requestBurnShares(holder, 0n)).to.be.revertedWithCustomError(
          burner,
          "ZeroBurnAmount",
        );
      });
    });

    it("Requests the specified amount of holder's shares to burn", async () => {
      const balancesBefore = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      await expect(burner.connect(accountingSigner).requestBurnShares(holder, burnAmount))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, await burner.getAddress(), burnAmount)
        .and.to.emit(burner, "StETHBurnRequested")
        .withArgs(false, accounting, burnAmount, burnAmountInShares);

      const balancesAfter = await batch({
        holderBalance: steth.balanceOf(holder),
        sharesRequestToBurn: burner.getSharesRequestedToBurn(),
      });

      expect(balancesAfter.holderBalance).to.equal(balancesBefore.holderBalance - burnAmount);
      expect(balancesAfter.sharesRequestToBurn["nonCoverShares"]).to.equal(
        balancesBefore.sharesRequestToBurn["nonCoverShares"] + burnAmountInShares,
      );
    });
  });

  context("recoverExcessStETH", () => {
    it("Doesn't do anything if there's no excess steth", async () => {
      // making sure there's no excess steth, i.e. total shares request to burn == steth balance
      const { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn();

      expect(await steth.balanceOf(burner)).to.equal(coverShares + nonCoverShares);
      await expect(burner.recoverExcessStETH()).not.to.emit(burner, "ExcessStETHRecovered");
    });

    context("When some excess stETH", () => {
      const excessStethAmount = ether("1.0");

      beforeEach(async () => {
        expect(await steth.balanceOf(burner)).to.equal(0n);
        await steth.transfer(burner, excessStethAmount);

        expect(await steth.balanceOf(burner)).to.equal(excessStethAmount);
      });

      it("Transfers excess stETH to Treasury", async () => {
        const balancesBefore = await batch({
          burnerBalance: steth.balanceOf(burner),
          treasuryBalance: steth.balanceOf(treasury),
        });

        await expect(burner.recoverExcessStETH())
          .to.emit(burner, "ExcessStETHRecovered")
          .withArgs(holder.address, excessStethAmount, await steth.getSharesByPooledEth(excessStethAmount))
          .and.to.emit(steth, "Transfer")
          .withArgs(await burner.getAddress(), treasury, excessStethAmount);

        const balancesAfter = await batch({
          burnerBalance: steth.balanceOf(burner),
          treasuryBalance: steth.balanceOf(treasury),
        });

        expect(balancesAfter.burnerBalance).to.equal(balancesBefore.burnerBalance - excessStethAmount);
        expect(balancesAfter.treasuryBalance).to.equal(balancesBefore.treasuryBalance + excessStethAmount);
      });
    });
  });

  context("receive", () => {
    it("Reverts a direct ether transfer", async () => {
      await expect(
        holder.sendTransaction({
          to: burner,
          value: 1,
        }),
      ).to.be.revertedWithCustomError(burner, "DirectETHTransfer");
    });
  });

  context("recoverERC20", () => {
    let token: ERC20__Harness;

    beforeEach(async () => {
      token = await ethers.deployContract("ERC20__Harness", ["Token", "TKN"], deployer);
      await token.mint(burner, ether("1.0"));

      expect(await token.balanceOf(burner)).to.equal(ether("1.0"));
    });

    context("Reverts", () => {
      it("if recovering zero amount", async () => {
        await expect(burner.recoverERC20(token, 0n)).to.be.revertedWithCustomError(burner, "ZeroRecoveryAmount");
      });

      it("if recovering stETH", async () => {
        await expect(burner.recoverERC20(steth, 1n)).to.be.revertedWithCustomError(burner, "StETHRecoveryWrongFunc");
      });
    });

    it("Transfers the tokens to Treasury", async () => {
      const balancesBefore = await batch({
        burnerBalance: token.balanceOf(burner),
        treasuryBalance: token.balanceOf(treasury),
      });

      await expect(burner.recoverERC20(token, balancesBefore.burnerBalance))
        .to.emit(burner, "ERC20Recovered")
        .withArgs(holder.address, await token.getAddress(), balancesBefore.burnerBalance)
        .and.to.emit(token, "Transfer")
        .withArgs(await burner.getAddress(), treasury, balancesBefore.burnerBalance);

      const balancesAfter = await batch({
        burnerBalance: token.balanceOf(burner),
        treasuryBalance: token.balanceOf(treasury),
      });

      expect(balancesAfter.burnerBalance).to.equal(0n);
      expect(balancesAfter.treasuryBalance).to.equal(balancesBefore.treasuryBalance + balancesBefore.burnerBalance);
    });
  });

  context("recoverERC721", () => {
    let nft: ERC721__Harness;
    const tokenId = 1n;

    beforeEach(async () => {
      nft = await ethers.deployContract("ERC721__Harness", ["NFT", "NFT"], deployer);
      await nft.mint(burner, tokenId);

      expect(await nft.balanceOf(burner)).to.equal(1n);
      expect(await nft.ownerOf(tokenId)).to.equal(burner);
    });

    it("Reverts if recovering stETH", async () => {
      await expect(burner.recoverERC721(steth, tokenId)).to.be.revertedWithCustomError(
        burner,
        "StETHRecoveryWrongFunc",
      );
    });

    it("Transfers the NFT to Treasury", async () => {
      const balancesBefore = await batch({
        burnerBalance: nft.balanceOf(burner),
        treasuryBalance: nft.balanceOf(treasury),
      });

      await expect(burner.recoverERC721(nft, tokenId))
        .to.emit(burner, "ERC721Recovered")
        .withArgs(holder.address, await nft.getAddress(), tokenId)
        .and.to.emit(nft, "Transfer")
        .withArgs(await burner.getAddress(), treasury, tokenId);

      const balancesAfter = await batch({
        burnerBalance: nft.balanceOf(burner),
        treasuryBalance: nft.balanceOf(treasury),
        owner: nft.ownerOf(tokenId),
      });

      expect(balancesAfter.burnerBalance).to.equal(balancesBefore.burnerBalance - 1n);
      expect(balancesAfter.treasuryBalance).to.equal(balancesBefore.treasuryBalance + 1n);
      expect(balancesAfter.owner).to.equal(treasury);
    });
  });

  context("commitSharesToBurn", () => {
    beforeEach(async () => {
      await expect(steth.approve(burner, MaxUint256))
        .to.emit(steth, "Approval")
        .withArgs(holder.address, await burner.getAddress(), MaxUint256);

      expect(await steth.allowance(holder, burner)).to.equal(MaxUint256);
    });

    context("Reverts", () => {
      it("if the caller is not stETH", async () => {
        await expect(burner.connect(stranger).commitSharesToBurn(1n)).to.be.revertedWithCustomError(
          burner,
          "AppAuthFailed",
        );
      });

      it("if passing more shares to burn that what is stored on the contract", async () => {
        const { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn();
        const totalSharesRequestedToBurn = coverShares + nonCoverShares;
        const invalidAmount = totalSharesRequestedToBurn + 1n;

        await expect(burner.connect(accountingSigner).commitSharesToBurn(invalidAmount))
          .to.be.revertedWithCustomError(burner, "BurnAmountExceedsActual")
          .withArgs(invalidAmount, totalSharesRequestedToBurn);
      });
    });

    it("Doesn't do anything if passing zero shares to burn", async () => {
      await expect(burner.connect(accountingSigner).commitSharesToBurn(0n)).not.to.emit(burner, "StETHBurnt");
    });

    it("Marks shares as burnt when there are only cover shares to burn", async () => {
      const coverSharesToBurn = ether("1.0");

      // request cover share to burn
      await burner.connect(accountingSigner).requestBurnSharesForCover(holder, coverSharesToBurn);

      const balancesBefore = await batch({
        stethRequestedToBurn: steth.getSharesByPooledEth(coverSharesToBurn),
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      await expect(burner.connect(accountingSigner).commitSharesToBurn(coverSharesToBurn))
        .to.emit(burner, "StETHBurnt")
        .withArgs(true, balancesBefore.stethRequestedToBurn, coverSharesToBurn);

      const balancesAfter = await batch({
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      expect(balancesAfter.sharesRequestedToBurn.coverShares).to.equal(
        balancesBefore.sharesRequestedToBurn.coverShares - coverSharesToBurn,
      );
      expect(balancesAfter.coverSharesBurnt).to.equal(balancesBefore.coverSharesBurnt + coverSharesToBurn);
      expect(balancesAfter.nonCoverSharesBurnt).to.equal(balancesBefore.nonCoverSharesBurnt);
    });

    it("Marks shares as burnt when there are only cover shares to burn", async () => {
      const nonCoverSharesToBurn = ether("1.0");

      await burner.connect(accountingSigner).requestBurnShares(holder, nonCoverSharesToBurn);

      const balancesBefore = await batch({
        stethRequestedToBurn: steth.getSharesByPooledEth(nonCoverSharesToBurn),
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      await expect(burner.connect(accountingSigner).commitSharesToBurn(nonCoverSharesToBurn))
        .to.emit(burner, "StETHBurnt")
        .withArgs(false, balancesBefore.stethRequestedToBurn, nonCoverSharesToBurn);

      const balancesAfter = await batch({
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      expect(balancesAfter.sharesRequestedToBurn.nonCoverShares).to.equal(
        balancesBefore.sharesRequestedToBurn.nonCoverShares - nonCoverSharesToBurn,
      );
      expect(balancesAfter.nonCoverSharesBurnt).to.equal(balancesBefore.nonCoverSharesBurnt + nonCoverSharesToBurn);
      expect(balancesAfter.coverSharesBurnt).to.equal(balancesBefore.coverSharesBurnt);
    });

    it("Marks shares as burnt when there are both cover and non-cover shares to burn", async () => {
      const coverSharesToBurn = ether("1.0");
      const nonCoverSharesToBurn = ether("2.0");
      const totalCoverSharesToBurn = coverSharesToBurn + nonCoverSharesToBurn;

      await burner.connect(accountingSigner).requestBurnSharesForCover(holder, coverSharesToBurn);
      await burner.connect(accountingSigner).requestBurnShares(holder, nonCoverSharesToBurn);

      const balancesBefore = await batch({
        coverStethRequestedToBurn: steth.getSharesByPooledEth(coverSharesToBurn),
        nonCoverStethRequestedToBurn: steth.getSharesByPooledEth(nonCoverSharesToBurn),
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      await expect(burner.connect(accountingSigner).commitSharesToBurn(totalCoverSharesToBurn))
        .to.emit(burner, "StETHBurnt")
        .withArgs(true, balancesBefore.coverStethRequestedToBurn, coverSharesToBurn)
        .and.to.emit(burner, "StETHBurnt")
        .withArgs(false, balancesBefore.nonCoverStethRequestedToBurn, nonCoverSharesToBurn);

      const balancesAfter = await batch({
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      expect(balancesAfter.sharesRequestedToBurn.coverShares).to.equal(
        balancesBefore.sharesRequestedToBurn.coverShares - coverSharesToBurn,
      );
      expect(balancesAfter.coverSharesBurnt).to.equal(balancesBefore.coverSharesBurnt + coverSharesToBurn);

      expect(balancesAfter.sharesRequestedToBurn.nonCoverShares).to.equal(
        balancesBefore.sharesRequestedToBurn.nonCoverShares - nonCoverSharesToBurn,
      );
      expect(balancesAfter.nonCoverSharesBurnt).to.equal(balancesBefore.nonCoverSharesBurnt + nonCoverSharesToBurn);
    });
  });

  context("getSharesRequestedToBurn", () => {
    it("Returns cover and non-cover shares requested to burn", async () => {
      const coverSharesToBurn = ether("1.0");
      const nonCoverSharesToBurn = ether("2.0");
      await steth.approve(burner, MaxUint256);

      const balancesBefore = await burner.getSharesRequestedToBurn();
      expect(balancesBefore.coverShares).to.equal(0);
      expect(balancesBefore.nonCoverShares).to.equal(0);

      await burner.connect(accountingSigner).requestBurnSharesForCover(holder, coverSharesToBurn);
      await burner.connect(accountingSigner).requestBurnShares(holder, nonCoverSharesToBurn);

      const balancesAfter = await burner.getSharesRequestedToBurn();
      expect(balancesAfter.coverShares).to.equal(coverSharesToBurn);
      expect(balancesAfter.nonCoverShares).to.equal(nonCoverSharesToBurn);
    });
  });

  context("getCoverSharesBurnt", () => {
    it("Returns cover and non-cover shares requested to burn", async () => {
      const coverSharesToBurn = ether("1.0");
      await steth.approve(burner, MaxUint256);

      await burner.getSharesRequestedToBurn();
      await burner.connect(accountingSigner).requestBurnSharesForCover(holder, coverSharesToBurn);

      const coverSharesToBurnBefore = await burner.getCoverSharesBurnt();

      await burner.connect(accountingSigner).commitSharesToBurn(coverSharesToBurn);

      expect(await burner.getCoverSharesBurnt()).to.equal(coverSharesToBurnBefore + coverSharesToBurn);
    });
  });

  context("getNonCoverSharesBurnt", () => {
    it("Returns cover and non-cover shares requested to burn", async () => {
      const nonCoverSharesToBurn = ether("1.0");
      await steth.approve(burner, MaxUint256);

      await burner.getSharesRequestedToBurn();
      await burner.connect(accountingSigner).requestBurnShares(holder, nonCoverSharesToBurn);

      const nonCoverSharesToBurnBefore = await burner.getNonCoverSharesBurnt();

      await burner.connect(accountingSigner).commitSharesToBurn(nonCoverSharesToBurn);

      expect(await burner.getNonCoverSharesBurnt()).to.equal(nonCoverSharesToBurnBefore + nonCoverSharesToBurn);
    });
  });

  context("getExcessStETH", () => {
    it("Returns the amount of unaccounted stETH on the burner contract", async () => {
      expect(await steth.balanceOf(burner)).to.equal(0n);

      const excessStethAmount = ether("1.0");
      await steth.transfer(burner, excessStethAmount);

      expect(await steth.balanceOf(burner)).to.equal(excessStethAmount);
      expect(await burner.getExcessStETH()).to.equal(excessStethAmount);
    });

    it("Returns zero if the amount of share on the contract is greater than requested to burn", async () => {
      const { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn();
      expect(await steth.balanceOf(burner)).to.equal(0n);
      expect(coverShares).to.equal(0n);
      expect(nonCoverShares).to.equal(0n);

      await steth.connect(accountingSigner).harness__mintShares(burner, 1n);

      expect(await burner.getExcessStETH()).to.equal(0n);
    });
  });
});
