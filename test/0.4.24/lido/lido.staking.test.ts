import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ACL, Lido } from "typechain-types";

import { certainAddress, ether, ONE_ETHER } from "lib";

import { deployLidoDao } from "test/deploy";

describe("Lido:staking", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;

  const maxStakeLimit = ether("10.0");
  const stakeLimitIncreasePerBlock = ether("2.0");

  beforeEach(async () => {
    [deployer, user] = await ethers.getSigners();

    ({ lido, acl } = await deployLidoDao({ rootAccount: deployer, initialized: true }));

    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.STAKING_PAUSE_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);

    lido = lido.connect(user);
  });

  context("fallback", () => {
    beforeEach(async () => {
      await lido.resumeStaking();
    });

    it("Defaults to submit", async () => {
      await expect(
        user.sendTransaction({
          to: await lido.getAddress(),
          value: ONE_ETHER,
        }),
      )
        .to.emit(lido, "Submitted")
        .withArgs(user.address, ONE_ETHER, ZeroAddress)
        .and.to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, user.address, ONE_ETHER)
        .and.to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, user.address, ONE_ETHER);

      expect(await lido.balanceOf(user)).to.equal(ONE_ETHER);
    });

    it("Reverts when tx data is not empty", async () => {
      await expect(
        user.sendTransaction({
          to: await lido.getAddress(),
          value: ONE_ETHER,
          data: "0x01",
        }),
      ).to.be.revertedWith("NON_EMPTY_DATA");
    });
  });

  context("submit", () => {
    beforeEach(async () => {
      await lido.resumeStaking();
    });

    it("Reverts if the value is zero", async () => {
      await expect(lido.submit(ZeroAddress, { value: 0n })).to.be.revertedWith("ZERO_DEPOSIT");
    });

    it("Reverts if staking is paused", async () => {
      await lido.pauseStaking();
      await expect(lido.submit(ZeroAddress, { value: 1n })).to.be.revertedWith("STAKING_PAUSED");
    });

    it("Reverts if the value exceeds the current staking limit", async () => {
      await lido.setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);

      await expect(lido.submit(ZeroAddress, { value: maxStakeLimit + 1n })).to.be.revertedWith("STAKE_LIMIT");
    });

    it("Submits a stake", async () => {
      const stakeAmount = ONE_ETHER;
      const stakeAmountInShares = await lido.getSharesByPooledEth(stakeAmount);

      await expect(lido.submit(ZeroAddress, { value: stakeAmount }))
        .to.emit(lido, "Submitted")
        .withArgs(user.address, stakeAmount, ZeroAddress)
        .and.to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, user.address, stakeAmount)
        .and.to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, user.address, stakeAmountInShares);

      expect(await lido.balanceOf(user)).to.equal(stakeAmount);
    });

    it("Emits a `Submitted` event with the correct referral address", async () => {
      const referral = certainAddress("test:lido:submit:referral");

      await expect(lido.submit(referral, { value: ONE_ETHER }))
        .to.emit(lido, "Submitted")
        .withArgs(user.address, ONE_ETHER, referral);
    });

    it("Returns the amount of shares minted", async () => {
      const stakeAmount = ONE_ETHER;
      const expectedStakeAmountInShares = await lido.getSharesByPooledEth(stakeAmount);

      const stakeAmountInShares = await lido.submit.staticCall(ZeroAddress, { value: stakeAmount });
      expect(stakeAmountInShares).to.equal(expectedStakeAmountInShares);
    });
  });
});
