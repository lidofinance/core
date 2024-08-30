import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mine } from "@nomicfoundation/hardhat-network-helpers";

import { ACL, Lido } from "typechain-types";

import { certainAddress, ether, ONE_ETHER } from "lib";

import { deployLidoDao } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Lido.sol:staking-limit", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;

  const maxStakeLimit = ether("10.0");
  const stakeLimitIncreasePerBlock = ether("2.0");

  let originalState: string;

  before(async () => {
    [deployer, user, stranger] = await ethers.getSigners();

    ({ lido, acl } = await deployLidoDao({ rootAccount: deployer, initialized: true }));

    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.STAKING_PAUSE_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);

    lido = lido.connect(user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getCurrentStakeLimit", () => {
    it("Returns zero if staking is paused", async () => {
      expect(await lido.getCurrentStakeLimit()).to.equal(0);
    });

    it("Returns max uint256 if staking is resumed", async () => {
      await lido.resumeStaking();
      expect(await lido.getCurrentStakeLimit()).to.equal(MaxUint256);
    });

    it("Returns the current staking limit", async () => {
      await lido.resumeStaking();
      await lido.setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);
      expect(await lido.getCurrentStakeLimit()).to.equal(maxStakeLimit);

      await lido.submit(ZeroAddress, { value: maxStakeLimit });
      expect(await lido.getCurrentStakeLimit()).to.equal(0);

      // if no new stake is submitted,
      // the staking limit recovers in `fullRecoveryBlocks` blocks,
      const fullReplenishInBlocks = maxStakeLimit / stakeLimitIncreasePerBlock;

      for (let i = 1n; i <= fullReplenishInBlocks; i++) {
        await mine(1);
        expect(await lido.getCurrentStakeLimit()).to.equal(stakeLimitIncreasePerBlock * i);
      }
    });
  });

  context("setStakingLimit", () => {
    it("Sets staking limit when staking is paused", async () => {
      await expect(lido.setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock))
        .to.emit(lido, "StakingLimitSet")
        .withArgs(maxStakeLimit, stakeLimitIncreasePerBlock);
      expect(await lido.getCurrentStakeLimit()).to.equal(0);

      await lido.resumeStaking();
      expect(await lido.getCurrentStakeLimit()).to.equal(maxStakeLimit);
    });

    it("Reverts if the caller is unauthorized", async () => {
      await expect(
        lido.connect(stranger).setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock),
      ).to.be.revertedWith("APP_AUTH_FAILED");
    });
  });

  context("removeStakingLimit", () => {
    beforeEach(async () => {
      await lido.resumeStaking();
      await lido.setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);
      expect(await lido.getCurrentStakeLimit()).to.equal(maxStakeLimit);
    });

    it("Sets staking limit when staking is paused", async () => {
      await expect(lido.removeStakingLimit()).to.emit(lido, "StakingLimitRemoved");
    });

    it("Reverts if the caller is unauthorized", async () => {
      await expect(lido.connect(stranger).removeStakingLimit()).to.be.revertedWith("APP_AUTH_FAILED");
    });
  });

  context("getStakeLimitFullInfo", () => {
    it("Returns the full info about staking limit", async () => {
      const expected = {
        isStakingPaused: true,
        isStakingLimitSet: false,
        currentStakeLimit: 0n,
        maxStakeLimit: 0n,
        maxStakeLimitGrowthBlocks: 0n,
        prevStakeLimit: 0n,
        prevStakeBlockNumber: 0n,
      };

      expect(await lido.getStakeLimitFullInfo()).to.deep.equal(Object.values(expected));

      const resumeTx = await lido.resumeStaking();

      expected.isStakingPaused = false;
      expected.currentStakeLimit = MaxUint256;
      expected.prevStakeBlockNumber = BigInt(resumeTx.blockNumber!);

      expect(await lido.getStakeLimitFullInfo()).to.deep.equal(Object.values(expected));

      const setTx = await lido.setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);

      expected.isStakingLimitSet = true;
      expected.currentStakeLimit = expected.maxStakeLimit = expected.prevStakeLimit = maxStakeLimit;
      expected.maxStakeLimitGrowthBlocks = maxStakeLimit / stakeLimitIncreasePerBlock;
      expected.prevStakeBlockNumber = BigInt(setTx.blockNumber!);
      expect(await lido.getStakeLimitFullInfo()).to.deep.equal(Object.values(expected));

      const stakeValue = maxStakeLimit;
      const stakeTx = await lido.submit(ZeroAddress, { value: stakeValue });

      expected.currentStakeLimit = expected.prevStakeLimit = maxStakeLimit - stakeValue;
      expected.prevStakeBlockNumber = BigInt(stakeTx.blockNumber!);
      expect(await lido.getStakeLimitFullInfo()).to.deep.equal(Object.values(expected));

      for (let i = 1n; i <= expected.maxStakeLimitGrowthBlocks; i++) {
        await mine(1);
        expected.currentStakeLimit = (expected.maxStakeLimit / expected.maxStakeLimitGrowthBlocks) * i;
        expect(await lido.getStakeLimitFullInfo()).to.deep.equal(Object.values(expected));
      }
    });
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
