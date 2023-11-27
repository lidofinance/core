import { assert, expect } from "chai";
import { ethers } from "hardhat";
import { StETHMock } from "../../typechain-types";
import { ZeroAddress, parseUnits } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const MAX_UINT256 = 2n ** 256n - 1n;

describe("StETH as ERC-20", function () {
  let steth: StETHMock;

  let users: [HardhatEthersSigner, HardhatEthersSigner, HardhatEthersSigner];

  const initialTotalSupply = ether(1);
  const initialHolder = "0x000000000000000000000000000000000000dEaD";

  let snapshot: string;

  this.beforeAll(async function () {
    steth = await ethers.deployContract("StETHMock", { value: initialTotalSupply });

    await steth.setTotalPooledEther(initialTotalSupply);

    const signers = await ethers.getSigners();
    users = [signers[0], signers[1], signers[2]];
    assert(users.every(Boolean));

    snapshot = await ethers.provider.send("evm_snapshot", []);
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

  context("Total supply", function () {
    let holder: HardhatEthersSigner;
    const amount = parseUnits("1", "ether");

    this.beforeAll(async function () {
      holder = users[0];

      await expect(steth.mintSteth(holder, { value: amount }))
        .to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, holder.address, await steth.getSharesByPooledEth(amount));

      expect(await steth.balanceOf(holder)).to.equal(amount);
    });

    it("hello", async function () {
      expect(1).to.equal(1);
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

        await ethers.provider.send("evm_revert", [snapshot]);
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
