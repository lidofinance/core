import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StETH__HarnessForWstETH, WstETH } from "typechain-types";

import { batch, ether, ONE_ETHER } from "lib";

import { Snapshot } from "test/suite";

describe("WstETH.sol", () => {
  let steth: StETH__HarnessForWstETH;
  let wsteth: WstETH;

  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [deployer, user] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__HarnessForWstETH", [user], { value: ether("1.0"), from: deployer });
    wsteth = await ethers.deployContract("WstETH", [steth], deployer);

    steth = steth.connect(user);
    wsteth = wsteth.connect(user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("wrap", () => {
    beforeEach(async () => {
      // steth must be approved before wrapping
      await steth.approve(wsteth, MaxUint256);
      expect(await steth.allowance(user, wsteth)).to.equal(MaxUint256);
    });

    it("Reverts if wrapping 0 stETH", async () => {
      await expect(wsteth.wrap(0n)).to.be.revertedWith("wstETH: can't wrap zero stETH");
    });

    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`Swaps stETH for wstETH after a ${rebase} rebase`, async () => {
        // simulating rebase
        const totalSupply = await steth.totalSupply();
        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        const beforeWrap = await batch({
          stethBalance: steth.balanceOf(user),
          wstethBalance: wsteth.balanceOf(user),
        });

        // wsteth == shares
        const expectedWstethBalance = await steth.getSharesByPooledEth(beforeWrap.stethBalance);

        // wrap
        // mint wstETH to user
        // lock stETH on wstETH contract
        await expect(wsteth.wrap(beforeWrap.stethBalance))
          .to.emit(wsteth, "Transfer")
          .withArgs(ZeroAddress, user, expectedWstethBalance)
          .and.to.emit(steth, "Transfer")
          .withArgs(user.address, await wsteth.getAddress(), beforeWrap.stethBalance);

        const afterWrap = await batch({
          stethBalance: steth.balanceOf(user),
          wstethBalance: wsteth.balanceOf(user),
        });

        expect(afterWrap.stethBalance).to.equal(0n);
        expect(afterWrap.wstethBalance).to.equal(expectedWstethBalance);
      });

      it("Returns the amount of wstETH minted", async () => {
        // simulating rebase
        const totalSupply = await steth.totalSupply();
        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        const stethAmount = await steth.balanceOf(user);
        const expectedWsteth = await steth.getSharesByPooledEth(stethAmount);
        const wstethMinted = await wsteth.wrap.staticCall(stethAmount);

        expect(wstethMinted).to.equal(expectedWsteth);
      });
    }
  });

  context("unwrap", () => {
    beforeEach(async () => {
      // steth must be approved before wrapping
      await steth.approve(wsteth, MaxUint256);
      expect(await steth.allowance(user, wsteth)).to.equal(MaxUint256);

      const userBalance = await steth.balanceOf(user);
      await wsteth.wrap(userBalance);

      expect(await wsteth.balanceOf(user)).to.equal(await steth.getSharesByPooledEth(userBalance));
    });

    it("Reverts if unwrapping 0 wstETH", async () => {
      await expect(wsteth.unwrap(0n)).to.be.revertedWith("wstETH: zero amount unwrap not allowed");
    });

    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`Swaps wstETH for stETH after a ${rebase} rebase`, async () => {
        // simulating rebase
        const totalSupply = await steth.totalSupply();
        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        const beforeWrap = await batch({
          stethBalance: steth.balanceOf(user),
          wstethBalance: wsteth.balanceOf(user),
        });

        // wsteth == shares
        const expectedStethBalance = await steth.getPooledEthByShares(beforeWrap.wstethBalance);

        // wrap
        // mint wstETH to user
        // lock stETH on wstETH contract
        await expect(wsteth.unwrap(beforeWrap.wstethBalance))
          .to.emit(wsteth, "Transfer")
          .withArgs(user, ZeroAddress, beforeWrap.wstethBalance)
          .and.to.emit(steth, "Transfer")
          .withArgs(await wsteth.getAddress(), user.address, expectedStethBalance);

        const afterWrap = await batch({
          stethBalance: steth.balanceOf(user),
          wstethBalance: wsteth.balanceOf(user),
        });

        expect(afterWrap.stethBalance).to.equal(expectedStethBalance);
        expect(afterWrap.wstethBalance).to.equal(0n);
      });

      it("Returns the amount of stETH", async () => {
        // simulating rebase
        const totalSupply = await steth.totalSupply();
        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        const wstethAmount = await wsteth.balanceOf(user);
        const expectedSteth = await steth.getPooledEthByShares(wstethAmount);
        const stethReturned = await wsteth.unwrap.staticCall(wstethAmount);

        expect(stethReturned).to.equal(expectedSteth);
      });
    }
  });

  context("receive", () => {
    it("Stakes ether and mints wstETH to the caller", async () => {
      const transferAmount = ether("1.0");
      const expectedWsteth = await steth.getSharesByPooledEth(transferAmount);

      await expect(
        user.sendTransaction({
          to: wsteth,
          value: transferAmount,
        }),
      )
        .to.emit(wsteth, "Transfer")
        .withArgs(ZeroAddress, user.address, expectedWsteth);

      expect(await steth.balanceOf(wsteth)).to.equal(transferAmount);
      expect(await wsteth.balanceOf(user)).to.equal(expectedWsteth);
    });
  });

  context("getWstETHByStETH", () => {
    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      for (const value of [0, 1, ether("1.0"), ether("1.0") + 1n]) {
        it(`Returns the price of ${value} stETH in wstETH after a ${rebase} rebase`, async () => {
          const totalSupply = await steth.totalSupply();
          const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
          await steth.setTotalPooledEther(rebasedSupply);

          expect(await wsteth.getWstETHByStETH(value)).to.equal(await steth.getSharesByPooledEth(value));
        });
      }
    }
  });

  context("getStETHByWstETH", () => {
    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      for (const value of [0, 1, ether("1.0"), ether("1.0") + 1n]) {
        it(`Returns the price of ${value} wstETH in stETH after a ${rebase} rebase`, async () => {
          const totalSupply = await steth.totalSupply();
          const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
          await steth.setTotalPooledEther(rebasedSupply);

          expect(await wsteth.getStETHByWstETH(value)).to.equal(await steth.getPooledEthByShares(value));
        });
      }
    }
  });

  context("stEthPerToken", () => {
    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`Returns the price of 1 wstETH in stETH after a ${rebase} rebase`, async () => {
        const totalSupply = await steth.totalSupply();
        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        expect(await wsteth.stEthPerToken()).to.equal(await steth.getPooledEthByShares(ONE_ETHER));
      });
    }
  });

  context("tokensPerStEth", () => {
    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`Returns the price of 1 stETH in wstETH after a ${rebase} rebase`, async () => {
        const totalSupply = await steth.totalSupply();
        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        expect(await wsteth.tokensPerStEth()).to.equal(await steth.getSharesByPooledEth(ONE_ETHER));
      });
    }
  });
});
