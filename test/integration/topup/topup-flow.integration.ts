import { expect } from "chai";
import { Contract, Wallet } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mine } from "@nomicfoundation/hardhat-network-helpers";

import { DSMAttestMessage, ether, findEventsWithInterfaces } from "lib";
import { StakingModuleStatus } from "lib/constants";
import { randomValidatorPubkey } from "lib/pdg";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  cmv2CreateOperatorWithKeys,
  cmv2EnsureDepositedOperatorKeys,
  cmv2HasTopUpAllocationPause,
  CMv2OperatorKeys,
  cmv2SuiteEnabled,
  depositEventAmountWei,
  depositEventInterface,
  getCMv2ModuleId,
  getTopUpDepositorSigner,
  topUpEnsureDepositableEther,
  topUpEnsureDistancePassed,
  topUpEnsureModuleAllocation,
} from "lib/protocol/helpers";
import { setSingleGuardian } from "lib/protocol/helpers/dsm";
import { deployDelegationContract } from "lib/protocol/helpers/edf";
import { getStakingModuleManagerSigner, prepareStakingModuleForTestDeposit } from "lib/protocol/helpers/staking";

import { Snapshot } from "test/suite";

/** Minimal interface to match custom errors of the external CMv2 module. */
const CMV2_ERRORS_ABI = [
  "error InvalidSigningKey()",
  "error SigningKeysInvalidOffset()",
  "error DepositInfoIsNotUpToDate()",
];

const DEPOSIT_CONTRACT_ABI = ["function get_deposit_root() view returns (bytes32)"];

/** Maximum ETH a key can receive above its seed deposit (2048 - 32 ETH). */
const MAX_EXTRA_BALANCE = ether("2016");

/**
 * Integration test for the full top-up flow over the real production topology:
 * DepositSecurityModule.topUpBufferedEther -> StakingRouter.topUp -> CMv2.allocateDeposits ->
 * Lido.withdrawDepositableEther -> DepositContract top-up deposits.
 *
 * Target keys are real deposited CMv2 (curated-onchain-v2) validators of a fresh operator,
 * so the expected top-up amounts are exact constants.
 *
 * The suite requires a CMv2 module in the StakingRouter. When CMv2 is unavailable the
 * suite fails loudly; skipping is allowed only via the explicit
 * INTEGRATION_WITH_CMv2=off opt-out.
 */
