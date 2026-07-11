import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, findEventsWithInterfaces, log } from "lib";
import { randomValidatorPubkey } from "lib/pdg";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  buildTopUpData,
  cmv2CreateOperatorWithKeys,
  cmv2EnsureDepositedOperatorKeys,
  cmv2NormalizeTopUpAllocationBaseline,
  CMv2OperatorKeys,
  cmv2RefreshDepositInfo,
  depositEventAmountWei,
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
const toGwei = (wei: bigint) => wei / GWEI;

/** Minimal interface to match custom errors of the external CMv2 module. */
const CMV2_ERRORS_ABI = [
  "error InvalidSigningKey()",
  "error SigningKeysInvalidOffset()",
  "error DepositInfoIsNotUpToDate()",
];

/**
 * Integration test for the full top-up flow over the real production topology:
 * TopUpGateway (CL proofs) -> StakingRouter.topUp -> CMv2.allocateDeposits ->
 * Lido.withdrawDepositableEther -> DepositContract top-up deposits.
 *
 * Target keys are real deposited CMv2 (curated-onchain-v2) validators. Witness
 * effective balances are chosen so the expected top-up amounts are exact constants.
 *
 * The suite requires a CMv2 module in the StakingRouter. When CMv2 is unavailable the
 * suite fails loudly; skipping is allowed only via the explicit
 * INTEGRATION_WITH_CMv2=off opt-out.
 */
