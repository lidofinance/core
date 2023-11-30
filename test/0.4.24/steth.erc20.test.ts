import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { assert, expect } from "chai";
import { ZeroAddress, formatUnits, parseUnits } from "ethers";
import { ethers } from "hardhat";
import { describe } from "mocha";
import { MAX_UINT256, Snapshot, batch } from "../../lib";
import { StETHMock } from "../../typechain-types";

describe("StETH ERC-20 Compliance", function () {
  const initialTotalSupply = parseUnits("1.0", "ether");
  const initialHolder = "0x000000000000000000000000000000000000dEaD";

  let steth: StETHMock;
  let users: HardhatEthersSigner[];
  let initialState: string;

  this.beforeAll(async function () {
    initialState = await Snapshot.take();

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

  it("Returns the account balance of another account.", async function () {
    expect(await steth.balanceOf(initialHolder)).to.equal(initialTotalSupply);
  });

  context("transfer()", function () {
    let sender: HardhatEthersSigner, recipient: HardhatEthersSigner;

    let initialState: string;
    let setupState: string;

    this.beforeAll(async function () {
      initialState = await Snapshot.take();

      [sender, recipient] = users;

      const initialBalance = parseUnits("100.0", "ether");
      const initialShares = await steth.getSharesByPooledEth(initialBalance);

      await expect(steth.mintSteth(sender, { value: initialBalance }))
        .to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, sender.address, initialShares);

      expect(await steth.balanceOf(sender)).to.equal(initialBalance);
      expect(await steth.sharesOf(sender)).to.equal(initialShares);
      expect(await steth.balanceOf(recipient)).to.equal(0n);
      expect(await steth.sharesOf(recipient)).to.equal(0n);
    });

    this.beforeEach(async function () {
      setupState = await Snapshot.refresh(setupState);
    });

    for (const amount of [0n, 1n, parseUnits("1.0")]) {
      it(`Transfers ${formatUnits(amount, "ether")} tokens from sender to recipient.`, async function () {
        const amountInShares = await steth.getSharesByPooledEth(amount);

        const before = await batch({
          senderBalance: steth.balanceOf(sender),
          senderShares: steth.sharesOf(sender),
          recipientBalance: steth.balanceOf(recipient),
          recipientShares: steth.sharesOf(recipient),
        });

        await expect(steth.connect(sender).transfer(recipient, amount))
          .to.emit(steth, "Transfer")
          .withArgs(sender.address, recipient.address, amount)
          .and.to.emit(steth, "TransferShares")
          .withArgs(sender.address, recipient.address, amountInShares);

        expect(await steth.balanceOf(sender)).to.equal(before.senderBalance - amount);
        expect(await steth.sharesOf(sender)).to.equal(before.senderShares - amountInShares);
        expect(await steth.balanceOf(recipient)).to.equal(before.recipientBalance + amount);
        expect(await steth.sharesOf(recipient)).to.equal(before.recipientShares + amountInShares);
      });
    }

    it("Reverts if the recipient is zero address.", async function () {
      await expect(steth.connect(sender).transfer(ZeroAddress, parseUnits("1.0"))).to.be.revertedWith(
        "TRANSFER_TO_ZERO_ADDR",
      );
    });

    it("Reverts if the recipient is the stETH contract.", async function () {
      await expect(steth.connect(sender).transfer(steth, parseUnits("1.0"))).to.be.revertedWith(
        "TRANSFER_TO_STETH_CONTRACT",
      );
    });

    it("Reverts if the sender does not have enough tokens.", async function () {
      const senderBalance = await steth.balanceOf(sender);
      await expect(steth.connect(sender).transfer(recipient, senderBalance + 1n)).to.be.revertedWith(
        "BALANCE_EXCEEDED",
      );
    });

    it("Returns true if the transfer succeeds.", async function () {
      const success = await steth.connect(sender).transfer.staticCallResult(recipient, parseUnits("1.0"));
      assert(success);
    });

    this.afterAll(async function () {
      await Snapshot.restore(initialState);
    });
  });

  context("transferFrom()", function () {
    let owner: HardhatEthersSigner, spender: HardhatEthersSigner, recipient: HardhatEthersSigner;

    let initialState: string;
    let setupState: string;

    this.beforeAll(async function () {
      initialState = await Snapshot.take();

      [owner, spender, recipient] = users;

      const initialBalance = parseUnits("100.0", "ether");
      const initialShares = await steth.getSharesByPooledEth(initialBalance);

      await expect(steth.mintSteth(owner, { value: initialBalance }))
        .to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, owner.address, initialShares);

      expect(await steth.balanceOf(owner)).to.equal(initialBalance);
      expect(await steth.sharesOf(owner)).to.equal(initialShares);
      expect(await steth.balanceOf(spender)).to.equal(0n);
      expect(await steth.sharesOf(spender)).to.equal(0n);
      expect(await steth.balanceOf(recipient)).to.equal(0n);
      expect(await steth.sharesOf(recipient)).to.equal(0n);

      const allowance = parseUnits("1.0", "ether");

      await expect(steth.connect(owner).approve(spender, allowance))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, allowance);

      expect(await steth.allowance(owner, spender)).to.equal(allowance);
    });

    this.beforeEach(async function () {
      setupState = await Snapshot.refresh(setupState);
    });

    for (const amount of [0n, 1n, parseUnits("1.0")]) {
      it(`Allows spender to transfer ${formatUnits(
        amount,
        "ether",
      )} tokens from owner to recipient.`, async function () {
        const amountInShares = await steth.getPooledEthByShares(amount);

        const before = await batch({
          ownerBalance: steth.balanceOf(owner),
          ownerShares: steth.sharesOf(owner),
          recipientBalance: steth.balanceOf(recipient),
          recipientShares: steth.sharesOf(recipient),
          spenderAllowance: steth.allowance(owner, spender),
        });

        await expect(steth.connect(spender).transferFrom(owner, recipient, amount))
          .to.emit(steth, "Transfer")
          .withArgs(owner.address, recipient.address, amount)
          .and.to.emit(steth, "TransferShares")
          .withArgs(owner.address, recipient.address, amountInShares);

        expect(await steth.balanceOf(owner)).to.equal(before.ownerBalance - amount);
        expect(await steth.sharesOf(owner)).to.equal(before.ownerShares - amountInShares);
        expect(await steth.balanceOf(recipient)).to.equal(before.recipientBalance + amount);
        expect(await steth.sharesOf(recipient)).to.equal(before.recipientShares + amountInShares);
        expect(await steth.allowance(owner, spender)).to.equal(before.spenderAllowance - amount);
      });
    }

    it("Allowance does not decrease on transfer if set MAX_UINT256", async function () {
      const amount = parseUnits("1.0", "ether");
      const amountInShares = await steth.getSharesByPooledEth(amount);

      await expect(steth.connect(owner).approve(spender, MAX_UINT256))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, MAX_UINT256);

      expect(await steth.allowance(owner, spender)).to.equal(MAX_UINT256);

      const before = await batch({
        ownerBalance: steth.balanceOf(owner),
        ownerShares: steth.sharesOf(owner),
        recipientBalance: steth.balanceOf(recipient),
        recipientShares: steth.sharesOf(recipient),
        spenderAllowance: steth.allowance(owner, spender),
      });

      await expect(steth.connect(spender).transferFrom(owner, recipient, amount))
        .to.emit(steth, "Transfer")
        .withArgs(owner.address, recipient.address, amount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(owner.address, recipient.address, amountInShares);

      expect(await steth.balanceOf(owner)).to.equal(before.ownerBalance - amount);
      expect(await steth.sharesOf(owner)).to.equal(before.ownerShares - amountInShares);
      expect(await steth.balanceOf(recipient)).to.equal(before.recipientBalance + amount);
      expect(await steth.sharesOf(recipient)).to.equal(before.recipientShares + amountInShares);
      expect(await steth.allowance(owner, spender)).to.equal(before.spenderAllowance);
    });

    it("Reverts if the recipient is zero address.", async function () {
      await expect(
        steth.connect(spender).transferFrom(owner, ZeroAddress, parseUnits("1.0", "ether")),
      ).to.be.revertedWith("TRANSFER_TO_ZERO_ADDR");
    });

    it("Reverts if the recipient is the stETH contract.", async function () {
      await expect(steth.connect(spender).transferFrom(owner, steth, parseUnits("1.0", "ether"))).to.be.revertedWith(
        "TRANSFER_TO_STETH_CONTRACT",
      );
    });

    it("Reverts if the spender does not have enough allowance.", async function () {
      const allowance = await steth.allowance(owner, spender);
      await expect(steth.connect(spender).transferFrom(owner, recipient, allowance + 1n)).to.be.revertedWith(
        "ALLOWANCE_EXCEEDED",
      );
    });

    it("Returns true if transferFrom succeeds.", async function () {
      const success = await steth.connect(spender).transferFrom.staticCallResult(owner, recipient, parseUnits("1.0"));
      assert(success);
    });

    this.afterAll(async function () {
      await Snapshot.restore(initialState);
    });
  });

  context("approve()", function () {
    let owner: HardhatEthersSigner, spender: HardhatEthersSigner;

    let initialState: string;
    let setupState: string;

    this.beforeAll(async function () {
      initialState = await Snapshot.take();

      [owner, spender] = users;
    });

    this.beforeEach(async function () {
      setupState = await Snapshot.refresh(setupState);
    });

    it("Gives allowance to spender from owner.", async function () {
      const allowance = parseUnits("1.0", "ether");

      await expect(steth.connect(owner).approve(spender, allowance))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, allowance);

      expect(await steth.allowance(owner, spender)).to.equal(allowance);
    });

    it("Returns true if the approve succeeds.", async function () {
      const success = await steth.connect(owner).approve.staticCallResult(spender, parseUnits("1.0"));
      assert(success);
    });

    this.afterAll(async function () {
      await Snapshot.restore(initialState);
    });
  });

  context("increaseAllowance()", function () {
    let owner: HardhatEthersSigner, spender: HardhatEthersSigner;

    let initialState: string;
    let setupState: string;

    this.beforeAll(async function () {
      initialState = await Snapshot.take();

      [owner, spender] = users;
    });

    this.beforeEach(async function () {
      setupState = await Snapshot.refresh(setupState);
    });

    it("Increases allowance if the initial allowance is 0.", async function () {
      const increaseAmount = parseUnits("1.0", "ether");

      await expect(steth.connect(owner).increaseAllowance(spender, increaseAmount))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, increaseAmount);
    });

    it("Increases allowance if the previous allowance is not 0.", async function () {
      const previousAllowance = parseUnits("2.0", "ether");
      const increaseAmount = parseUnits("1.0", "ether");

      await expect(steth.connect(owner).approve(spender, previousAllowance))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, previousAllowance);

      expect(await steth.allowance(owner, spender)).to.equal(previousAllowance);

      await expect(steth.connect(owner).increaseAllowance(spender, increaseAmount))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, previousAllowance + increaseAmount);

      expect(await steth.allowance(owner, spender)).to.equal(previousAllowance + increaseAmount);
    });

    it("Reverts if the spender is zero address.", async function () {
      const increaseAmount = parseUnits("1.0", "ether");

      await expect(steth.connect(owner).increaseAllowance(ZeroAddress, increaseAmount)).to.be.revertedWith(
        "APPROVE_TO_ZERO_ADDR",
      );
    });

    it("Returns true if the function succeeds.", async function () {
      const success = await steth.connect(owner).increaseAllowance.staticCallResult(spender, parseUnits("1.0"));
      assert(success);
    });

    this.afterAll(async function () {
      await Snapshot.restore(initialState);
    });
  });

  context("decreaseAllowance()", function () {
    let owner: HardhatEthersSigner, spender: HardhatEthersSigner;
    const previousAllowance = parseUnits("3.0", "ether");

    let initialState: string;
    let setupState: string;

    this.beforeAll(async function () {
      initialState = await Snapshot.take();

      [owner, spender] = users;

      await expect(steth.connect(owner).approve(spender, previousAllowance))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, previousAllowance);

      expect(await steth.allowance(owner, spender)).to.equal(previousAllowance);
    });

    this.beforeEach(async function () {
      setupState = await Snapshot.refresh(setupState);
    });

    it("Decreases allowance.", async function () {
      const decreaseAmount = parseUnits("1.0", "ether");

      await expect(steth.connect(owner).decreaseAllowance(spender, decreaseAmount))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, previousAllowance - decreaseAmount);

      expect(await steth.allowance(owner, spender)).to.equal(previousAllowance - decreaseAmount);
    });

    it("Decreases allowance at MAX_UINT256.", async function () {
      const decreaseAmount = parseUnits("1.0", "ether");

      await expect(steth.connect(owner).approve(spender, MAX_UINT256))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, MAX_UINT256);

      expect(await steth.allowance(owner, spender)).to.equal(MAX_UINT256);

      await expect(steth.connect(owner).decreaseAllowance(spender, decreaseAmount))
        .to.emit(steth, "Approval")
        .withArgs(owner.address, spender.address, MAX_UINT256 - decreaseAmount);

      expect(await steth.allowance(owner, spender)).to.equal(MAX_UINT256 - decreaseAmount);
    });

    it("Cannot decrease below zero.", async function () {
      await expect(steth.connect(owner).decreaseAllowance(spender, previousAllowance + 1n)).to.be.revertedWith(
        "ALLOWANCE_BELOW_ZERO",
      );
    });

    it("Returns true if the function succeeds.", async function () {
      const success = await steth.connect(owner).decreaseAllowance.staticCallResult(spender, parseUnits("1.0"));
      assert(success);
    });

    this.afterAll(async function () {
      await Snapshot.restore(initialState);
    });
  });

  this.afterAll(async function () {
    await Snapshot.restore(initialState);
  });
});
