import { expect } from "chai";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsBus, TriggerableWithdrawalsGateway, WithdrawalVault } from "typechain-types";

import { ether, impersonate, readWithdrawalRequests } from "lib";
import { randomValidatorPubkey } from "lib/pdg";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  drainWithdrawalRequestsQueue,
  fixedTriggerableWithdrawalsLimit,
  setTriggerableWithdrawalsConsumerLimits,
} from "lib/protocol/helpers";

import { encodeEIP7002Payload } from "test/0.8.9/withdrawalVault/eip7002Mock";
import { Snapshot } from "test/suite";

const GWEI_PER_ETH = 10n ** 9n;
const MAX_PWR_AMOUNT_GWEI = 2016n * GWEI_PER_ETH;

/**
 * Oracle withdrawals flow of LIP-38 on the deployed protocol:
 * ValidatorsExitBusOracle -> TriggerableWithdrawalsBus -> TriggerableWithdrawalsGateway -> WithdrawalVault -> EIP-7002.
 */
describe("Integration: TriggerableWithdrawalsBus flow", () => {
  let ctx: ProtocolContext;

  let bus: TriggerableWithdrawalsBus;
  let gateway: TriggerableWithdrawalsGateway;
  let withdrawalVault: WithdrawalVault;

  let oracle: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let globalSnapshot: string;
  let testSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();
    globalSnapshot = await Snapshot.take();

    bus = ctx.contracts.triggerableWithdrawalsBus;
    gateway = ctx.contracts.triggerableWithdrawalsGateway;
    withdrawalVault = ctx.contracts.withdrawalVault;

    [, executor, stranger] = await ethers.getSigners();
    oracle = await impersonate(await ctx.contracts.validatorsExitBusOracle.getAddress(), ether("10"));
  });

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
    await drainWithdrawalRequestsQueue();
  });

  afterEach(async () => await Snapshot.restore(testSnapshot));

  after(async () => await Snapshot.restore(globalSnapshot));

  const fullWithdrawal = () => ({ amount: 0n, pubkey: randomValidatorPubkey() });
  const partialWithdrawal = (amount: bigint) => ({ amount, pubkey: randomValidatorPubkey() });

  /** Processes anything queued before a test, so the test sees only its own intents. */
  const processQueued = async () => {
    const queued = await bus.unprocessedIntentsCount();
    if (queued === 0n) return;

    const fee = await withdrawalVault.getWithdrawalRequestFee();
    await bus.connect(executor).processWithdrawalIntents(queued, executor.address, { value: fee * queued });
    await drainWithdrawalRequestsQueue();
  };

  it("is wired into the protocol", async () => {
    expect(await ctx.contracts.locator.triggerableWithdrawalsBus()).to.equal(await bus.getAddress());
    expect(await bus.LOCATOR()).to.equal(await ctx.contracts.locator.getAddress());
    expect(await withdrawalVault.TRIGGERABLE_WITHDRAWALS_GATEWAY()).to.equal(await gateway.getAddress());

    // The bus is a gateway consumer: both quotas are enabled, and a max partial withdrawal fits the PWR one
    const { pwrLimit, fwrLimit } = await gateway.getConsumerLimitsFullInfo(await bus.getAddress());
    expect(pwrLimit.maxLimit).to.be.gte(MAX_PWR_AMOUNT_GWEI);
    expect(fwrLimit.maxLimit).to.be.gt(0n);

    const publisherRole = await bus.ADD_WITHDRAWAL_INTENTS_ROLE();
    expect(await bus.getRoleMemberCount(publisherRole)).to.equal(1);
    expect(await bus.hasRole(publisherRole, oracle.address)).to.be.true;

    expect(await bus.getRoleMemberCount(await bus.CLEAR_WITHDRAWAL_INTENTS_ROLE())).to.equal(0);
  });

  it("accepts intents only from the oracle", async () => {
    await expect(bus.connect(stranger).addWithdrawalIntents([fullWithdrawal()]))
      .to.be.revertedWithCustomError(bus, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, await bus.ADD_WITHDRAWAL_INTENTS_ROLE());
  });

  it("queues the oracle's intents and executes them as EIP-7002 requests", async () => {
    await processQueued();

    const intents = [
      fullWithdrawal(),
      partialWithdrawal(2n * GWEI_PER_ETH),
      partialWithdrawal(32n * GWEI_PER_ETH + 1n),
    ];

    await expect(bus.connect(oracle).addWithdrawalIntents(intents))
      .to.emit(bus, "WithdrawalIntentsAdded")
      .withArgs(anyValue, intents.length);
    expect(await bus.unprocessedIntentsCount()).to.equal(intents.length);

    const fee = await withdrawalVault.getWithdrawalRequestFee();
    const totalFee = fee * BigInt(intents.length);
    const tx = bus.connect(executor).processWithdrawalIntents(intents.length, ethers.ZeroAddress, {
      value: totalFee + ether("0.01"),
    });

    await expect(tx).to.emit(bus, "WithdrawalIntentsProcessed").withArgs(anyValue, intents.length);
    // The bus is the consumer: two partial withdrawals by their amounts, one full withdrawal
    await expect(tx)
      .to.emit(gateway, "WithdrawalsTriggered")
      .withArgs(await bus.getAddress(), 2, 34n * GWEI_PER_ETH + 1n, 1);
    for (const intent of intents) {
      await expect(tx)
        .to.emit(withdrawalVault, "WithdrawalRequestAdded")
        .withArgs(encodeEIP7002Payload(intent.pubkey, intent.amount));
    }
    // The excess fee is refunded to the caller
    await expect(tx).to.changeEtherBalance(executor, -totalFee);

    expect(await bus.unprocessedIntentsCount()).to.equal(0);

    const vaultAddress = (await withdrawalVault.getAddress()).toLowerCase();
    const requests = await readWithdrawalRequests();
    expect(
      requests.map(({ address, pubkey, amount }) => ({ address: address.toLowerCase(), pubkey, amount })),
    ).to.deep.equal(intents.map(({ pubkey, amount }) => ({ address: vaultAddress, pubkey, amount })));
  });

  it("processes exactly the requested count", async () => {
    await processQueued();
    await bus.connect(oracle).addWithdrawalIntents([fullWithdrawal(), fullWithdrawal()]);
    const fee = await withdrawalVault.getWithdrawalRequestFee();

    await expect(bus.connect(executor).processWithdrawalIntents(3, executor.address, { value: fee * 3n }))
      .to.be.revertedWithCustomError(bus, "InsufficientWithdrawalIntents")
      .withArgs(3, 2);

    expect(await bus.unprocessedIntentsCount()).to.equal(2);
  });

  it("keeps the head of the queue until its quota allows it, holding back the intents behind it", async () => {
    await processQueued();
    await setTriggerableWithdrawalsConsumerLimits(
      ctx,
      await bus.getAddress(),
      fixedTriggerableWithdrawalsLimit(MAX_PWR_AMOUNT_GWEI),
      fixedTriggerableWithdrawalsLimit(1n),
    );

    const intents = [fullWithdrawal(), fullWithdrawal(), partialWithdrawal(GWEI_PER_ETH)];
    await bus.connect(oracle).addWithdrawalIntents(intents);
    const fee = await withdrawalVault.getWithdrawalRequestFee();

    await expect(bus.connect(executor).processWithdrawalIntents(2, executor.address, { value: fee * 2n }))
      .to.be.revertedWithCustomError(gateway, "FwrLimitExceeded")
      .withArgs(2, 1);
    expect(await bus.unprocessedIntentsCount()).to.equal(3);

    await expect(bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: fee }))
      .to.emit(gateway, "WithdrawalsTriggered")
      .withArgs(await bus.getAddress(), 0, 0, 1);

    // The PWR quota is full, but the partial withdrawal waits behind a full withdrawal with no FWR quota left
    await expect(bus.connect(executor).processWithdrawalIntents(2, executor.address, { value: fee * 2n }))
      .to.be.revertedWithCustomError(gateway, "FwrLimitExceeded")
      .withArgs(1, 0);

    expect(await bus.unprocessedIntentsCount()).to.equal(2);
    expect((await bus.getWithdrawalIntents(0, 1))[0].pubkey).to.equal(intents[1].pubkey);
  });

  it("lets the DAO drop the whole queue", async () => {
    await bus.connect(oracle).addWithdrawalIntents([fullWithdrawal(), partialWithdrawal(GWEI_PER_ETH)]);
    const queued = await bus.unprocessedIntentsCount();

    const agent = await ctx.getSigner("agent");
    const clearRole = await bus.CLEAR_WITHDRAWAL_INTENTS_ROLE();
    await bus.connect(agent).grantRole(clearRole, agent.address);

    await expect(bus.connect(agent).clearWithdrawalIntents()).to.emit(bus, "WithdrawalIntentsCleared").withArgs(queued);

    await bus.connect(agent).revokeRole(clearRole, agent.address);

    expect(await bus.unprocessedIntentsCount()).to.equal(0);
    expect(await readWithdrawalRequests()).to.deep.equal([]);

    // New intents are processed as usual
    const intent = fullWithdrawal();
    await bus.connect(oracle).addWithdrawalIntents([intent]);
    const fee = await withdrawalVault.getWithdrawalRequestFee();

    await expect(bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: fee }))
      .to.emit(withdrawalVault, "WithdrawalRequestAdded")
      .withArgs(encodeEIP7002Payload(intent.pubkey, intent.amount));
  });
});