describe("Integration: TopUp Flow (TopUpGateway -> StakingRouter -> Real CMv2)", () => {
  let ctx: ProtocolContext;

  let topUpCaller: HardhatEthersSigner;

  let moduleId: bigint;
  let target: CMv2OperatorKeys;

  let targetBalanceGwei: bigint;
  let minBlockDistance: bigint;
  let maxRootAge: bigint;

  // Witness EB is chosen so each key's expected top-up is exactly this amount
  const TOP_UP_PER_KEY = ether("50");

  let ebForTopUpGwei: bigint;

  let globalSnapshot: string;
  let testSnapshot: string;

  before(async function () {
    ctx = await getProtocolContext();

    globalSnapshot = await Snapshot.take();

    // Explicit runner contract: CMv2 is required unless deliberately opted out
    if (!ctx.flags.withCMv2) {
      log.warning("Skipping top-up flow suite: INTEGRATION_WITH_CMv2=off");
      this.skip();
    }
    if (!ctx.modules.cmv2) {
      throw new Error(
        "CMv2 (curated-onchain-v2) module is not registered in StakingRouter. " +
          "The top-up suites require the real CMv2 topology; " +
          "set INTEGRATION_WITH_CMv2=off to skip them explicitly.",
      );
    }

    const { topUpGateway, stakingRouter } = ctx.contracts;

    // =========================================
    // Pin the topology: the gateway has no on-chain target module id (it comes in
    // calldata), so the invariant is the module's 0x02 withdrawal credentials type
    // =========================================

    moduleId = getCMv2ModuleId(ctx);
    const moduleWC = await stakingRouter.getStakingModuleWithdrawalCredentials(moduleId);
    expect(moduleWC.slice(0, 4)).to.equal("0x02", "CMv2 withdrawal credentials must be of type 0x02");

    // Production deploys have exactly one TOP_UP_ROLE holder (the depositor);
    // the upgrade template asserts the same invariant
    const topUpRole = await topUpGateway.TOP_UP_ROLE();
    const holdersCount = await topUpGateway.getRoleMemberCount(topUpRole);
    if (holdersCount > 0n) {
      expect(holdersCount).to.equal(1n, "TOP_UP_ROLE must have a single holder (the depositor)");
    }
    topUpCaller = await getTopUpRoleSigner(ctx);

    targetBalanceGwei = await topUpGateway.getTargetBalanceGwei();
    minBlockDistance = await topUpGateway.getMinBlockDistance();
    maxRootAge = await topUpGateway.getMaxRootAge();

    ebForTopUpGwei = targetBalanceGwei - toGwei(TOP_UP_PER_KEY);

    // =========================================
    // Target: real deposited CMv2 keys. A fresh operator's per-key allocated balances
    // start from a known baseline; existing fork operators carry arbitrary ones.
    // =========================================

    target = await cmv2EnsureDepositedOperatorKeys(ctx, 2n, { name: "topup_target_operator", forceCreate: true });

    // Make the target the only operator with allocation weight, so expected amounts
    // are exact regardless of the fork state
    await cmv2NormalizeTopUpAllocationBaseline(ctx, target.operatorId);

    // allocateDeposits reverts while any operator's deposit info is stale
    await cmv2RefreshDepositInfo(ctx);

    // =========================================
    // Ether and router allocation for deterministic amounts.
    // The router quantizes allocations in maxEBType1 (32 ETH) validator-equivalents,
    // so the depositable buffer needs one extra quantum of headroom.
    // =========================================

    await topUpEnsureDepositableEther(ctx, 2n * TOP_UP_PER_KEY + ether("32"));
    await topUpEnsureModuleAllocation(ctx, moduleId, 2n * TOP_UP_PER_KEY);
  });

  after(async () => await Snapshot.restore(globalSnapshot));

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(testSnapshot));

  const targetKeys = () => ({
    keyIndices: target.keyIndices,
    operatorIds: target.keyIndices.map(() => target.operatorId),
  });

  const singleKey = (position: number) => ({
    keyIndices: [target.keyIndices[position]],
    operatorIds: [target.operatorId],
  });

  context("Full top-up flow", () => {
    it("Should top up real CMv2 validators end to end with exact amounts", async () => {
      const { topUpGateway, lido, stakingRouter } = ctx.contracts;

      const expectedPerKey = await expectedTopUpLimitWei(ctx, ebForTopUpGwei);
      expect(expectedPerKey).to.equal(TOP_UP_PER_KEY);
      const expectedTotal = 2n * expectedPerKey;

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
        { pubkey: target.pubkeys[1], effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      const bufferedBefore = await lido.getBufferedEther();
      const nonceBefore = await stakingRouter.getStakingModuleNonce(moduleId);

      const tx = await topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, targetKeys(), bundle));
      const receipt = await tx.wait();

      // Exact amount reached the router
      const topUpEvents = ctx.getEvents(receipt!, "StakingRouterETHTopUp");
      expect(topUpEvents.length).to.equal(1);
      expect(topUpEvents[0].args.stakingModuleId).to.equal(moduleId);
      expect(topUpEvents[0].args.amount).to.equal(expectedTotal);

      // Real DepositContract top-up deposits, one per key, exact per-key amounts
      const depositEvents = findEventsWithInterfaces(receipt!, "DepositEvent", [depositEventInterface]);
      expect(depositEvents.length).to.equal(2);
      const depositedByPubkey = new Map(
        depositEvents.map((e) => [e.args.pubkey.toLowerCase(), depositEventAmountWei(e.args.amount)]),
      );
      for (const pubkey of target.pubkeys) {
        expect(depositedByPubkey.get(pubkey.toLowerCase())).to.equal(expectedPerKey);
      }

      // All pulled ether is deposited: buffer decreases by exactly the total
      expect(bufferedBefore - (await lido.getBufferedEther())).to.equal(expectedTotal);

      // Module nonce moves (allocateDeposits ran on the real module)
      expect(await stakingRouter.getStakingModuleNonce(moduleId)).to.equal(nonceBefore + 1n);

      // A successful (non-zero) top-up advances the rate-limit window
      const gatewayEvents = ctx.getEvents(receipt!, "LastTopUpChanged");
      expect(gatewayEvents.length).to.equal(1);
      expect(await topUpGateway.isBlockDistancePassed()).to.equal(false);
    });

    it("Should count pending deposits against the top-up limit", async () => {
      const { topUpGateway, lido } = ctx.contracts;

      // Key 0 is fully covered by a pending deposit, key 1 gets a real top-up
      const pendingBalanceGwei = [toGwei(TOP_UP_PER_KEY), 0n];

      const expectedPerKey = await expectedTopUpLimitWei(ctx, ebForTopUpGwei);
      expect(await expectedTopUpLimitWei(ctx, ebForTopUpGwei, pendingBalanceGwei[0])).to.equal(0n);

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
        { pubkey: target.pubkeys[1], effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      const bufferedBefore = await lido.getBufferedEther();

      const tx = await topUpGateway
        .connect(topUpCaller)
        .topUp(buildTopUpData(moduleId, targetKeys(), bundle, { pendingBalanceGwei }));
      const receipt = await tx.wait();

      const topUpEvents = ctx.getEvents(receipt!, "StakingRouterETHTopUp");
      expect(topUpEvents[0].args.amount).to.equal(expectedPerKey);

      // Only the uncovered key receives a deposit
      const depositEvents = findEventsWithInterfaces(receipt!, "DepositEvent", [depositEventInterface]);
      expect(depositEvents.length).to.equal(1);
      expect(depositEvents[0].args.pubkey.toLowerCase()).to.equal(target.pubkeys[1].toLowerCase());
      expect(depositEventAmountWei(depositEvents[0].args.amount)).to.equal(expectedPerKey);

      expect(bufferedBefore - (await lido.getBufferedEther())).to.equal(expectedPerKey);
    });

    it("Should move no ether and keep the rate-limit window when all limits are zero", async () => {
      const { topUpGateway, lido } = ctx.contracts;

      // Balance already at target -> zero limits; the router is still called
      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: targetBalanceGwei },
        { pubkey: target.pubkeys[1], effectiveBalanceGwei: targetBalanceGwei },
      ]);

      const bufferedBefore = await lido.getBufferedEther();

      const tx = await topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, targetKeys(), bundle));
      const receipt = await tx.wait();

      const topUpEvents = ctx.getEvents(receipt!, "StakingRouterETHTopUp");
      expect(topUpEvents.length).to.equal(1);
      expect(topUpEvents[0].args.amount).to.equal(0n);

      expect(findEventsWithInterfaces(receipt!, "DepositEvent", [depositEventInterface]).length).to.equal(0);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);

      // Zero top-up must not advance the rate-limit window
      expect(ctx.getEvents(receipt!, "LastTopUpChanged").length).to.equal(0);
      expect(await topUpGateway.isBlockDistancePassed()).to.equal(true);
    });

    it("Should assign zero limits to slashed and exiting validators", async () => {
      const { topUpGateway, lido } = ctx.contracts;

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei, slashed: true },
        { pubkey: target.pubkeys[1], effectiveBalanceGwei: ebForTopUpGwei, exitEpoch: 50n },
      ]);

      const bufferedBefore = await lido.getBufferedEther();

      const tx = await topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, targetKeys(), bundle));
      const receipt = await tx.wait();

      expect(ctx.getEvents(receipt!, "StakingRouterETHTopUp")[0].args.amount).to.equal(0n);
      expect(findEventsWithInterfaces(receipt!, "DepositEvent", [depositEventInterface]).length).to.equal(0);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(ctx.getEvents(receipt!, "LastTopUpChanged").length).to.equal(0);
    });
  });

  context("Rate limiting", () => {
    it("Should enforce min block distance after a successful top-up and recover after it passes", async () => {
      const { topUpGateway } = ctx.contracts;

      // First top-up: single key, non-zero amount
      const bundle1 = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
      ]);
      await topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, singleKey(0), bundle1));
      expect(await topUpGateway.isBlockDistancePassed()).to.equal(false);

      // Immediate retry with a fresh root: blocked by the distance check
      const bundle2 = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[1], effectiveBalanceGwei: ebForTopUpGwei },
      ]);
      await expect(
        topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, singleKey(1), bundle2)),
      ).to.be.revertedWithCustomError(topUpGateway, "MinBlockDistanceNotMet");

      // After the distance passes the gateway accepts a fresh root again
      await ethers.provider.send("hardhat_mine", ["0x" + minBlockDistance.toString(16)]);
      expect(await topUpGateway.isBlockDistancePassed()).to.equal(true);

      const bundle3 = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[1], effectiveBalanceGwei: ebForTopUpGwei },
      ]);
      const tx = await topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, singleKey(1), bundle3));
      const receipt = await tx.wait();
      expect(ctx.getEvents(receipt!, "StakingRouterETHTopUp")[0].args.amount).to.equal(TOP_UP_PER_KEY);
    });

    it("Should reject a root that precedes the last successful top-up", async () => {
      const { topUpGateway } = ctx.contracts;

      // The stale root is committed BEFORE the successful top-up
      const staleBundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[1], effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
      ]);
      await topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, singleKey(0), bundle));

      // Pass the block distance without letting the root expire
      await ethers.provider.send("hardhat_mine", ["0x" + minBlockDistance.toString(16)]);

      await expect(
        topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, singleKey(1), staleBundle)),
      ).to.be.revertedWithCustomError(topUpGateway, "RootPrecedesLastTopUp");
    });

    it("Should reject a root older than maxRootAge", async () => {
      const { topUpGateway } = ctx.contracts;

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      await ethers.provider.send("evm_increaseTime", [Number(maxRootAge) + 100]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, singleKey(0), bundle)),
      ).to.be.revertedWithCustomError(topUpGateway, "RootIsTooOld");
    });
  });

  context("Key and module validation (real CMv2)", () => {
    it("Should revert for a module with non-0x02 withdrawal credentials", async () => {
      const { topUpGateway } = ctx.contracts;

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      await expect(
        topUpGateway.connect(topUpCaller).topUp(buildTopUpData(ctx.modules.nor!.id, singleKey(0), bundle)),
      ).to.be.revertedWithCustomError(topUpGateway, "WrongWithdrawalCredentials");
    });

    it("Should revert in CMv2 when the pubkey does not match the module key", async () => {
      const { topUpGateway } = ctx.contracts;
      const cmv2Errors = new ethers.Contract(ctx.modules.cmv2!.stakingModuleAddress, CMV2_ERRORS_ABI, ethers.provider);

      // The witness proves a foreign pubkey; the module must reject the mismatch
      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: randomValidatorPubkey(), effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      await expect(
        topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, singleKey(0), bundle)),
      ).to.be.revertedWithCustomError(cmv2Errors, "InvalidSigningKey");
    });

    it("Should revert in CMv2 for a bonded but undeposited target key", async () => {
      const { topUpGateway } = ctx.contracts;
      const cmv2Errors = new ethers.Contract(ctx.modules.cmv2!.stakingModuleAddress, CMV2_ERRORS_ABI, ethers.provider);

      const undeposited = await cmv2CreateOperatorWithKeys(ctx, { name: "topup_undeposited_target", keysCount: 1n });

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: undeposited.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      await expect(
        topUpGateway
          .connect(topUpCaller)
          .topUp(
            buildTopUpData(
              moduleId,
              { keyIndices: [undeposited.keyIndices[0]], operatorIds: [undeposited.operatorId] },
              bundle,
            ),
          ),
      ).to.be.revertedWithCustomError(cmv2Errors, "SigningKeysInvalidOffset");
    });
  });

  context("Gateway limits and access", () => {
    it("Should revert when the batch exceeds maxValidatorsPerTopUp", async () => {
      const { topUpGateway } = ctx.contracts;

      const maxValidators = await topUpGateway.getMaxValidatorsPerTopUp();
      const count = Number(maxValidators) + 1;

      // The size check precedes proof verification, so dummy witnesses are enough
      const indices = Array.from({ length: count }, (_, i) => BigInt(i));
      const dummyWitness = {
        proofValidator: [] as string[],
        pubkey: "0x" + "11".repeat(48),
        effectiveBalance: 0n,
        slashed: false,
        activationEligibilityEpoch: 0n,
        activationEpoch: 0n,
        exitEpoch: 0n,
        withdrawableEpoch: 0n,
      };

      await expect(
        topUpGateway.connect(topUpCaller).topUp({
          moduleId,
          keyIndices: indices,
          operatorIds: indices.map(() => target.operatorId),
          validatorIndices: indices,
          beaconRootData: { childBlockTimestamp: 0, slot: 0, proposerIndex: 0 },
          validatorWitness: indices.map(() => dummyWitness),
          pendingBalanceGwei: indices.map(() => 0n),
        }),
      ).to.be.revertedWithCustomError(topUpGateway, "MaxValidatorsPerTopUpExceeded");
    });

    it("Should revert when the caller lacks TOP_UP_ROLE", async () => {
      const { topUpGateway } = ctx.contracts;
      const [stranger] = await ethers.getSigners();

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      await expect(
        topUpGateway.connect(stranger).topUp(buildTopUpData(moduleId, singleKey(0), bundle)),
      ).to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount");
    });

    it("Should revert while the gateway is paused", async () => {
      const { topUpGateway } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      const bundle = await prepareTopUpWitnesses(ctx, [
        { pubkey: target.pubkeys[0], effectiveBalanceGwei: ebForTopUpGwei },
      ]);

      const PAUSE_ROLE = await topUpGateway.PAUSE_ROLE();
      await topUpGateway.connect(agentSigner).grantRole(PAUSE_ROLE, agentSigner.address);
      await topUpGateway.connect(agentSigner).pauseFor(3600);

      await expect(
        topUpGateway.connect(topUpCaller).topUp(buildTopUpData(moduleId, singleKey(0), bundle)),
      ).to.be.revertedWithCustomError(topUpGateway, "ResumedExpected");
    });
  });
});
