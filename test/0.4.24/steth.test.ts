import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StETH__Harness } from "typechain-types";

import { batch, ether, impersonate, ONE_ETHER } from "lib";

import { Snapshot } from "test/suite";

const ONE_STETH = 10n ** 18n;
const ONE_SHARE = 10n ** 18n;

describe("StETH.sol:non-ERC-20 behavior", () => {
  let deployer: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let spender: HardhatEthersSigner;
  // required for some strictly theoretical branch checks
  let zeroAddressSigner: HardhatEthersSigner;

  const holderBalance = ether("10.0");
  const totalSupply = holderBalance;

  let steth: StETH__Harness;

  let originalState: string;

  before(async () => {
    zeroAddressSigner = await impersonate(ZeroAddress, ONE_ETHER);

    [deployer, holder, recipient, spender] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__Harness", [holder], { value: holderBalance, from: deployer });
    steth = steth.connect(holder);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getTotalPooledEther", () => {
    it("Returns the amount of ether sent upon construction", async () => {
      expect(await steth.getTotalPooledEther()).to.equal(totalSupply);
    });

    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`Returns the correct value after ${rebase} rebase`, async () => {
        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        expect(await steth.getTotalPooledEther()).to.equal(rebasedSupply);
      });
    }
  });

  context("transfer", () => {
    it("Transfers stETH to the recipient and fires the `Transfer` and `TransferShares` events", async () => {
      const beforeTransfer = await batch({
        holderBalance: steth.balanceOf(holder),
        recipientBalance: steth.balanceOf(recipient),
      });

      const transferAmount = beforeTransfer.holderBalance;
      const transferAmountInShares = await steth.getSharesByPooledEth(beforeTransfer.holderBalance);

      await expect(steth.transfer(recipient, transferAmount))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, recipient.address, transferAmount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(holder.address, recipient.address, transferAmountInShares);

      const afterTransfer = await batch({
        holderBalance: steth.balanceOf(holder),
        recipientBalance: steth.balanceOf(recipient),
      });

      expect(afterTransfer.holderBalance).to.equal(beforeTransfer.holderBalance - transferAmount);
      expect(afterTransfer.recipientBalance).to.equal(beforeTransfer.recipientBalance + transferAmount);
    });

    it("Reverts when the recipient is zero address", async () => {
      const transferAmount = await steth.balanceOf(holder);

      await expect(steth.transfer(ZeroAddress, transferAmount)).to.be.revertedWith("TRANSFER_TO_ZERO_ADDR");
    });

    it("Reverts when the recipient is stETH contract", async () => {
      const transferAmount = await steth.balanceOf(holder);

      await expect(steth.transfer(steth, transferAmount)).to.be.revertedWith("TRANSFER_TO_STETH_CONTRACT");
    });
  });

  context("transferShares", () => {
    it("Transfers shares to the recipient and fires the `Transfer` and `TransferShares` events", async () => {
      const beforeTransfer = await batch({
        holderShares: steth.sharesOf(holder),
        recipientShares: steth.sharesOf(recipient),
      });

      const transferAmount = await steth.getPooledEthByShares(beforeTransfer.holderShares);
      const transferAmountInShares = beforeTransfer.holderShares;

      await expect(steth.transferShares(recipient, transferAmountInShares))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, recipient.address, transferAmount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(holder.address, recipient.address, transferAmountInShares);

      const afterTransfer = await batch({
        holderShares: steth.sharesOf(holder),
        recipientShares: steth.sharesOf(recipient),
      });

      expect(afterTransfer.holderShares).to.equal(beforeTransfer.holderShares - transferAmountInShares);
      expect(afterTransfer.recipientShares).to.equal(beforeTransfer.recipientShares + transferAmountInShares);
    });

    it("Reverts when the recipient is zero address", async () => {
      const transferAmountOfShares = await steth.sharesOf(holder);

      await expect(steth.transferShares(ZeroAddress, transferAmountOfShares)).to.be.revertedWith(
        "TRANSFER_TO_ZERO_ADDR",
      );
    });

    it("Reverts when the recipient is stETH contract", async () => {
      const transferAmountOfShares = await steth.sharesOf(holder);

      await expect(steth.transferShares(steth, transferAmountOfShares)).to.be.revertedWith(
        "TRANSFER_TO_STETH_CONTRACT",
      );
    });

    it("Reverts when transfering from zero address", async () => {
      await expect(steth.connect(zeroAddressSigner).transferShares(recipient, 0)).to.be.revertedWith(
        "TRANSFER_FROM_ZERO_ADDR",
      );
    });
  });

  context("transferFrom", () => {
    beforeEach(async () => {
      const balanceOfHolder = await steth.balanceOf(holder);
      await steth.approve(spender, balanceOfHolder);
      expect(await steth.allowance(holder, spender)).to.equal(balanceOfHolder);
    });

    it("Transfers stETH to the recipient and fires the `Transfer` and `TransferShares` events", async () => {
      const beforeTransfer = await batch({
        holderBalance: steth.balanceOf(holder),
        recipientBalance: steth.balanceOf(recipient),
        spenderAllowance: steth.allowance(holder, spender),
        shareRate: steth.getSharesByPooledEth(ONE_ETHER),
      });

      const transferAmount = beforeTransfer.holderBalance;
      const transferAmountInShares = (transferAmount * beforeTransfer.shareRate) / ONE_ETHER;

      await expect(steth.connect(spender).transferFrom(holder, recipient, transferAmount))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, recipient.address, transferAmount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(holder.address, recipient.address, transferAmountInShares);

      const afterTransfer = await batch({
        holderBalance: steth.balanceOf(holder),
        recipientBalance: steth.balanceOf(recipient),
        spenderAllowance: steth.allowance(holder, spender),
      });

      expect(afterTransfer.holderBalance).to.equal(beforeTransfer.holderBalance - transferAmount);
      expect(afterTransfer.recipientBalance).to.equal(beforeTransfer.recipientBalance + transferAmount);
      expect(afterTransfer.spenderAllowance).to.equal(beforeTransfer.spenderAllowance - transferAmount);
    });

    it("Does not spend allowance if set to max uint256 (infinite)", async () => {
      await steth.approve(spender, MaxUint256);

      const beforeTransfer = await batch({
        holderBalance: steth.balanceOf(holder),
        recipientBalance: steth.balanceOf(recipient),
        spenderAllowance: steth.allowance(holder, spender),
        shareRate: steth.getSharesByPooledEth(ONE_ETHER),
      });

      const transferAmount = beforeTransfer.holderBalance;
      const transferAmountInShares = (transferAmount * beforeTransfer.shareRate) / ONE_ETHER;

      await expect(steth.connect(spender).transferFrom(holder, recipient, transferAmount))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, recipient.address, transferAmount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(holder.address, recipient.address, transferAmountInShares);

      const afterTransfer = await batch({
        holderBalance: steth.balanceOf(holder),
        recipientBalance: steth.balanceOf(recipient),
        spenderAllowance: steth.allowance(holder, spender),
      });

      expect(afterTransfer.holderBalance).to.equal(beforeTransfer.holderBalance - transferAmount);
      expect(afterTransfer.recipientBalance).to.equal(beforeTransfer.recipientBalance + transferAmount);
      expect(afterTransfer.spenderAllowance).to.equal(beforeTransfer.spenderAllowance);
    });

    it("Reverts when the recipient is zero address", async () => {
      const transferAmount = await steth.balanceOf(holder);

      await expect(steth.connect(spender).transferFrom(holder, ZeroAddress, transferAmount)).to.be.revertedWith(
        "TRANSFER_TO_ZERO_ADDR",
      );
    });

    it("Reverts when the recipient is stETH contract", async () => {
      const transferAmount = await steth.balanceOf(holder);

      await expect(steth.connect(spender).transferFrom(holder, steth, transferAmount)).to.be.revertedWith(
        "TRANSFER_TO_STETH_CONTRACT",
      );
    });

    it("Reverts when exceeding allowance", async () => {
      const allowance = await steth.allowance(holder, spender);

      await expect(steth.connect(spender).transferFrom(holder, recipient, allowance + 1n)).to.be.revertedWith(
        "ALLOWANCE_EXCEEDED",
      );
    });
  });

  context("transferSharesFrom", () => {
    beforeEach(async () => {
      const balanceOfHolder = await steth.balanceOf(holder);
      await steth.approve(spender, balanceOfHolder);
      expect(await steth.allowance(holder, spender)).to.equal(balanceOfHolder);
    });

    it("Transfers shares to the recipient and fires the `Transfer` and `TransferShares` events", async () => {
      const beforeTransfer = await batch({
        holderShares: steth.sharesOf(holder),
        recipientShares: steth.sharesOf(recipient),
        spenderAllowance: steth.allowance(holder, spender),
      });

      const transferAmount = await steth.getPooledEthByShares(beforeTransfer.holderShares);
      const transferAmountInShares = beforeTransfer.holderShares;

      await expect(steth.connect(spender).transferSharesFrom(holder, recipient, transferAmountInShares))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, recipient.address, transferAmount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(holder.address, recipient.address, transferAmountInShares);

      const afterTransfer = await batch({
        holderShares: steth.sharesOf(holder),
        recipientShares: steth.sharesOf(recipient),
        spenderAllowance: steth.allowance(holder, spender),
      });

      expect(afterTransfer.holderShares).to.equal(beforeTransfer.holderShares - transferAmountInShares);
      expect(afterTransfer.recipientShares).to.equal(beforeTransfer.recipientShares + transferAmountInShares);
      expect(afterTransfer.spenderAllowance).to.equal(beforeTransfer.spenderAllowance - transferAmount);
    });

    it("Does not spend allowance if set to max uint256 (infinite)", async () => {
      await steth.approve(spender, MaxUint256);

      const beforeTransfer = await batch({
        holderShares: steth.sharesOf(holder),
        recipientShares: steth.sharesOf(recipient),
        spenderAllowance: steth.allowance(holder, spender),
      });

      const transferAmount = await steth.getPooledEthByShares(beforeTransfer.holderShares);
      const transferAmountInShares = beforeTransfer.holderShares;

      await expect(steth.connect(spender).transferSharesFrom(holder, recipient, transferAmountInShares))
        .to.emit(steth, "Transfer")
        .withArgs(holder.address, recipient.address, transferAmount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(holder.address, recipient.address, transferAmountInShares);

      const afterTransfer = await batch({
        holderShares: steth.sharesOf(holder),
        recipientShares: steth.sharesOf(recipient),
        spenderAllowance: steth.allowance(holder, spender),
      });

      expect(afterTransfer.holderShares).to.equal(beforeTransfer.holderShares - transferAmountInShares);
      expect(afterTransfer.recipientShares).to.equal(beforeTransfer.recipientShares + transferAmountInShares);
      expect(afterTransfer.spenderAllowance).to.equal(beforeTransfer.spenderAllowance);
    });

    it("Reverts when the recipient is zero address", async () => {
      const transferAmountOfShares = await steth.sharesOf(holder);

      await expect(steth.connect(spender).transferFrom(holder, ZeroAddress, transferAmountOfShares)).to.be.revertedWith(
        "TRANSFER_TO_ZERO_ADDR",
      );
    });

    it("Reverts when the recipient is stETH contract", async () => {
      const transferAmountOfShares = await steth.sharesOf(holder);

      await expect(steth.connect(spender).transferFrom(holder, steth, transferAmountOfShares)).to.be.revertedWith(
        "TRANSFER_TO_STETH_CONTRACT",
      );
    });
  });

  context("approve", () => {
    it("Reverts if the owner is zero address", async () => {
      await expect(steth.connect(zeroAddressSigner).approve(spender, ONE_STETH)).to.be.revertedWith(
        "APPROVE_FROM_ZERO_ADDR",
      );
    });

    it("Reverts if the spender is zero address", async () => {
      await expect(steth.approve(ZeroAddress, ONE_STETH)).to.be.revertedWith("APPROVE_TO_ZERO_ADDR");
    });
  });

  context("increaseAllowance", () => {
    it("Increases the spender's allowance by the amount and fires the `Approval` event", async () => {
      const allowance = await steth.balanceOf(holder);
      await steth.connect(holder).approve(spender, allowance);
      expect(await steth.allowance(holder, spender)).to.equal(allowance);

      const increaseAmount = ether("1.0");
      const updatedAllowance = allowance + increaseAmount;

      await expect(steth.connect(holder).increaseAllowance(spender, increaseAmount))
        .to.emit(steth, "Approval")
        .withArgs(holder.address, spender.address, updatedAllowance);

      expect(await steth.allowance(holder, spender)).to.equal(updatedAllowance);
    });
  });

  context("decreaseAllowance", () => {
    let allowance: bigint;

    beforeEach(async () => {
      allowance = await steth.balanceOf(holder);

      await steth.connect(holder).approve(spender, allowance);
      expect(await steth.allowance(holder, spender)).to.equal(allowance);
    });

    it("Decreases the spender's allowance by the amount and fires the `Approval` event", async () => {
      const decreaseAmount = ether("1.0");
      const updatedAllowance = allowance - decreaseAmount;

      await expect(steth.connect(holder).decreaseAllowance(spender, decreaseAmount))
        .to.emit(steth, "Approval")
        .withArgs(holder.address, spender.address, updatedAllowance);

      expect(await steth.allowance(holder, spender)).to.equal(updatedAllowance);
    });

    it("Reverts if the decreased amount is greater than the current allowance", async () => {
      const invalidDecreaseAmount = allowance + 1n;

      await expect(steth.connect(holder).decreaseAllowance(spender, invalidDecreaseAmount)).to.be.revertedWith(
        "ALLOWANCE_BELOW_ZERO",
      );
    });
  });

  context("getTotalShares", () => {
    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`The amount of shares is unchaged after a ${rebase} rebase`, async () => {
        const totalSharesBeforeRebase = await steth.getTotalShares();

        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        expect(await steth.getTotalShares()).to.equal(totalSharesBeforeRebase);
      });
    }
  });

  context("sharesOf", () => {
    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`The amount of user shares is unchaged after a ${rebase} rebase`, async () => {
        const sharesOfHolderBeforeRebase = await steth.sharesOf(holder);

        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        expect(await steth.sharesOf(holder)).to.equal(sharesOfHolderBeforeRebase);
      });
    }
  });

  context("getSharesByPooledEth", () => {
    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`Returns the correct rate after a ${rebase} rebase`, async () => {
        // before the first rebase, shares are equivalent to steth
        expect(await steth.getSharesByPooledEth(ONE_STETH)).to.equal(ONE_SHARE);

        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        const { totalShares, totalPooledEther } = await batch({
          totalShares: steth.getTotalShares(),
          totalPooledEther: steth.getTotalPooledEther(),
        });

        const oneStethInShares = (ONE_STETH * totalShares) / totalPooledEther;

        expect(await steth.getSharesByPooledEth(ONE_STETH)).to.equal(oneStethInShares);
      });
    }
  });

  context("getPooledEthByShares", () => {
    for (const [rebase, factor] of [
      ["neutral", 100n], // 1
      ["positive", 105n], // 0.95
      ["negative", 95n], // 1.05
    ]) {
      it(`Returns the correct rate after a ${rebase} rebase`, async () => {
        // before the first rebase, steth are equivalent to shares
        expect(await steth.getPooledEthByShares(ONE_SHARE)).to.equal(ONE_STETH);

        const rebasedSupply = (totalSupply * (factor as bigint)) / 100n;
        await steth.setTotalPooledEther(rebasedSupply);

        const { totalShares, totalPooledEther } = await batch({
          totalShares: steth.getTotalShares(),
          totalPooledEther: steth.getTotalPooledEther(),
        });

        const oneShareInSteth = (ONE_SHARE * totalPooledEther) / totalShares;

        expect(await steth.getPooledEthByShares(ONE_SHARE)).to.equal(oneShareInSteth);
      });
    }
  });

  context("mintShares", () => {
    it("Reverts when minting to zero address", async () => {
      await expect(steth.mintShares(ZeroAddress, 1n)).to.be.revertedWith("MINT_TO_ZERO_ADDR");
    });
  });

  context("burnShares", () => {
    it("Reverts when burning on zero address", async () => {
      await expect(steth.burnShares(ZeroAddress, 1n)).to.be.revertedWith("BURN_FROM_ZERO_ADDR");
    });

    it("Reverts when burning more than the owner owns", async () => {
      const sharesOfHolder = await steth.sharesOf(holder);
      await expect(steth.burnShares(holder, sharesOfHolder + 1n)).to.be.revertedWith("BALANCE_EXCEEDED");
    });
  });
});
