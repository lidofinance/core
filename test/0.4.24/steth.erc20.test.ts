import { describe } from "mocha";
import { StETHMock } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, parseUnits } from "ethers";
import { ethers } from "hardhat";
import { expect } from "chai";
import Snapshot from "../snapshot";
import { batch } from "../utils";

describe("StETH ERC-20 Compliance", function () {
  const initialTotalSupply = parseUnits("1.0", "ether");
  const initialHolder = "0x000000000000000000000000000000000000dEaD";

  let steth: StETHMock;
  let users: HardhatEthersSigner[];

  this.beforeAll(async function () {
    steth = await ethers.deployContract("StETHMock", { value: initialTotalSupply });
    users = await ethers.getSigners();
  });

  it("Returns the name of the token.", async function () {
    expect(await steth.name()).to.equal("Liquid staked Ether 2.0");
  });

  it("Returns the symbol of the token.", async function () {
    expect(await steth.symbol()).to.equal("stETH");
  });

  it("Returns the number of decimals the token uses.", async function () {
    expect(await steth.decimals()).to.equal(18n);
  });

  it("Returns the total token supply.", async function () {
    expect(await steth.totalSupply()).to.equal(initialTotalSupply);
  });

  it("Returns the total token supply.", async function () {
    expect(await steth.totalSupply()).to.equal(initialTotalSupply);
  });

  it("Returns the account balance of another account.", async function () {
    expect(await steth.balanceOf(initialHolder)).to.equal(initialTotalSupply);
  });

  context("transfer()", function () {
    let sender: HardhatEthersSigner, recipient: HardhatEthersSigner;
    const transferAmount = parseUnits("1.0", "ether");

    let initialState: string;
    let setupState: string;

    this.beforeAll(async function () {
      initialState = await Snapshot.take();

      [sender, recipient] = users;

      await expect(steth.mintSteth(sender, { value: transferAmount }))
        .to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, sender.address, await steth.getSharesByPooledEth(transferAmount));

      expect(await steth.balanceOf(sender)).to.equal(transferAmount);
      expect(await steth.balanceOf(recipient)).to.equal(0n);

      setupState = await Snapshot.take();
    });

    this.afterAll(async function () {
      await Snapshot.restore(initialState);
    });

    it("Transfers tokens to the recipient, and MUST fire the Transfer event.", async function () {
      const beforeTransfer = await batch({
        senderBalance: steth.balanceOf(sender),
        recipientBalance: steth.balanceOf(recipient),
      });

      await expect(steth.connect(sender).transfer(recipient, transferAmount))
        .to.emit(steth, "Transfer")
        .withArgs(sender.address, recipient.address, transferAmount);

      expect(await steth.balanceOf(sender)).to.equal(beforeTransfer.senderBalance - transferAmount);
      expect(await steth.balanceOf(recipient)).to.equal(beforeTransfer.recipientBalance + transferAmount);

      await Snapshot.restore(setupState);
    });

    it("Transfers of 0 values MUST be treated as normal transfers and fire the Transfer event.", async function () {
      const beforeTransfer = await batch({
        senderBalance: steth.balanceOf(sender),
        recipientBalance: steth.balanceOf(recipient),
      });

      await expect(steth.connect(sender).transfer(recipient, 0))
        .to.emit(steth, "Transfer")
        .withArgs(sender.address, recipient.address, 0);

      expect(await steth.balanceOf(sender)).to.equal(beforeTransfer.senderBalance);
      expect(await steth.balanceOf(recipient)).to.equal(beforeTransfer.recipientBalance);

      await Snapshot.restore(setupState);
    });

    it("Reverts if the recipient is zero address.", async function () {
      await expect(steth.connect(sender).transfer(ZeroAddress, transferAmount)).to.be.revertedWith(
        "TRANSFER_TO_ZERO_ADDR",
      );
    });

    it("Reverts if the recipient is the stETH contract.", async function () {
      await expect(steth.connect(sender).transfer(steth, transferAmount)).to.be.revertedWith(
        "TRANSFER_TO_STETH_CONTRACT",
      );
    });

    it("Reverts if the sender does not have enough tokens.", async function () {
      await expect(steth.connect(sender).transfer(recipient, transferAmount + 1n)).to.be.revertedWith(
        "BALANCE_EXCEEDED",
      );
    });
  });

  context("transferFrom()", function () {
    let owner: HardhatEthersSigner, spender: HardhatEthersSigner, recipient: HardhatEthersSigner;
    const transferAmount = parseUnits("1.0", "ether");

    let initialState: string;
    let setupState: string;

    this.beforeAll(async function () {
      initialState = await Snapshot.take();

      [owner, spender, recipient] = users;

      await expect(steth.mintSteth(owner, { value: transferAmount }))
        .to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, owner.address, await steth.getSharesByPooledEth(transferAmount));

      expect(await steth.balanceOf(owner)).to.equal(transferAmount);
      expect(await steth.balanceOf(spender)).to.equal(0n);
      expect(await steth.balanceOf(recipient)).to.equal(0n);

      await expect(steth.connect(owner).approve(spender, transferAmount))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, transferAmount);

      expect(await steth.allowance(owner, spender)).to.equal(transferAmount);

      setupState = await Snapshot.take();
    });

    it("Transfers tokens from owner to recipient, and MUST fire the Transfer event.", async function () {
      const beforeTransfer = await batch({
        ownerBalance: steth.balanceOf(owner),
        recipientBalance: steth.balanceOf(recipient),
        spenderAllowance: steth.allowance(owner, spender),
      });

      await expect(steth.connect(spender).transferFrom(owner, recipient, transferAmount))
        .to.emit(steth, "Transfer")
        .withArgs(owner.address, recipient.address, transferAmount);

      expect(await steth.balanceOf(owner)).to.equal(beforeTransfer.ownerBalance - transferAmount);
      expect(await steth.balanceOf(recipient)).to.equal(beforeTransfer.recipientBalance + transferAmount);
      expect(await steth.allowance(owner, spender)).to.equal(beforeTransfer.spenderAllowance - transferAmount);

      await Snapshot.restore(setupState);
    });

    it("Transfers of 0 values MUST be treated as normal transfers and fire the Transfer event.", async function () {
      const beforeTransfer = await batch({
        ownerBalance: steth.balanceOf(owner),
        recipientBalance: steth.balanceOf(recipient),
        spenderAllowance: steth.allowance(owner, spender),
      });

      await expect(steth.connect(spender).transferFrom(owner, recipient, 0))
        .to.emit(steth, "Transfer")
        .withArgs(owner.address, recipient.address, 0);

      expect(await steth.balanceOf(owner)).to.equal(beforeTransfer.ownerBalance);
      expect(await steth.balanceOf(recipient)).to.equal(beforeTransfer.recipientBalance);
      expect(await steth.allowance(owner, spender)).to.equal(beforeTransfer.spenderAllowance);

      await Snapshot.restore(setupState);
    });

    it("Reverts if the recipient is zero address.", async function () {
      await expect(steth.connect(spender).transferFrom(owner, ZeroAddress, transferAmount)).to.be.revertedWith(
        "TRANSFER_TO_ZERO_ADDR",
      );
    });

    it("Reverts if the recipient is the stETH contract.", async function () {
      await expect(steth.connect(spender).transferFrom(owner, steth, transferAmount)).to.be.revertedWith(
        "TRANSFER_TO_STETH_CONTRACT",
      );
    });

    it("Reverts if the spender does not have enough allowance.", async function () {
      await expect(steth.connect(spender).transferFrom(owner, recipient, transferAmount + 1n)).to.be.revertedWith(
        "ALLOWANCE_EXCEEDED",
      );
    });

    this.afterAll(async function () {
      await Snapshot.restore(initialState);
    });
  });
});
