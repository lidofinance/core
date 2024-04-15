import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Burner,
  Burner__factory,
  ERC20Token__MockForBurner,
  ERC20Token__MockForBurner__factory,
  NFT__GeneralMock,
  NFT__GeneralMock__factory,
  Steth__MinimalMock,
  Steth__MinimalMock__factory,
} from "typechain-types";

import { batch, certainAddress, ether, impersonate } from "lib";

describe("Burner", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let stethAsSigner: HardhatEthersSigner;

  let burner: Burner;
  let steth: Steth__MinimalMock;
  const treasury = certainAddress("test:burner:treasury");

  const coverSharesBurnt = 0n;
  const nonCoverSharesBurnt = 0n;

  beforeEach(async () => {
    [deployer, admin, holder, stranger] = await ethers.getSigners();

    steth = await new Steth__MinimalMock__factory(deployer).deploy(holder, { value: ether("10.0") });
    burner = await new Burner__factory(deployer).deploy(admin, treasury, steth, coverSharesBurnt, nonCoverSharesBurnt);

    steth = steth.connect(holder);
    burner = burner.connect(holder);

    stethAsSigner = await impersonate(await steth.getAddress(), ether("1.0"));
  });

  context("constructor", () => {
    it("Sets up roles, addresses and shares burnt", async () => {
      const adminRole = await burner.DEFAULT_ADMIN_ROLE();
      expect(await burner.getRoleMemberCount(adminRole)).to.equal(1);
      expect(await burner.hasRole(adminRole, admin)).to.equal(true);

      const requestBurnSharesRole = await burner.REQUEST_BURN_SHARES_ROLE();
      expect(await burner.getRoleMemberCount(requestBurnSharesRole)).to.equal(1);
      expect(await burner.hasRole(requestBurnSharesRole, steth)).to.equal(true);

      expect(await burner.STETH()).to.equal(steth);
      expect(await burner.TREASURY()).to.equal(treasury);

      expect(await burner.getCoverSharesBurnt()).to.equal(coverSharesBurnt);
      expect(await burner.getNonCoverSharesBurnt()).to.equal(nonCoverSharesBurnt);
    });

    it("Sets shares burnt to non-zero values", async () => {
      const coverSharesBurnt = 1n;
      const nonCoverSharesBurnt = 3n;

      burner = await new Burner__factory(deployer).deploy(
        admin,
        treasury,
        steth,
        coverSharesBurnt,
        nonCoverSharesBurnt,
      );
      expect(await burner.getCoverSharesBurnt()).to.equal(coverSharesBurnt);
      expect(await burner.getNonCoverSharesBurnt()).to.equal(nonCoverSharesBurnt);
    });

    it("Reverts if admin is zero address", async () => {
      await expect(
        new Burner__factory(deployer).deploy(ZeroAddress, treasury, steth, coverSharesBurnt, nonCoverSharesBurnt),
      )
        .to.be.revertedWithCustomError(burner, "ZeroAddress")
        .withArgs("_admin");
    });

    it("Reverts if Treasury is zero address", async () => {
      await expect(
        new Burner__factory(deployer).deploy(admin, ZeroAddress, steth, coverSharesBurnt, nonCoverSharesBurnt),
      )
        .to.be.revertedWithCustomError(burner, "ZeroAddress")
        .withArgs("_treasury");
    });

    it("Reverts if stETH is zero address", async () => {
      await expect(
        new Burner__factory(deployer).deploy(admin, treasury, ZeroAddress, coverSharesBurnt, nonCoverSharesBurnt),
      )
        .to.be.revertedWithCustomError(burner, "ZeroAddress")
        .withArgs("_stETH");
    });
  });

  for (const isCover of [false, true]) {
    const requestBurnMethod = isCover ? "requestBurnMyStETHForCover" : "requestBurnMyStETH";
    const sharesType = isCover ? "coverShares" : "nonCoverShares";

    context(requestBurnMethod, () => {
      let burnAmount: bigint;
      let burnAmountInShares: bigint;

      beforeEach(async () => {
        // holder does not yet have permission
        const requestBurnMyStethRole = await burner.REQUEST_BURN_MY_STETH_ROLE();
        expect(await burner.getRoleMemberCount(requestBurnMyStethRole)).to.equal(0);
        expect(await burner.hasRole(requestBurnMyStethRole, holder)).to.equal(false);

        await burner.connect(admin).grantRole(requestBurnMyStethRole, holder);

        // holder now has the permission
        expect(await burner.getRoleMemberCount(requestBurnMyStethRole)).to.equal(1);
        expect(await burner.hasRole(requestBurnMyStethRole, holder)).to.equal(true);

        burnAmount = await steth.balanceOf(holder);
        burnAmountInShares = await steth.getSharesByPooledEth(burnAmount);

        await expect(steth.approve(burner, burnAmount))
          .to.emit(steth, "Approval")
          .withArgs(holder.address, await burner.getAddress(), burnAmount);

        expect(await steth.allowance(holder, burner)).to.equal(burnAmount);
      });

      it("Requests the specified amount of stETH to burn for cover", async () => {
        const before = await batch({
          holderBalance: steth.balanceOf(holder),
          sharesRequestToBurn: burner.getSharesRequestedToBurn(),
        });

        await expect(burner[requestBurnMethod](burnAmount))
          .to.emit(steth, "Transfer")
          .withArgs(holder.address, await burner.getAddress(), burnAmount)
          .and.to.emit(burner, "StETHBurnRequested")
          .withArgs(isCover, holder.address, burnAmount, burnAmountInShares);

        const after = await batch({
          holderBalance: steth.balanceOf(holder),
          sharesRequestToBurn: burner.getSharesRequestedToBurn(),
        });

        expect(after.holderBalance).to.equal(before.holderBalance - burnAmount);
        expect(after.sharesRequestToBurn[sharesType]).to.equal(
          before.sharesRequestToBurn[sharesType] + burnAmountInShares,
        );
      });

      it("Reverts if the caller does not have the permission", async () => {
        await expect(burner.connect(stranger)[requestBurnMethod](burnAmount)).to.be.revertedWithOZAccessControlError(
          stranger.address,
          await burner.REQUEST_BURN_MY_STETH_ROLE(),
        );
      });

      it("Reverts if the burn amount is zero", async () => {
        await expect(burner[requestBurnMethod](0n)).to.be.revertedWithCustomError(burner, "ZeroBurnAmount");
      });
    });
  }

  for (const isCover of [false, true]) {
    const requestBurnMethod = isCover ? "requestBurnSharesForCover" : "requestBurnShares";
    const sharesType = isCover ? "coverShares" : "nonCoverShares";

    context(requestBurnMethod, () => {
      let burnAmount: bigint;
      let burnAmountInShares: bigint;

      beforeEach(async () => {
        burnAmount = await steth.balanceOf(holder);
        burnAmountInShares = await steth.getSharesByPooledEth(burnAmount);

        await expect(steth.approve(burner, burnAmount))
          .to.emit(steth, "Approval")
          .withArgs(holder.address, await burner.getAddress(), burnAmount);

        expect(await steth.allowance(holder, burner)).to.equal(burnAmount);

        burner = burner.connect(stethAsSigner);
      });

      it("Requests the specified amount of holder's shares to burn for cover", async () => {
        const before = await batch({
          holderBalance: steth.balanceOf(holder),
          sharesRequestToBurn: burner.getSharesRequestedToBurn(),
        });

        await expect(burner[requestBurnMethod](holder, burnAmount))
          .to.emit(steth, "Transfer")
          .withArgs(holder.address, await burner.getAddress(), burnAmount)
          .and.to.emit(burner, "StETHBurnRequested")
          .withArgs(isCover, await steth.getAddress(), burnAmount, burnAmountInShares);

        const after = await batch({
          holderBalance: steth.balanceOf(holder),
          sharesRequestToBurn: burner.getSharesRequestedToBurn(),
        });

        expect(after.holderBalance).to.equal(before.holderBalance - burnAmount);
        expect(after.sharesRequestToBurn[sharesType]).to.equal(
          before.sharesRequestToBurn[sharesType] + burnAmountInShares,
        );
      });

      it("Reverts if the caller does not have the permission", async () => {
        await expect(
          burner.connect(stranger)[requestBurnMethod](holder, burnAmount),
        ).to.be.revertedWithOZAccessControlError(stranger.address, await burner.REQUEST_BURN_SHARES_ROLE());
      });

      it("Reverts if the burn amount is zero", async () => {
        await expect(burner[requestBurnMethod](holder, 0n)).to.be.revertedWithCustomError(burner, "ZeroBurnAmount");
      });
    });
  }

  context("recoverExcessStETH", () => {
    it("Doesn't do anything if there's no excess steth", async () => {
      // making sure there's no excess steth, i.e. total shares request to burn == steth balance
      const { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn();
      expect(await steth.balanceOf(burner)).to.equal(coverShares + nonCoverShares);
      await expect(burner.recoverExcessStETH()).not.to.emit(burner, "ExcessStETHRecovered");
    });

    context("When there is some excess stETH", () => {
      const excessStethAmount = ether("1.0");

      beforeEach(async () => {
        expect(await steth.balanceOf(burner)).to.equal(0n);
        await steth.transfer(burner, excessStethAmount);

        expect(await steth.balanceOf(burner)).to.equal(excessStethAmount);
      });

      it("Transfers excess stETH to Treasury", async () => {
        const before = await batch({
          burnerBalance: steth.balanceOf(burner),
          treasuryBalance: steth.balanceOf(treasury),
        });

        await expect(burner.recoverExcessStETH())
          .to.emit(burner, "ExcessStETHRecovered")
          .withArgs(holder.address, excessStethAmount, await steth.getSharesByPooledEth(excessStethAmount))
          .and.to.emit(steth, "Transfer")
          .withArgs(await burner.getAddress(), treasury, excessStethAmount);

        const after = await batch({
          burnerBalance: steth.balanceOf(burner),
          treasuryBalance: steth.balanceOf(treasury),
        });

        expect(after.burnerBalance).to.equal(before.burnerBalance - excessStethAmount);
        expect(after.treasuryBalance).to.equal(before.treasuryBalance + excessStethAmount);
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
    let token: ERC20Token__MockForBurner;

    beforeEach(async () => {
      token = await new ERC20Token__MockForBurner__factory(deployer).deploy("Token", "TKN");
      await token.mint(burner, ether("1.0"));

      expect(await token.balanceOf(burner)).to.equal(ether("1.0"));
    });

    it("Reverts if recovering zero amount", async () => {
      await expect(burner.recoverERC20(token, 0n)).to.be.revertedWithCustomError(burner, "ZeroRecoveryAmount");
    });

    it("Reverts if recovering stETH", async () => {
      await expect(burner.recoverERC20(steth, 1n)).to.be.revertedWithCustomError(burner, "StETHRecoveryWrongFunc");
    });

    it("Transfers the tokens to Treasury", async () => {
      const before = await batch({
        burnerBalance: token.balanceOf(burner),
        treasuryBalance: token.balanceOf(treasury),
      });

      await expect(burner.recoverERC20(token, before.burnerBalance))
        .to.emit(burner, "ERC20Recovered")
        .withArgs(holder.address, await token.getAddress(), before.burnerBalance)
        .and.to.emit(token, "Transfer")
        .withArgs(await burner.getAddress(), treasury, before.burnerBalance);

      const after = await batch({
        burnerBalance: token.balanceOf(burner),
        treasuryBalance: token.balanceOf(treasury),
      });

      expect(after.burnerBalance).to.equal(0n);
      expect(after.treasuryBalance).to.equal(before.treasuryBalance + before.burnerBalance);
    });
  });

  context("recoverERC721", () => {
    let nft: NFT__GeneralMock;
    const tokenId = 1n;

    beforeEach(async () => {
      nft = await new NFT__GeneralMock__factory(deployer).deploy("NFT", "NFT");
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
      const before = await batch({
        burnerBalance: nft.balanceOf(burner),
        treasuryBalance: nft.balanceOf(treasury),
      });

      await expect(burner.recoverERC721(nft, tokenId))
        .to.emit(burner, "ERC721Recovered")
        .withArgs(holder.address, await nft.getAddress(), tokenId)
        .and.to.emit(nft, "Transfer")
        .withArgs(await burner.getAddress(), treasury, tokenId);

      const after = await batch({
        burnerBalance: nft.balanceOf(burner),
        treasuryBalance: nft.balanceOf(treasury),
        owner: nft.ownerOf(tokenId),
      });

      expect(after.burnerBalance).to.equal(before.burnerBalance - 1n);
      expect(after.treasuryBalance).to.equal(before.treasuryBalance + 1n);
      expect(after.owner).to.equal(treasury);
    });
  });

  context("commitSharesToBurn", () => {
    beforeEach(async () => {
      await expect(steth.approve(burner, MaxUint256))
        .to.emit(steth, "Approval")
        .withArgs(holder.address, await burner.getAddress(), MaxUint256);

      expect(await steth.allowance(holder, burner)).to.equal(MaxUint256);

      burner = burner.connect(stethAsSigner);
    });

    it("Reverts if the caller is not stETH", async () => {
      await expect(burner.connect(stranger).commitSharesToBurn(1n)).to.be.revertedWithCustomError(
        burner,
        "AppAuthLidoFailed",
      );
    });

    it("Doesn't do anything if passing zero shares to burn", async () => {
      await expect(burner.connect(stethAsSigner).commitSharesToBurn(0n)).not.to.emit(burner, "StETHBurnt");
    });

    it("Reverts if passing more shares to burn that what is stored on the contract", async () => {
      const { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn();
      const totalSharesRequestedToBurn = coverShares + nonCoverShares;
      const invalidAmount = totalSharesRequestedToBurn + 1n;

      await expect(burner.commitSharesToBurn(invalidAmount))
        .to.be.revertedWithCustomError(burner, "BurnAmountExceedsActual")
        .withArgs(invalidAmount, totalSharesRequestedToBurn);
    });

    it("Marks shares as burnt when there are only cover shares to burn", async () => {
      const coverSharesToBurn = ether("1.0");

      // request cover share to burn
      await burner.requestBurnSharesForCover(holder, coverSharesToBurn);

      const before = await batch({
        stethRequestedToBurn: steth.getSharesByPooledEth(coverSharesToBurn),
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      await expect(burner.commitSharesToBurn(coverSharesToBurn))
        .to.emit(burner, "StETHBurnt")
        .withArgs(true, before.stethRequestedToBurn, coverSharesToBurn);

      const after = await batch({
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      expect(after.sharesRequestedToBurn.coverShares).to.equal(
        before.sharesRequestedToBurn.coverShares - coverSharesToBurn,
      );
      expect(after.coverSharesBurnt).to.equal(before.coverSharesBurnt + coverSharesToBurn);
      expect(after.nonCoverSharesBurnt).to.equal(before.nonCoverSharesBurnt);
    });

    it("Marks shares as burnt when there are only cover shares to burn", async () => {
      const nonCoverSharesToBurn = ether("1.0");

      await burner.requestBurnShares(holder, nonCoverSharesToBurn);

      const before = await batch({
        stethRequestedToBurn: steth.getSharesByPooledEth(nonCoverSharesToBurn),
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      await expect(burner.commitSharesToBurn(nonCoverSharesToBurn))
        .to.emit(burner, "StETHBurnt")
        .withArgs(false, before.stethRequestedToBurn, nonCoverSharesToBurn);

      const after = await batch({
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      expect(after.sharesRequestedToBurn.nonCoverShares).to.equal(
        before.sharesRequestedToBurn.nonCoverShares - nonCoverSharesToBurn,
      );
      expect(after.nonCoverSharesBurnt).to.equal(before.nonCoverSharesBurnt + nonCoverSharesToBurn);
      expect(after.coverSharesBurnt).to.equal(before.coverSharesBurnt);
    });

    it("Marks shares as burnt when there are both cover and non-cover shares to burn", async () => {
      const coverSharesToBurn = ether("1.0");
      const nonCoverSharesToBurn = ether("2.0");
      const totalCoverSharesToBurn = coverSharesToBurn + nonCoverSharesToBurn;

      await burner.requestBurnSharesForCover(holder, coverSharesToBurn);
      await burner.requestBurnShares(holder, nonCoverSharesToBurn);

      const before = await batch({
        coverStethRequestedToBurn: steth.getSharesByPooledEth(coverSharesToBurn),
        nonCoverStethRequestedToBurn: steth.getSharesByPooledEth(nonCoverSharesToBurn),
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      await expect(burner.commitSharesToBurn(totalCoverSharesToBurn))
        .to.emit(burner, "StETHBurnt")
        .withArgs(true, before.coverStethRequestedToBurn, coverSharesToBurn)
        .and.to.emit(burner, "StETHBurnt")
        .withArgs(false, before.nonCoverStethRequestedToBurn, nonCoverSharesToBurn);

      const after = await batch({
        sharesRequestedToBurn: burner.getSharesRequestedToBurn(),
        coverSharesBurnt: burner.getCoverSharesBurnt(),
        nonCoverSharesBurnt: burner.getNonCoverSharesBurnt(),
      });

      expect(after.sharesRequestedToBurn.coverShares).to.equal(
        before.sharesRequestedToBurn.coverShares - coverSharesToBurn,
      );
      expect(after.coverSharesBurnt).to.equal(before.coverSharesBurnt + coverSharesToBurn);

      expect(after.sharesRequestedToBurn.nonCoverShares).to.equal(
        before.sharesRequestedToBurn.nonCoverShares - nonCoverSharesToBurn,
      );
      expect(after.nonCoverSharesBurnt).to.equal(before.nonCoverSharesBurnt + nonCoverSharesToBurn);
    });
  });

  context("getSharesRequestedToBurn", () => {
    it("Returns cover and non-cover shares requested to burn", async () => {
      const coverSharesToBurn = ether("1.0");
      const nonCoverSharesToBurn = ether("2.0");

      await steth.approve(burner, MaxUint256);
      burner = burner.connect(stethAsSigner);

      const before = await burner.getSharesRequestedToBurn();
      expect(before.coverShares).to.equal(0);
      expect(before.nonCoverShares).to.equal(0);

      await burner.requestBurnSharesForCover(holder, coverSharesToBurn);
      await burner.requestBurnShares(holder, nonCoverSharesToBurn);

      const after = await burner.getSharesRequestedToBurn();
      expect(after.coverShares).to.equal(coverSharesToBurn);
      expect(after.nonCoverShares).to.equal(nonCoverSharesToBurn);
    });
  });

  context("getCoverSharesBurnt", () => {
    it("Returns cover and non-cover shares requested to burn", async () => {
      const coverSharesToBurn = ether("1.0");
      await steth.approve(burner, MaxUint256);
      burner = burner.connect(stethAsSigner);
      await burner.getSharesRequestedToBurn();
      await burner.requestBurnSharesForCover(holder, coverSharesToBurn);

      const coverSharesToBurnBefore = await burner.getCoverSharesBurnt();

      await burner.commitSharesToBurn(coverSharesToBurn);

      expect(await burner.getCoverSharesBurnt()).to.equal(coverSharesToBurnBefore + coverSharesToBurn);
    });
  });

  context("getNonCoverSharesBurnt", () => {
    it("Returns cover and non-cover shares requested to burn", async () => {
      const nonCoverSharesToBurn = ether("1.0");
      await steth.approve(burner, MaxUint256);
      burner = burner.connect(stethAsSigner);
      await burner.getSharesRequestedToBurn();
      await burner.requestBurnShares(holder, nonCoverSharesToBurn);

      const nonCoverSharesToBurnBefore = await burner.getNonCoverSharesBurnt();

      await burner.commitSharesToBurn(nonCoverSharesToBurn);

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

      await steth.mintShares(burner, 1n);

      expect(await burner.getExcessStETH()).to.equal(0n);
    });
  });
});
