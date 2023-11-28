import { assert, expect } from "chai";
import { ethers } from "hardhat";
import { StETHMock } from "../../typechain-types";
import { ZeroAddress, parseUnits } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import Snapshot from "../snapshot";
import { MAX_UINT256 } from "../constants";

describe("StETH as ERC-20", function () {
  let steth: StETHMock;

  let users: [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];

  const initialTotalSupply = ether(1);
  const initialHolder = "0x000000000000000000000000000000000000dEaD";

  let stethDeployedSnapshot: string;

  this.beforeAll(async function () {
    steth = await ethers.deployContract("StETHMock", { value: initialTotalSupply });

    await steth.setTotalPooledEther(initialTotalSupply);

    const signers = await ethers.getSigners();
    users = [signers[0], signers[1], signers[2]];
    assert(users.every(Boolean));

    stethDeployedSnapshot = await Snapshot.take();
  });

  context("Details", function () {
    it("Name should be 'Liquid staked Ether 2.0'.", async function () {
      expect(await steth.name()).to.equal("Liquid staked Ether 2.0");
    });

    it("Symbol should be 'stETH'", async function () {
      expect(await steth.symbol()).to.equal("stETH");
    });

    it("Number should be decimals is 18.", async function () {
      expect(await steth.decimals()).to.equal(18n);
    });
  });

  it("All stETH is owned by the initial holder.", async function () {
    expect(await steth.balanceOf(initialHolder)).to.equal(await steth.totalSupply());
  });

  it("Other users have no stETH.", async function () {
    for (const user of users) {
      expect(await steth.balanceOf(user.address)).to.equal(0n);
    }
  });

  context("Transfers", function () {
    let holder: HardhatEthersSigner;
    const amount = parseUnits("1", "ether");

    let userHasStethSnapshot: string;

    this.beforeAll(async function () {
      [holder] = users;

      await expect(steth.mintSteth(holder, { value: amount }))
        .to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, holder.address, await steth.getSharesByPooledEth(amount));

      expect(await steth.balanceOf(holder)).to.equal(amount);

      userHasStethSnapshot = await Snapshot.take();
    });

    context("transfer()", function () {
      let recipient: HardhatEthersSigner;

      this.beforeAll(async function () {
        [, recipient] = users;
      });

      it("Reverts if the recipient is zero address.", async function () {
        await expect(steth.connect(holder).transfer(ZeroAddress, amount)).to.be.revertedWith("TRANSFER_TO_ZERO_ADDR");
      });

      it("Reverts if the recipient is the stETH contract.", async function () {
        await expect(steth.connect(holder).transfer(steth, amount)).to.be.revertedWith("TRANSFER_TO_STETH_CONTRACT");
      });

      it("Reverts if the sender does not have enough tokens.", async function () {
        await expect(steth.connect(holder).transfer(recipient, amount + 1n)).to.be.revertedWith("BALANCE_EXCEEDED");
      });

      it("Holder can transfer 0 stETH.", async function () {
        await expect(steth.connect(holder).transfer(recipient, 0))
          .to.emit(steth, "Transfer")
          .withArgs(holder.address, recipient.address, 0)
          .and.to.emit(steth, "TransferShares")
          .withArgs(holder.address, recipient.address, 0);

        expect(await steth.balanceOf(holder)).to.equal(amount);
        expect(await steth.balanceOf(recipient)).to.equal(0n);

        await Snapshot.restore(userHasStethSnapshot);
      });

      it("Holder can transfer their stETH.", async function () {
        await expect(steth.connect(holder).transfer(recipient, amount))
          .to.emit(steth, "Transfer")
          .withArgs(holder.address, recipient.address, amount)
          .and.to.emit(steth, "TransferShares")
          .withArgs(holder.address, recipient.address, await steth.getSharesByPooledEth(amount));

        expect(await steth.balanceOf(holder)).to.equal(0n);
        expect(await steth.balanceOf(recipient)).to.equal(amount);

        await Snapshot.restore(userHasStethSnapshot);
      });
    });

    context("transferFrom()", function () {
      let spender: HardhatEthersSigner;
      let recipient: HardhatEthersSigner;

      this.beforeAll(async function () {
        [, spender, recipient] = users;

        await expect(steth.connect(holder).approve(spender, amount))
          .to.emit(steth, "Approval")
          .withArgs(holder.address, spender.address, amount);

        expect(await steth.allowance(holder, spender)).to.equal(amount);
      });

      this.afterAll(async function () {
        await Snapshot.restore(stethDeployedSnapshot);
      });

      it("Reverts if the recipient is zero address.", async function () {
        await expect(steth.connect(spender).transferFrom(holder, ZeroAddress, amount)).to.be.revertedWith(
          "TRANSFER_TO_ZERO_ADDR",
        );
      });

      it("Reverts if the recipient is the stETH contract.", async function () {
        await expect(steth.connect(spender).transferFrom(holder, steth, amount)).to.be.revertedWith(
          "TRANSFER_TO_STETH_CONTRACT",
        );
      });

      it("Reverts if the sender does not have enough tokens.", async function () {
        await expect(steth.connect(spender).transferFrom(holder, recipient, amount + 1n)).to.be.revertedWith(
          "ALLOWANCE_EXCEEDED",
        );
      });
    });
  });

  context("Allowance", function () {
    it("Initial allowances are 0.", async function () {
      for (const owner of users) {
        for (const spender of users) {
          expect(await steth.allowance(owner, spender)).to.equal(0n);
        }
      }
    });

    context("Approval", function () {
      it("Owner's approval sets spender's allowance.", async function () {
        for (const amount of [0, 1, gwei(1), ether(1), MAX_UINT256]) {
          const [owner, spender] = users;

          await expect(steth.connect(owner).approve(spender, amount))
            .to.emit(steth, "Approval")
            .withArgs(owner.address, spender.address, amount);

          expect(await steth.allowance(owner, spender)).to.equal(amount);
        }

        await Snapshot.restore(stethDeployedSnapshot);
      });
    });
  });
});

function gwei(amount: number) {
  return parseUnits(amount.toFixed(9), "gwei");
}

function ether(amount: number) {
  return parseUnits(amount.toFixed(18), "ether");
}
