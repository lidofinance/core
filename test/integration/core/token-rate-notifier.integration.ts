import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TokenRateNotifier, TokenRatePusher__Mock, TokenRatePusherWithArgs__Mock } from "typechain-types";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext, report, resetCLBalanceDecreaseWindow } from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

// End-to-end coverage for the TokenRateNotifier as wired into the live protocol: a real oracle
// report flows through `Accounting.handleOracleReport` → `postTokenRebaseReceiver` (this notifier)
// → registered observers. Unit tests drive `handlePostTokenRebase` directly with a fake provider;
// here we assert the actual protocol payload is delivered and that a faulty observer cannot brick
// the daily rebase.
// ObserverKind enum in TokenRateNotifier.sol: { NoArgs, WithArgs }.
const KIND_NO_ARGS = 0n;
const KIND_WITH_ARGS = 1n;

describe("Integration: TokenRateNotifier rebase dispatch", () => {
  let ctx: ProtocolContext;
  let testSnapshot: string;

  let notifier: TokenRateNotifier;
  let notifierAddress: string;
  let agent: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();

    const { locator } = ctx.contracts;
    notifierAddress = await locator.postTokenRebaseReceiver();
    notifier = await ethers.getContractAt("TokenRateNotifier", notifierAddress);
    agent = await ctx.getSigner("agent");

    // Land on a steady reporting baseline. On forks the last on-chain report can be stale, so a
    // naive clDiff=0 report trips IncorrectCLBalanceDecrease; this advances past the 36-day window
    // and submits a neutral report to reset it. Harmless on scratch.
    await resetCLBalanceDecreaseWindow(ctx);
  });

  // Per-test isolation: each scenario registers observers / pushes reports, so restore to the
  // warmed-up baseline after every test.
  beforeEach(bailOnFailure);
  beforeEach(async () => (testSnapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(testSnapshot));

  // Trigger a positive rebase and return both the receipt and the Lido `TokenRebased` event, whose
  // 7 fields mirror the `ITokenRatePusherWithArgs.pushTokenRate(...)` payload 1:1.
  async function positiveReport() {
    // Small positive CL diff: stays well under the sanity-checker's per-report increase limit while
    // still producing a positive rebase (and non-zero `sharesMintedAsFees`).
    const { reportTx } = await report(ctx, { clDiff: ether("0.01"), excludeVaultsBalances: true });
    const receipt = (await reportTx!.wait())! as ContractTransactionReceipt;
    const tokenRebased = ctx.getEvents(receipt, "TokenRebased")[0];
    return { receipt, tokenRebased };
  }

  it("is wired into the protocol as the rebase receiver", async () => {
    const { locator } = ctx.contracts;

    expect(notifierAddress).to.equal(await locator.postTokenRebaseReceiver());
    // The notifier only accepts `handlePostTokenRebase` from the accounting contract.
    expect(await notifier.TOKEN_RATE_PROVIDER()).to.equal(await locator.accounting());
    expect(await notifier.owner()).to.equal(agent.address);
  });

  it("forwards the exact rebase payload to a WithArgs observer", async () => {
    const mock = (await ethers.deployContract("TokenRatePusherWithArgs__Mock")) as TokenRatePusherWithArgs__Mock;
    await notifier.connect(agent).addObserver(mock, KIND_WITH_ARGS);

    const { tokenRebased } = await positiveReport();

    expect(await mock.pushCount()).to.equal(1n);
    // sanity: it was indeed a positive rebase
    expect(tokenRebased.args.postTotalEther).to.be.greaterThan(tokenRebased.args.preTotalEther);

    const received = await mock.lastReceived();
    expect(received.reportTimestamp).to.equal(tokenRebased.args.reportTimestamp);
    expect(received.timeElapsed).to.equal(tokenRebased.args.timeElapsed);
    expect(received.preTotalShares).to.equal(tokenRebased.args.preTotalShares);
    expect(received.preTotalEther).to.equal(tokenRebased.args.preTotalEther);
    expect(received.postTotalShares).to.equal(tokenRebased.args.postTotalShares);
    expect(received.postTotalEther).to.equal(tokenRebased.args.postTotalEther);
    expect(received.sharesMintedAsFees).to.equal(tokenRebased.args.sharesMintedAsFees);
  });

  it("notifies a no-arg observer on each rebase", async () => {
    const mock = (await ethers.deployContract("TokenRatePusher__Mock")) as TokenRatePusher__Mock;
    await notifier.connect(agent).addObserver(mock, KIND_NO_ARGS);

    await positiveReport();
    expect(await mock.pushCount()).to.equal(1n);

    await positiveReport();
    expect(await mock.pushCount()).to.equal(2n);
  });

  it("a reverting observer does not brick the rebase; healthy observers still notified", async () => {
    const bad = (await ethers.deployContract("TokenRatePusherWithArgs__Mock")) as TokenRatePusherWithArgs__Mock;
    const good = (await ethers.deployContract("TokenRatePusher__Mock")) as TokenRatePusher__Mock;
    await bad.setShouldRevertWithData(true);

    await notifier.connect(agent).addObserver(bad, KIND_WITH_ARGS);
    await notifier.connect(agent).addObserver(good, KIND_NO_ARGS);

    const { receipt } = await positiveReport();

    // The oracle report itself must succeed despite the faulty observer.
    expect(receipt.status).to.equal(1);
    // The bad observer reverted with data → soft failure, no recorded push.
    expect(await bad.pushCount()).to.equal(0n);
    // The notifier swallowed the revert and logged it (the notifier isn't part of ProtocolContext,
    // so decode its event directly rather than via ctx.getEvents).
    const failedEvents = await notifier.queryFilter(
      notifier.filters.PushTokenRateFailed(),
      receipt.blockNumber,
      receipt.blockNumber,
    );
    expect(failedEvents.length).to.be.greaterThan(0);
    expect(failedEvents.some((e) => e.args.observer === bad.target)).to.be.true;
    // The healthy observer is unaffected.
    expect(await good.pushCount()).to.equal(1n);
  });

  it("stops notifying a removed observer", async () => {
    const mock = (await ethers.deployContract("TokenRatePusher__Mock")) as TokenRatePusher__Mock;
    await notifier.connect(agent).addObserver(mock, KIND_NO_ARGS);

    await positiveReport();
    expect(await mock.pushCount()).to.equal(1n);

    await notifier.connect(agent).removeObserver(mock);

    await positiveReport();
    expect(await mock.pushCount()).to.equal(1n); // unchanged after removal
  });
});
