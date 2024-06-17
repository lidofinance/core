import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { BigIntMath, ether, impersonate } from "lib";

import { logBlock, Snapshot } from "test/suite";
import { Contracts, Protocol } from "test/suite/protocol";

describe("Protocol all-round happy path", () => {
  let protocol: Protocol;
  let contracts: Contracts;

  let snapshot: string;

  before(async () => {
    protocol = new Protocol();
    contracts = await protocol.discover();
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  context("State", () => {
    it("staking is un-paused", async () => {
      await protocol.unpauseStaking();

      expect(await contracts.lido.isStakingPaused()).to.be.false;
    });

    it("withdrawal queue is un-paused", async () => {
      await protocol.unpauseWithdrawalQueue();

      expect(await contracts.withdrawalQueue.isPaused()).to.be.false;
    });
  });

  context("All-Round Happy Path", () => {
    // let uncountedStETHShares: bigint;
    let ethHolder: HardhatEthersSigner;
    let stEthHolder: HardhatEthersSigner;
    let stranger: HardhatEthersSigner;

    before(async () => {
      await protocol.unpauseStaking();
      await protocol.unpauseWithdrawalQueue();

      const signers = await ethers.getSigners();

      ethHolder = await impersonate(signers[0].address, ether("1000000"));
      stEthHolder = await impersonate(signers[1].address, ether("1000000"));
      stranger = await impersonate(signers[2].address);

      // logBlock("Stake limit", {
      //   "Current stake limit": ethers.formatEther(await contracts.lido.getCurrentStakeLimit()),
      // });

      await stEthHolder.sendTransaction({ to: await contracts.lido.getAddress(), value: ether("10000") });
    });

    it("passes", async () => {
      const amount = ether("100");
      const withdrawalQueueAddress = await contracts.withdrawalQueue.getAddress();
      let lastFinalizedRequestId = await contracts.withdrawalQueue.getLastFinalizedRequestId();
      let lastRequestId = await contracts.withdrawalQueue.getLastRequestId();

      // logBlock("Stake limit", {
      //   "Current stake limit": ethers.formatEther(await contracts.lido.getCurrentStakeLimit()),
      // });

      while (lastFinalizedRequestId != lastRequestId) {
        // report_tx = oracle_report()[0] // TODO: implement

        [lastFinalizedRequestId, lastRequestId] = await Promise.all([
          contracts.withdrawalQueue.getLastFinalizedRequestId(),
          await contracts.withdrawalQueue.getLastRequestId(),
        ]);

        logBlock("Withdrawal queue", {
          "Last finalized request ID": lastFinalizedRequestId.toString(),
          "Last request ID": lastRequestId.toString(),
        });

        await contracts.lido.submit(ZeroAddress, { value: ether("10000"), from: ethHolder });
      }

      await contracts.lido.submit(ZeroAddress, { value: ether("10000"), from: ethHolder });

      // const uncountedStETHShares = await contracts.lido.balanceOf(withdrawalQueueAddress);
      await contracts.lido.connect(stEthHolder).approve(withdrawalQueueAddress, 1000n);
      await contracts.withdrawalQueue.connect(stEthHolder).requestWithdrawals([1000n], stEthHolder);

      const strangerAddress = stranger.address;
      const strangerBalanceBeforeSubmit = await ethers.provider.getBalance(strangerAddress);
      const strangerStEthBalanceBeforeSubmit = await contracts.lido.balanceOf(strangerAddress);

      logBlock("Stranger before submit", {
        address: strangerAddress,
        ETH: ethers.formatEther(strangerBalanceBeforeSubmit),
        stETH: ethers.formatEther(strangerStEthBalanceBeforeSubmit),
      });

      expect(strangerStEthBalanceBeforeSubmit).to.be.equal(0n);

      // # ensure SimpleDVT has some keys to deposit
      // fill_simple_dvt_ops_vetted_keys(stranger, 3, 5)

      const stakeLimitInfoBefore = await contracts.lido.getStakeLimitFullInfo();

      const growthPerBlock = stakeLimitInfoBefore.maxStakeLimit;
      const totalSupplyBeforeSubmit = await contracts.lido.totalSupply();
      const bufferedEtherBeforeSubmit = await contracts.lido.getBufferedEther();
      const stakingLimitBeforeSubmit = await contracts.lido.getCurrentStakeLimit();
      const heightBeforeSubmit = await ethers.provider.getBlockNumber();

      logBlock("Before submit", {
        "Chain height": heightBeforeSubmit.toString(),
        "Growth per block": ethers.formatEther(growthPerBlock),
        "Total supply": ethers.formatEther(totalSupplyBeforeSubmit),
        "Buffered ether": ethers.formatEther(bufferedEtherBeforeSubmit),
        "Staking limit": ethers.formatEther(stakingLimitBeforeSubmit),
      });

      const tx = await contracts.lido.connect(stranger).submit(ZeroAddress, { value: amount, from: stranger });
      const receipt = await tx.wait();

      const stEthBalanceAfterSubmit = await contracts.lido.balanceOf(strangerAddress);
      const strangerBalanceAfterSubmit = await ethers.provider.getBalance(strangerAddress);

      logBlock("Stranger after submit", {
        ETH: ethers.formatEther(strangerBalanceAfterSubmit),
        stETH: ethers.formatEther(stEthBalanceAfterSubmit),
      });

      const balanceChange = BigIntMath.abs(strangerBalanceAfterSubmit - strangerBalanceBeforeSubmit);
      const gasUsed = receipt!.cumulativeGasUsed * receipt!.gasPrice!;
      const balanceChangeDiff = BigIntMath.abs(balanceChange - amount - gasUsed);
      expect(balanceChangeDiff).to.be.lt(10n).and.to.be.gte(0); // 0 <= x < 10

      const stEthBalanceChange = BigIntMath.abs(stEthBalanceAfterSubmit - strangerStEthBalanceBeforeSubmit);
      const stEthBalanceChangeDiff = BigIntMath.abs(stEthBalanceChange - amount);
      expect(stEthBalanceChangeDiff).to.be.lt(10n).and.to.be.gte(0); // 0 <= x < 10

      logBlock("Balance changes", {
        "ETH (Wei)": balanceChange.toString(),
        "stETH (stWei)": stEthBalanceChange.toString(),
      });

      const stakeLimitInfoAfter = await contracts.lido.getStakeLimitFullInfo();
      const growthPerBlockAfterSubmit = stakeLimitInfoAfter.maxStakeLimit;
      const totalSupplyAfterSubmit = await contracts.lido.totalSupply();
      const bufferedEtherAfterSubmit = await contracts.lido.getBufferedEther();
      const stakingLimitAfterSubmit = await contracts.lido.getCurrentStakeLimit();

      const heightAfterSubmit = await ethers.provider.getBlockNumber();

      logBlock("After submit", {
        "Chain height": heightAfterSubmit.toString(),
        "Growth per block": ethers.formatEther(growthPerBlockAfterSubmit),
        "Total supply": ethers.formatEther(totalSupplyAfterSubmit),
        "Buffered ether": ethers.formatEther(bufferedEtherAfterSubmit),
        "Staking limit": ethers.formatEther(stakingLimitAfterSubmit),
      });

      // const sharesToBeMinted = await contracts.lido.getSharesByPooledEth(amount);
    });
  });
});
