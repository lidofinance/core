import { expect } from "chai";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, findEventsWithInterfaces, ONE_GWEI } from "lib";
import {
  buildModuleAccountingReportParams,
  buildTopUpData,
  csm0x02EnsureDepositedKeys,
  depositEventAmountWei,
  depositEventInterface,
  getCSM0x02Module,
  getProtocolContext,
  getTopUpRoleSigner,
  prepareTopUpWitnesses,
  ProtocolContext,
  report,
  topUpEnsureDepositableEther,
  topUpEnsureModuleAllocation,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: TopUp Flow (TopUpGateway -> StakingRouter -> Real CSM 0x02)", () => {
  let ctx: ProtocolContext;
  let target: Awaited<ReturnType<typeof csm0x02EnsureDepositedKeys>>;
  let topUpCaller: HardhatEthersSigner;
  let effectiveBalanceGwei: bigint;
  let globalSnapshot: string;
  let testSnapshot: string;

  const TOP_UP_PER_KEY = ether("50");

  before(async () => {
    ctx = await getProtocolContext();
    globalSnapshot = await Snapshot.take();
    target = await csm0x02EnsureDepositedKeys(ctx, 2n);
    topUpCaller = await getTopUpRoleSigner(ctx);
    effectiveBalanceGwei = (await ctx.contracts.topUpGateway.getTargetBalanceGwei()) - TOP_UP_PER_KEY / ONE_GWEI;

    const credentials = await ctx.contracts.stakingRouter.getStakingModuleWithdrawalCredentials(target.moduleId);
    expect(credentials.slice(0, 4)).to.equal("0x02");

    await topUpEnsureDepositableEther(ctx, 2n * TOP_UP_PER_KEY + ether("32"));
    await topUpEnsureModuleAllocation(ctx, target.moduleId, 2n * TOP_UP_PER_KEY);
  });

  beforeEach(async () => (testSnapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(testSnapshot));
  after(async () => await Snapshot.restore(globalSnapshot));

  const topUp = async () => {
    const bundle = await prepareTopUpWitnesses(
      ctx,
      target.pubkeys.map((pubkey) => ({ pubkey, effectiveBalanceGwei })),
    );
    return ctx.contracts.topUpGateway.connect(topUpCaller).topUp(buildTopUpData(target.moduleId, target, bundle));
  };

  it("Should top up real CSM 0x02 validators end to end with exact amounts", async () => {
    const { lido, stakingRouter } = ctx.contracts;
    const { module } = getCSM0x02Module(ctx);
    const bufferedBefore = await lido.getBufferedEther();
    const nonceBefore = await stakingRouter.getStakingModuleNonce(target.moduleId);
    const allocatedBefore = await Promise.all(
      target.keyIndices.map(
        async (keyIndex, i) => (await module.getKeyAllocatedBalances(target.operatorIds[i], keyIndex, 1n))[0],
      ),
    );

    const receipt = (await (await topUp()).wait())!;
    const topUpEvents = ctx.getEvents(receipt, "StakingRouterETHTopUp");
    expect(topUpEvents.length).to.equal(1);
    expect(topUpEvents[0].args.stakingModuleId).to.equal(target.moduleId);
    expect(topUpEvents[0].args.amount).to.equal(2n * TOP_UP_PER_KEY);

    const deposits = findEventsWithInterfaces(receipt, "DepositEvent", [depositEventInterface]);
    expect(deposits.length).to.equal(2);
    for (let i = 0; i < target.pubkeys.length; i++) {
      expect(deposits[i].args.pubkey.toLowerCase()).to.equal(target.pubkeys[i].toLowerCase());
      expect(deposits[i].args.withdrawal_credentials.slice(0, 4)).to.equal("0x02");
      expect(depositEventAmountWei(deposits[i].args.amount)).to.equal(TOP_UP_PER_KEY);
      expect((await module.getKeyAllocatedBalances(target.operatorIds[i], target.keyIndices[i], 1n))[0]).to.equal(
        allocatedBefore[i] + TOP_UP_PER_KEY,
      );
    }
    expect(bufferedBefore - (await lido.getBufferedEther())).to.equal(2n * TOP_UP_PER_KEY);
    expect(await stakingRouter.getStakingModuleNonce(target.moduleId)).to.equal(nonceBefore + 1n);
  });

  it("Should account CSM 0x02 top-ups as pending and then validators balance without rewards", async () => {
    const { lido, stakingRouter } = ctx.contracts;
    const before = await lido.getBalanceStats();
    const moduleBalanceBefore = await stakingRouter.getModuleValidatorsBalance(target.moduleId);
    const pooledBefore = await lido.getTotalPooledEther();
    const sharesBefore = await lido.getTotalShares();
    const topUpAmount = 2n * TOP_UP_PER_KEY;

    await topUp();
    expect((await lido.getBalanceStats()).depositedSinceLastReport - before.depositedSinceLastReport).to.equal(
      topUpAmount,
    );

    const params = { reportElVault: false, reportWithdrawalsVault: false, reportBurner: false, skipWithdrawals: true };
    const pendingBalance = before.clPendingBalanceAtLastReport + topUpAmount;
    const pendingReport = await report(ctx, {
      ...params,
      clDiff: topUpAmount,
      clPendingBalanceGwei: pendingBalance / ONE_GWEI,
      ...(await buildModuleAccountingReportParams(ctx)),
    });
    const pendingReceipt = (await pendingReport.reportTx!.wait())!;
    const pendingState = await lido.getBalanceStats();
    expect(pendingState.clPendingBalanceAtLastReport).to.equal(pendingBalance);
    expect(pendingState.clValidatorsBalanceAtLastReport).to.equal(before.clValidatorsBalanceAtLastReport);
    expect(await stakingRouter.getModuleValidatorsBalance(target.moduleId)).to.equal(moduleBalanceBefore);
    expect(ctx.getEvents(pendingReceipt, "TokenRebased")[0].args.sharesMintedAsFees).to.equal(0n);

    const activationReport = await report(ctx, {
      ...params,
      clDiff: 0n,
      clPendingBalanceGwei: before.clPendingBalanceAtLastReport / ONE_GWEI,
      ...(await buildModuleAccountingReportParams(ctx, {
        validatorsDeltaGweiByModule: new Map([[target.moduleId, topUpAmount / ONE_GWEI]]),
      })),
    });
    const activationReceipt = (await activationReport.reportTx!.wait())!;
    const after = await lido.getBalanceStats();
    expect(after.clPendingBalanceAtLastReport).to.equal(before.clPendingBalanceAtLastReport);
    expect(after.clValidatorsBalanceAtLastReport).to.equal(before.clValidatorsBalanceAtLastReport + topUpAmount);
    expect(await stakingRouter.getModuleValidatorsBalance(target.moduleId)).to.equal(moduleBalanceBefore + topUpAmount);
    expect(ctx.getEvents(activationReceipt, "TokenRebased")[0].args.sharesMintedAsFees).to.equal(0n);
    expect(await lido.getTotalPooledEther()).to.equal(pooledBefore);
    expect(await lido.getTotalShares()).to.equal(sharesBefore);
  });
});
