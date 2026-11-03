import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsBus, TriggerableWithdrawalsGateway, WithdrawalVault } from "typechain-types";

import { ether, impersonate, readWithdrawalRequests } from "lib";
import { randomValidatorPubkey } from "lib/pdg";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  DISABLED_TRIGGERABLE_WITHDRAWALS_LIMIT,
  drainWithdrawalRequestsQueue,
  ensureRoleFromAgent,
  fixedTriggerableWithdrawalsLimit,
  setTriggerableWithdrawalsConsumerLimits,
} from "lib/protocol/helpers";

import { encodeEIP7002Payload } from "test/0.8.9/withdrawalVault/eip7002Mock";
import { Snapshot } from "test/suite";

const GWEI_PER_ETH = 10n ** 9n;
const PWR_LIMIT_GWEI = 10_000n * GWEI_PER_ETH;
const FWR_LIMIT = 10n;

/**
 * Modules withdrawals flow of LIP-38 on the deployed protocol: a consumer with its own limits (a staking module
 * ejector) calls TriggerableWithdrawalsGateway directly, without touching the quota of the bus.
 */
describe("Integration: TriggerableWithdrawalsGateway module path", () => {
  let ctx: ProtocolContext;

  let gateway: TriggerableWithdrawalsGateway;
  let bus: TriggerableWithdrawalsBus;
  let withdrawalVault: WithdrawalVault;

  let requester: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let globalSnapshot: string;
  let testSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();
    globalSnapshot = await Snapshot.take();

    gateway = ctx.contracts.triggerableWithdrawalsGateway;
    bus = ctx.contracts.triggerableWithdrawalsBus;
    withdrawalVault = ctx.contracts.withdrawalVault;

    [, requester, executor, stranger] = await ethers.getSigners();
    await setTriggerableWithdrawalsConsumerLimits(
      ctx,
      requester.address,
      fixedTriggerableWithdrawalsLimit(PWR_LIMIT_GWEI),
      fixedTriggerableWithdrawalsLimit(FWR_LIMIT),
    );
  });

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
    await drainWithdrawalRequestsQueue();
  });

  afterEach(async () => await Snapshot.restore(testSnapshot));

  after(async () => await Snapshot.restore(globalSnapshot));

  const currentLimits = async (consumer: string) => {
    const { pwrLimit, fwrLimit } = await gateway.getConsumerLimitsFullInfo(consumer);
    return { pwr: pwrLimit.currentLimit, fwr: fwrLimit.currentLimit };
  };

  const fullWithdrawal = () => ({ amount: 0n, pubkey: randomValidatorPubkey() });
  const partialWithdrawal = (amount: bigint) => ({ amount, pubkey: randomValidatorPubkey() });

  it("rejects callers without limits", async () => {
    const fee = await withdrawalVault.getWithdrawalRequestFee();

    await expect(gateway.connect(stranger).triggerWithdrawals([fullWithdrawal()], stranger.address, { value: fee }))
      .to.be.revertedWithCustomError(gateway, "FwrLimitExceeded")
      .withArgs(1, 0);
  });

  it("submits full and partial withdrawals and consumes the caller's quotas", async () => {
    const intents = [fullWithdrawal(), partialWithdrawal(5n * GWEI_PER_ETH)];
    const fee = await withdrawalVault.getWithdrawalRequestFee();

    const tx = gateway.connect(requester).triggerWithdrawals(intents, requester.address, {
      value: fee * BigInt(intents.length),
    });

    await expect(tx)
      .to.emit(gateway, "WithdrawalsTriggered")
      .withArgs(requester.address, 1, 5n * GWEI_PER_ETH, 1);
    for (const intent of intents) {
      await expect(tx)
        .to.emit(withdrawalVault, "WithdrawalRequestAdded")
        .withArgs(encodeEIP7002Payload(intent.pubkey, intent.amount));
    }

    expect(await currentLimits(requester.address)).to.deep.equal({
      pwr: PWR_LIMIT_GWEI - 5n * GWEI_PER_ETH,
      fwr: FWR_LIMIT - 1n,
    });

    const requests = await readWithdrawalRequests();
    expect(requests.map(({ pubkey, amount }) => ({ pubkey, amount }))).to.deep.equal(intents);
  });

  it("rejects partial withdrawals of a consumer with PWRs disabled, as for a module ejector", async () => {
    await setTriggerableWithdrawalsConsumerLimits(
      ctx,
      requester.address,
      DISABLED_TRIGGERABLE_WITHDRAWALS_LIMIT,
      fixedTriggerableWithdrawalsLimit(FWR_LIMIT),
    );
    const fee = await withdrawalVault.getWithdrawalRequestFee();

    await expect(
      gateway
        .connect(requester)
        .triggerWithdrawals([partialWithdrawal(5n * GWEI_PER_ETH)], requester.address, { value: fee }),
    )
      .to.be.revertedWithCustomError(gateway, "PwrLimitExceeded")
      .withArgs(5n * GWEI_PER_ETH, 0);

    await expect(
      gateway.connect(requester).triggerWithdrawals([fullWithdrawal()], requester.address, { value: fee }),
    ).to.emit(gateway, "WithdrawalsTriggered");
  });

  it("does not touch the quota of the bus", async () => {
    await setTriggerableWithdrawalsConsumerLimits(
      ctx,
      requester.address,
      DISABLED_TRIGGERABLE_WITHDRAWALS_LIMIT,
      fixedTriggerableWithdrawalsLimit(1n),
    );
    const fee = await withdrawalVault.getWithdrawalRequestFee();
    const busAddress = await bus.getAddress();
    const busLimitsBefore = await currentLimits(busAddress);

    await gateway.connect(requester).triggerWithdrawals([fullWithdrawal()], requester.address, { value: fee });
    await expect(gateway.connect(requester).triggerWithdrawals([fullWithdrawal()], requester.address, { value: fee }))
      .to.be.revertedWithCustomError(gateway, "FwrLimitExceeded")
      .withArgs(1, 0);

    expect(await currentLimits(busAddress)).to.deep.equal(busLimitsBefore);

    const oracle = await impersonate(await ctx.contracts.validatorsExitBusOracle.getAddress(), ether("10"));
    await bus.connect(oracle).addWithdrawalIntents([fullWithdrawal()]);
    const queued = await bus.unprocessedIntentsCount();

    await expect(
      bus.connect(executor).processWithdrawalIntents(queued, executor.address, { value: fee * queued }),
    ).to.emit(gateway, "WithdrawalsTriggered");
  });

  it("stops both paths while paused", async () => {
    const agent = await ctx.getSigner("agent");
    await ensureRoleFromAgent(ctx, gateway, await gateway.PAUSE_ROLE(), agent);
    await gateway.connect(agent).pauseFor(3600n);

    const fee = await withdrawalVault.getWithdrawalRequestFee();

    await expect(
      gateway.connect(requester).triggerWithdrawals([fullWithdrawal()], requester.address, { value: fee }),
    ).to.be.revertedWithCustomError(gateway, "ResumedExpected");

    const oracle = await impersonate(await ctx.contracts.validatorsExitBusOracle.getAddress(), ether("10"));
    await bus.connect(oracle).addWithdrawalIntents([fullWithdrawal()]);

    await expect(
      bus.connect(executor).processWithdrawalIntents(1, executor.address, { value: fee }),
    ).to.be.revertedWithCustomError(gateway, "ResumedExpected");
  });
});