describe("Integration: TopUp Flow (DSM -> StakingRouter -> Real CMv2)", () => {
  let ctx: ProtocolContext;

  let topUpDepositor: HardhatEthersSigner;

  let moduleId: bigint;
  let target: CMv2OperatorKeys;

  const TOP_UP_PER_KEY = ether("50");

  let globalSnapshot: string;
  let testSnapshot: string;

  before(async function () {
    ctx = await getProtocolContext();

    globalSnapshot = await Snapshot.take();

    if (!cmv2SuiteEnabled(ctx, "the top-up flow suite")) {
      return this.skip();
    }

    const { stakingRouter } = ctx.contracts;

    moduleId = getCMv2ModuleId(ctx);
    const moduleWC = await stakingRouter.getStakingModuleWithdrawalCredentials(moduleId);
    expect(moduleWC.slice(0, 4)).to.equal("0x02", "CMv2 withdrawal credentials must be of type 0x02");

    topUpDepositor = await getTopUpDepositorSigner(ctx);

    // A fresh operator gets 100% of the allocation weight, so the amounts are exact regardless of the fork state
    target = await cmv2EnsureDepositedOperatorKeys(ctx, 2n, { name: "topup_target_operator", forceCreate: true });

    // The router quantizes allocations in maxEBType1 (32 ETH) validator-equivalents,
    // so the depositable buffer needs one extra quantum of headroom
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
    pubkeys: target.pubkeys,
  });

  const singleKey = (position: number) => ({
    keyIndices: [target.keyIndices[position]],
    operatorIds: [target.operatorId],
    pubkeys: [target.pubkeys[position]],
  });

  type Keys = ReturnType<typeof targetKeys>;

  const callTopUp = (keys: Keys, limits: bigint[], caller = topUpDepositor, id = moduleId) =>
    ctx.contracts.depositSecurityModule
      .connect(caller)
      .topUpBufferedEther(id, keys.keyIndices, keys.operatorIds, keys.pubkeys, limits);

  const topUp = async (keys: Keys, limits: bigint[], caller = topUpDepositor) => {
    await topUpEnsureDistancePassed(ctx, moduleId);
    return await callTopUp(keys, limits, caller);
  };

  const setUpGuardian = async () => {
    const [delegationOwner, delegate] = await ethers.getSigners();
    const guardian = await deployDelegationContract(delegationOwner, delegate.address);
    await setSingleGuardian(ctx, guardian.address);
    return { guardian: guardian.contract.connect(delegate) as Contract, guardianAddress: guardian.address };
  };

  context("Full top-up flow", () => {
    it("Should top up real CMv2 validators end to end with exact amounts", async () => {
      const { depositSecurityModule: dsm, lido, stakingRouter } = ctx.contracts;
      const expectedTotal = 2n * TOP_UP_PER_KEY;

      const bufferedBefore = await lido.getBufferedEther();
      const nonceBefore = await stakingRouter.getStakingModuleNonce(moduleId);

      const tx = await topUp(targetKeys(), [TOP_UP_PER_KEY, TOP_UP_PER_KEY]);
      const receipt = await tx.wait();

      // Exact amount reached the router; a top-up is not reported as a seed deposit
      const topUpEvents = ctx.getEvents(receipt!, "StakingRouterETHTopUp");
      expect(topUpEvents.length).to.equal(1);
      expect(topUpEvents[0].args.stakingModuleId).to.equal(moduleId);
      expect(topUpEvents[0].args.amount).to.equal(expectedTotal);
      expect(ctx.getEvents(receipt!, "StakingRouterETHDeposited").length).to.equal(0);

      // Real DepositContract top-up deposits, one per key, exact per-key amounts
      const depositEvents = findEventsWithInterfaces(receipt!, "DepositEvent", [depositEventInterface]);
      expect(depositEvents.length).to.equal(2);
      const depositedByPubkey = new Map(
        depositEvents.map((e) => [e.args.pubkey.toLowerCase(), depositEventAmountWei(e.args.amount)]),
      );
      for (const pubkey of target.pubkeys) {
        expect(depositedByPubkey.get(pubkey.toLowerCase())).to.equal(TOP_UP_PER_KEY);
      }

      // All pulled ether is deposited: buffer decreases by exactly the total
      expect(bufferedBefore - (await lido.getBufferedEther())).to.equal(expectedTotal);

      // Module nonce: CMv2 bumped it on a top-up allocation until staking-modules#910 removed the bump
      const expectedNonce = (await cmv2HasTopUpAllocationPause(ctx)) ? nonceBefore : nonceBefore + 1n;
      expect(await stakingRouter.getStakingModuleNonce(moduleId)).to.equal(expectedNonce);

      // Both last deposit blocks move to the top-up block
      expect(await dsm.getLastDepositBlock()).to.equal(receipt!.blockNumber);
      expect(await stakingRouter.getStakingModuleLastDepositBlock(moduleId)).to.equal(receipt!.blockNumber);
    });

    it("Should move no ether but reset the deposit distance when all limits are zero", async () => {
      const { depositSecurityModule: dsm, lido, stakingRouter } = ctx.contracts;

      const bufferedBefore = await lido.getBufferedEther();

      const tx = await topUp(targetKeys(), [0n, 0n]);
      const receipt = await tx.wait();

      const topUpEvents = ctx.getEvents(receipt!, "StakingRouterETHTopUp");
      expect(topUpEvents.length).to.equal(1);
      expect(topUpEvents[0].args.amount).to.equal(0n);

      expect(findEventsWithInterfaces(receipt!, "DepositEvent", [depositEventInterface]).length).to.equal(0);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);

      expect(await dsm.getLastDepositBlock()).to.equal(receipt!.blockNumber);
      expect(await stakingRouter.getStakingModuleLastDepositBlock(moduleId)).to.equal(receipt!.blockNumber);
      expect(await dsm.isMinDepositDistancePassed(moduleId)).to.equal(false);
    });

    it("Should cap a top-up call at maxDepositsPerBlock seed deposits of the module", async () => {
      const { stakingRouter } = ctx.contracts;

      // Two seed deposits per block: one top-up call moves at most 2 * 32 ETH, whatever the limits ask
      const module = await stakingRouter.getStakingModule(moduleId);
      const manager = await getStakingModuleManagerSigner(ctx);
      await stakingRouter
        .connect(manager)
        .updateStakingModule(
          moduleId,
          module.stakeShareLimit,
          module.priorityExitShareThreshold,
          module.stakingModuleFee,
          module.treasuryFee,
          2n,
          module.minDepositBlockDistance,
        );

      const receipt = (await (await topUp(targetKeys(), [TOP_UP_PER_KEY, TOP_UP_PER_KEY])).wait())!;
      expect(ctx.getEvents(receipt, "StakingRouterETHTopUp")[0].args.amount).to.equal(ether("64"));
    });

    it("Should never add more than 2016 ETH to a key above its seed deposit", async () => {
      const { stakingRouter } = ctx.contracts;

      await topUpEnsureDepositableEther(ctx, MAX_EXTRA_BALANCE + ether("32"));
      await topUpEnsureModuleAllocation(ctx, moduleId, MAX_EXTRA_BALANCE);

      // Ask for more than the cap in every call until the module returns zero
      const limit = MAX_EXTRA_BALANCE + ether("100");
      const perCallCap = ether("32") * (await stakingRouter.getStakingModuleMaxDepositsPerBlock(moduleId));
      const maxCalls = Number(MAX_EXTRA_BALANCE / perCallCap) + 2;

      let total = 0n;
      for (let call = 0; call < maxCalls; call++) {
        const receipt = await (await topUp(singleKey(0), [limit])).wait();
        const amount = ctx.getEvents(receipt!, "StakingRouterETHTopUp")[0].args.amount as bigint;
        if (amount === 0n) break;
        total += amount;
      }

      expect(total).to.equal(MAX_EXTRA_BALANCE);
    });
  });

  context("Deposit distance", () => {
    it("Should block a top-up until the module distance passes after the previous top-up", async () => {
      const { depositSecurityModule: dsm, stakingRouter } = ctx.contracts;

      await topUp(singleKey(0), [TOP_UP_PER_KEY]);

      await expect(callTopUp(singleKey(1), [TOP_UP_PER_KEY])).to.be.revertedWithCustomError(dsm, "DepositTooFrequent");

      await mine(await stakingRouter.getStakingModuleMinDepositBlockDistance(moduleId));

      const receipt = await (await callTopUp(singleKey(1), [TOP_UP_PER_KEY])).wait();
      expect(ctx.getEvents(receipt!, "StakingRouterETHTopUp")[0].args.amount).to.equal(TOP_UP_PER_KEY);
    });

    it("Should block a top-up after a guardian-signed seed deposit to another module until the distance passes", async () => {
      const { depositSecurityModule: dsm, stakingRouter } = ctx.contracts;
      const norId = ctx.modules.nor!.id;

      // One guardian with a known delegate key and quorum 1 signs the seed deposit
      const [delegationOwner] = await ethers.getSigners();
      const delegate = Wallet.createRandom();
      const guardian = await deployDelegationContract(delegationOwner, delegate.address);
      await setSingleGuardian(ctx, guardian.address);
      DSMAttestMessage.setMessagePrefix(await dsm.ATTEST_MESSAGE_PREFIX());

      // Seed one NOR key through the DSM. The helper pauses the other modules for a deterministic seed.
      await topUpEnsureDepositableEther(ctx, ether("32") + TOP_UP_PER_KEY + ether("32"));
      await prepareStakingModuleForTestDeposit(ctx, norId, 1n);
      await topUpEnsureDistancePassed(ctx, norId);

      const block = await ethers.provider.getBlock("latest");
      const depositContract = new ethers.Contract(await dsm.DEPOSIT_CONTRACT(), DEPOSIT_CONTRACT_ABI, ethers.provider);
      const signingArgs = [
        block!.number,
        block!.hash!,
        await depositContract.get_deposit_root(),
        norId,
        await stakingRouter.getStakingModuleNonce(norId),
      ] as const;
      const signature = new DSMAttestMessage(guardian.address, ...signingArgs).sign(delegate.privateKey);
      const seedReceipt = (await (await dsm.depositBufferedEther(...signingArgs, [signature])).wait())!;
      expect(await dsm.getLastDepositBlock()).to.equal(seedReceipt.blockNumber);

      // Bring CMv2 back; the DSM window counts the seed to any module, so the DSM rejects the top-up
      // before it reaches the router
      if ((await stakingRouter.getStakingModuleStatus(moduleId)) !== BigInt(StakingModuleStatus.Active)) {
        const manager = await getStakingModuleManagerSigner(ctx);
        await stakingRouter.connect(manager).setStakingModuleStatus(moduleId, StakingModuleStatus.Active);
      }
      expect(await dsm.isMinDepositDistancePassed(moduleId)).to.equal(false);
      await expect(callTopUp(singleKey(0), [TOP_UP_PER_KEY])).to.be.revertedWithCustomError(dsm, "DepositTooFrequent");

      // A successful top-up after the distance is covered by the top-up after top-up case above
      await mine(await stakingRouter.getStakingModuleMinDepositBlockDistance(moduleId));
      expect(await dsm.isMinDepositDistancePassed(moduleId)).to.equal(true);
    });

    it("Should make a seed deposit to another module wait for its distance after a top-up", async () => {
      const { depositSecurityModule: dsm, stakingRouter } = ctx.contracts;
      const norId = ctx.modules.nor!.id;
      const depositContract = new ethers.Contract(await dsm.DEPOSIT_CONTRACT(), DEPOSIT_CONTRACT_ABI, ethers.provider);

      // One guardian and quorum 1: the distance check precedes the signature check
      const { guardianAddress } = await setUpGuardian();
      await topUpEnsureDistancePassed(ctx, norId);
      expect(await dsm.isMinDepositDistancePassed(norId)).to.equal(true);

      await topUp(singleKey(0), [TOP_UP_PER_KEY]);
      expect(await dsm.isMinDepositDistancePassed(norId)).to.equal(false);

      const block = await ethers.provider.getBlock("latest");
      await expect(
        dsm.depositBufferedEther(
          block!.number,
          block!.hash!,
          await depositContract.get_deposit_root(),
          norId,
          await stakingRouter.getStakingModuleNonce(norId),
          [{ guardian: guardianAddress, signature: "0x" }],
        ),
      ).to.be.revertedWithCustomError(dsm, "DepositTooFrequent");

      await mine(await stakingRouter.getStakingModuleMinDepositBlockDistance(norId));
      expect(await dsm.isMinDepositDistancePassed(norId)).to.equal(true);
    });
  });

  context("Access and pause", () => {
    it("Should revert when the caller is not the DSM top-up depositor", async () => {
      const { depositSecurityModule: dsm } = ctx.contracts;
      const [stranger] = await ethers.getSigners();

      await expect(topUp(singleKey(0), [TOP_UP_PER_KEY], stranger))
        .to.be.revertedWithCustomError(dsm, "NotATopUpDepositor")
        .withArgs(stranger.address);
    });

    it("Should revert when a direct StakingRouter call does not come from the DSM", async () => {
      const { stakingRouter } = ctx.contracts;
      const keys = singleKey(0);

      await expect(
        stakingRouter
          .connect(topUpDepositor)
          .topUp(moduleId, keys.keyIndices, keys.operatorIds, keys.pubkeys, [TOP_UP_PER_KEY]),
      ).to.be.revertedWithCustomError(stakingRouter, "NotAuthorized");
    });

    it("Should revert while a guardian keeps the DSM paused", async () => {
      const { depositSecurityModule: dsm } = ctx.contracts;
      const { guardian } = await setUpGuardian();

      const pauseData = dsm.interface.encodeFunctionData("pauseDeposits", [
        await ethers.provider.getBlockNumber(),
        { guardian: ethers.ZeroAddress, signature: "0x" },
      ]);
      await guardian.execute(await dsm.getAddress(), pauseData);
      expect(await dsm.isDepositsPaused()).to.equal(true);

      await expect(topUp(singleKey(0), [TOP_UP_PER_KEY])).to.be.revertedWithCustomError(dsm, "DepositsArePaused");
    });
  });

  context("Key and module validation (real CMv2)", () => {
    it("Should revert for a module with non-0x02 withdrawal credentials", async () => {
      const { stakingRouter } = ctx.contracts;
      const norId = ctx.modules.nor!.id;

      // Deposit helpers pause other modules; the router checks the status before the credentials type
      if ((await stakingRouter.getStakingModuleStatus(norId)) !== BigInt(StakingModuleStatus.Active)) {
        const manager = await getStakingModuleManagerSigner(ctx);
        await stakingRouter.connect(manager).setStakingModuleStatus(norId, StakingModuleStatus.Active);
      }
      await topUpEnsureDistancePassed(ctx, norId);

      await expect(callTopUp(singleKey(0), [TOP_UP_PER_KEY], topUpDepositor, norId)).to.be.revertedWithCustomError(
        stakingRouter,
        "WrongWithdrawalCredentialsType",
      );
    });

    it("Should revert in CMv2 when the pubkey does not match the module key", async () => {
      const cmv2Errors = new ethers.Contract(ctx.modules.cmv2!.stakingModuleAddress, CMV2_ERRORS_ABI, ethers.provider);

      const keys = { ...singleKey(0), pubkeys: [randomValidatorPubkey()] };

      await expect(topUp(keys, [TOP_UP_PER_KEY])).to.be.revertedWithCustomError(cmv2Errors, "InvalidSigningKey");
    });

    it("Should revert in CMv2 for a bonded but undeposited key", async () => {
      const cmv2Errors = new ethers.Contract(ctx.modules.cmv2!.stakingModuleAddress, CMV2_ERRORS_ABI, ethers.provider);

      const undeposited = await cmv2CreateOperatorWithKeys(ctx, { name: "topup_undeposited_target", keysCount: 1n });
      const keys = {
        keyIndices: [undeposited.keyIndices[0]],
        operatorIds: [undeposited.operatorId],
        pubkeys: [undeposited.pubkeys[0]],
      };

      await expect(topUp(keys, [TOP_UP_PER_KEY])).to.be.revertedWithCustomError(cmv2Errors, "SigningKeysInvalidOffset");
    });
  });
});
