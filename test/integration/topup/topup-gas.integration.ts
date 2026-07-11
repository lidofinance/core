import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, findEventsWithInterfaces, log } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  buildTopUpData,
  cmv2EnsureDepositedOperatorKeys,
  cmv2NormalizeTopUpAllocationBaseline,
  CMv2OperatorKeys,
  depositEventInterface,
  expectedTopUpLimitWei,
  getCMv2ModuleId,
  getTopUpRoleSigner,
  prepareTopUpWitnesses,
  topUpEnsureDepositableEther,
  topUpEnsureModuleAllocation,
} from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

const GWEI = 10n ** 9n;

/**
 * Gas measurement for the full TopUpGateway.topUp() path: CL proof verification,
 * CMv2.allocateDeposits and real DepositContract top-up deposits.
 *
 * The batch size defaults to the gateway's maxValidatorsPerTopUp; set
 * NUM_VALIDATORS_OVERRIDE to measure other batch sizes.
 */
describe("Integration: TopUpGateway full-path gas measurement (real CMv2)", () => {
  let ctx: ProtocolContext;

  let topUpCaller: HardhatEthersSigner;

  let moduleId: bigint;
  let target: CMv2OperatorKeys;

  let numValidators: number;

  // null = the gateway's maxValidatorsPerTopUp
  const NUM_VALIDATORS_OVERRIDE: number | null = null;

  // Multiple of the allocator's 2 ETH step, >= minTopUpGwei, and small enough that
  // large batches stay under the maxTopUpPerBlockGwei cap
  const TOP_UP_PER_KEY = ether("4");

  const MAX_BLOCK_GAS = 16_000_000n;

  let originalState: string;

  before(async function () {
    ctx = await getProtocolContext();
    originalState = await Snapshot.take();

    if (!ctx.flags.withCMv2) {
      log.warning("Skipping top-up gas suite: INTEGRATION_WITH_CMv2=off");
      this.skip();
    }
    if (!ctx.modules.cmv2) {
      throw new Error(
        "CMv2 (curated-onchain-v2) module is not registered in StakingRouter. " +
          "The top-up suites require the real CMv2 topology; " +
          "set INTEGRATION_WITH_CMv2=off to skip them explicitly.",
      );
    }

    const { topUpGateway } = ctx.contracts;

    moduleId = getCMv2ModuleId(ctx);
    topUpCaller = await getTopUpRoleSigner(ctx);

    const maxValidatorsPerTopUp = await topUpGateway.getMaxValidatorsPerTopUp();
    numValidators = NUM_VALIDATORS_OVERRIDE ?? Number(maxValidatorsPerTopUp);

    if (BigInt(numValidators) > maxValidatorsPerTopUp) {
      const agentSigner = await ctx.getSigner("agent");
      const MANAGE_LIMITS_ROLE = await topUpGateway.MANAGE_LIMITS_ROLE();
      await topUpGateway.connect(agentSigner).grantRole(MANAGE_LIMITS_ROLE, agentSigner.address);
      await topUpGateway.connect(agentSigner).setMaxValidatorsPerTopUp(numValidators);
    }

    // Normalized baseline: every key receives its full expected top-up
    target = await cmv2EnsureDepositedOperatorKeys(ctx, BigInt(numValidators), {
      name: "topup_gas_operator",
      forceCreate: true,
    });
    await cmv2NormalizeTopUpAllocationBaseline(ctx, target.operatorId);

    const totalTopUp = BigInt(numValidators) * TOP_UP_PER_KEY;
    await topUpEnsureDepositableEther(ctx, totalTopUp + ether("32"));
    await topUpEnsureModuleAllocation(ctx, moduleId, totalTopUp);
  });

  after(async () => await Snapshot.restore(originalState));

  it("should measure gas for a full-path topUp at the configured batch size", async () => {
    const { topUpGateway } = ctx.contracts;

    const targetBalanceGwei = await topUpGateway.getTargetBalanceGwei();
    const ebGwei = targetBalanceGwei - TOP_UP_PER_KEY / GWEI;
    expect(await expectedTopUpLimitWei(ctx, ebGwei)).to.equal(TOP_UP_PER_KEY);

    const bundle = await prepareTopUpWitnesses(
      ctx,
      target.pubkeys.map((pubkey) => ({ pubkey, effectiveBalanceGwei: ebGwei })),
    );

    const tx = await topUpGateway.connect(topUpCaller).topUp(
      buildTopUpData(
        moduleId,
        {
          keyIndices: target.keyIndices,
          operatorIds: target.keyIndices.map(() => target.operatorId),
        },
        bundle,
      ),
    );
    const receipt = await tx.wait();

    // The measurement only counts if the full path really executed for every key
    const expectedTotal = BigInt(numValidators) * TOP_UP_PER_KEY;
    const topUpEvents = ctx.getEvents(receipt!, "StakingRouterETHTopUp");
    expect(topUpEvents[0].args.amount).to.equal(expectedTotal);
    const depositEvents = findEventsWithInterfaces(receipt!, "DepositEvent", [depositEventInterface]);
    expect(depositEvents.length).to.equal(numValidators);

    const gasUsed = receipt!.gasUsed;
    const perValidator = gasUsed / BigInt(numValidators);

    console.log(`\n  Full-path TopUpGateway.topUp() with ${numValidators} validators (real CMv2 + DepositContract):`);
    console.log(`    Gas used:         ${Number(gasUsed).toLocaleString()}`);
    console.log(`    Per validator:    ${Number(perValidator).toLocaleString()}`);
    console.log(`    Topped up:        ${ethers.formatEther(expectedTotal)} ETH`);
    console.log(
      `    Fits in block:    ${gasUsed < MAX_BLOCK_GAS ? "YES" : "NO"} (limit: ${Number(MAX_BLOCK_GAS).toLocaleString()})`,
    );

    expect(gasUsed).to.be.lt(MAX_BLOCK_GAS);
  });
});
