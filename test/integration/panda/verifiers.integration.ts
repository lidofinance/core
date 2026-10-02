import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "chai";
import { ethers, network } from "hardhat";

import { Panda } from "lib/panda";

import { bailOnFailure } from "test/suite";

import { deployScratch } from "./helpers/deploy";
import {
  advancePastExitDeadline,
  advanceToHistoricalSummary,
  advanceUntilConsolidationRequest,
  advanceUntilFinalized,
  advanceUntilValidator,
  AnchoredState,
  anchorHead,
  buildDeposit,
  buildTopUpInput,
  damaged,
  DepositFixture,
  depositValidator,
  exitEligibilityTimestamp,
  ExitRequestBatch,
  getPandaProtocolContext,
  importValidator,
  PandaProtocolContext,
  readFinalizedCheckpoint,
  readValidator,
  recordTransaction,
  submitExitRequests,
} from "./helpers/protocol";
import { initializeSSZ } from "./helpers/ssz";

// SSZ errors are emitted in assembly and are absent from the consuming contracts' ABIs.
const sszErrors = {
  interface: new ethers.Interface([
    "error InvalidProof()",
    "error BranchHasMissingItem()",
    "error BranchHasExtraItem()",
  ]),
};

const describePanda = network.name === "panda" ? describe : describe.skip;

describePanda("Core verifiers on Panda / Gloas", function () {
  this.timeout(20 * 60_000);

  let panda: Panda;
  let ctx: PandaProtocolContext;
  let initial: AnchoredState;
  let active: AnchoredState;
  let validDeposit: DepositFixture;
  let invalidDeposit: DepositFixture;
  let validatorIndex: number;

  before("start one Panda network and scratch-deploy once for the whole suite", async () => {
    await initializeSSZ();
    panda = await Panda.start({ port: Number(process.env.PANDA_PORT || 18547), timeoutMs: 120_000 });
    const deployment = await deployScratch(panda);
    console.log(`    Scratch: ${deployment.steps} steps in ${deployment.elapsedSeconds.toFixed(2)}s`);
    ctx = await getPandaProtocolContext(panda, deployment, await ethers.getSigner(deployment.state.deployer));
    initial = await anchorHead(ctx, "initial");
  });

  after("save evidence and stop only this suite's Panda network", async () => {
    try {
      if (ctx) {
        await writeFile(
          path.join(panda.directory, "verifiers.json"),
          JSON.stringify(
            {
              bake: await panda.status(),
              endpoints: { rpc: panda.url, beacon: panda.beaconUrl },
              deploymentSeconds: ctx.deployment.elapsedSeconds,
              captures: ctx.evidence.captures,
              transactions: ctx.evidence.receipts,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await panda?.close();
    }
  });

  // The groups share one real CL/EL lifecycle; run the complete suite with --bail.
  beforeEach(bailOnFailure);

  describe("PredepositGuarantee: real CL proofs and BLS deposit signatures", () => {
    before("prepare signed deposit fixtures", () => {
      validDeposit = buildDeposit(ctx);
      invalidDeposit = buildDeposit(ctx, { amount: ethers.parseEther("1"), wrongDomain: true });
    });

    it("accepts validators across the Gloas progressive-list subtree boundaries", async () => {
      const { predepositGuarantee } = ctx.contracts;
      for (const index of [0, 1, 4, 5, 20, 21, 63]) {
        const witness = initial.witness(index).pubkey;
        const credentials = initial.state.validators[index].withdrawal_credentials;
        await expect(predepositGuarantee.validatePubKeyWCProof(witness, credentials)).not.to.be.reverted;
      }
    });

    it("rejects a changed pubkey, credentials, index, slot, proposer and Merkle branch", async () => {
      const { predepositGuarantee } = ctx.contracts;
      const witness = initial.witness(21).pubkey;
      const credentials = initial.state.validators[21].withdrawal_credentials;
      for (const changed of [
        { ...witness, pubkey: initial.state.validators[1].pubkey },
        { ...witness, validatorIndex: 22 },
        { ...witness, proof: [damaged(witness.proof[0]), ...witness.proof.slice(1)] },
      ]) {
        await expect(predepositGuarantee.validatePubKeyWCProof(changed, credentials)).to.be.revertedWithCustomError(
          sszErrors,
          "InvalidProof",
        );
      }
      await expect(
        predepositGuarantee.validatePubKeyWCProof(witness, damaged(credentials)),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
      await expect(
        predepositGuarantee.validatePubKeyWCProof({ ...witness, proof: witness.proof.slice(1) }, credentials),
      ).to.be.revertedWithCustomError(sszErrors, "BranchHasMissingItem");
      await expect(
        predepositGuarantee.validatePubKeyWCProof(
          { ...witness, proof: [witness.proof[0], ...witness.proof] },
          credentials,
        ),
      ).to.be.revertedWithCustomError(sszErrors, "BranchHasExtraItem");
      for (const field of ["slot", "proposerIndex"] as const) {
        await expect(
          predepositGuarantee.validatePubKeyWCProof({ ...witness, [field]: BigInt(witness[field]) + 1n }, credentials),
        ).to.be.revertedWithCustomError(predepositGuarantee, "InvalidSlot");
      }
    });

    it("reads the real EIP-4788 timestamp, rejecting an absent or unrelated anchor", async () => {
      const { predepositGuarantee } = ctx.contracts;
      const witness = initial.witness(0).pubkey;
      const credentials = initial.state.validators[0].withdrawal_credentials;
      await expect(
        predepositGuarantee.validatePubKeyWCProof(
          { ...witness, childBlockTimestamp: initial.timestamp + 1 },
          credentials,
        ),
      ).to.be.revertedWithCustomError(predepositGuarantee, "RootNotFound");
      await expect(
        predepositGuarantee.validatePubKeyWCProof(
          { ...witness, childBlockTimestamp: initial.timestamp - 12 },
          credentials,
        ),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("uses Geth's BLS precompiles to accept the correct deposit domain and reject a wrong one", async () => {
      const { predepositGuarantee } = ctx.contracts;
      await expect(
        predepositGuarantee.verifyDepositMessage(
          validDeposit.deposit,
          validDeposit.y,
          validDeposit.withdrawalCredentials,
        ),
      ).not.to.be.reverted;
      await expect(
        predepositGuarantee.verifyDepositMessage(
          invalidDeposit.deposit,
          invalidDeposit.y,
          invalidDeposit.withdrawalCredentials,
        ),
      ).to.be.revertedWithCustomError(predepositGuarantee, "InvalidSignature");
    });

    it("observes that EL accepts both deposit transactions but CL registers only the valid signature", async () => {
      const { predepositGuarantee } = ctx.contracts;
      await importValidator(ctx, validDeposit);
      await depositValidator(ctx, validDeposit);
      const invalidReceipt = await depositValidator(ctx, invalidDeposit);
      const validator = await advanceUntilValidator(ctx, validDeposit.pubkey);
      validatorIndex = Number(validator.index);
      await advanceUntilFinalized(ctx, invalidReceipt.blockNumber);
      const deposited = await anchorHead(ctx, "deposited");
      expect(deposited.state.validators.some((v) => v.pubkey === invalidDeposit.pubkey)).to.equal(false);
      expect(deposited.state.pending_deposits.some((v) => v.pubkey === invalidDeposit.pubkey)).to.equal(false);
      await expect(
        predepositGuarantee.validatePubKeyWCProof(
          deposited.witness(validatorIndex).pubkey,
          validDeposit.withdrawalCredentials,
        ),
      ).not.to.be.reverted;
    });
  });

  describe("TopUpGateway: full validator witness from CL", () => {
    before("wait for real activation and capture the active validator", async () => {
      await advanceUntilValidator(ctx, validDeposit.pubkey, { active: true });
      active = await anchorHead(ctx, "active-validator");
    });

    it("rejects forged balance, lifecycle epochs and slashing status", async () => {
      const { topUpGateway } = ctx.contracts;
      const input = buildTopUpInput(active, validatorIndex, ctx.modules.compounding);
      for (const field of [
        "effectiveBalance",
        "activationEligibilityEpoch",
        "exitEpoch",
        "withdrawableEpoch",
      ] as const) {
        const validator = { ...input.validatorWitness[0], [field]: BigInt(input.validatorWitness[0][field]) ^ 1n };
        await expect(topUpGateway.topUp({ ...input, validatorWitness: [validator] })).to.be.revertedWithCustomError(
          sszErrors,
          "InvalidProof",
        );
      }
      const validator = { ...input.validatorWitness[0], slashed: true };
      await expect(topUpGateway.topUp({ ...input, validatorWitness: [validator] })).to.be.revertedWithCustomError(
        sszErrors,
        "InvalidProof",
      );
      const earlierActivation = {
        ...input.validatorWitness[0],
        activationEpoch: BigInt(input.validatorWitness[0].activationEpoch) - 1n,
      };
      await expect(
        topUpGateway.topUp({ ...input, validatorWitness: [earlierActivation] }),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("accepts the genuine proof through StakingRouter with zero available allocation", async () => {
      const { topUpGateway, lido, depositContract, stakingRouter } = ctx.contracts;
      // This covers verification and routing; it does not claim a funded top-up was performed.
      // Scratch seeds Lido with 10 wei; the router rounds deposit allocation down to whole gwei.
      expect(await lido.getDepositableEther()).to.be.lessThan(ethers.parseUnits("1", "gwei"));
      const depositCount = await depositContract.get_deposit_count();
      const receipt = await recordTransaction(
        ctx,
        topUpGateway.topUp(buildTopUpInput(active, validatorIndex, ctx.modules.compounding)),
      );
      const event = receipt.logs
        .filter((log) => log.address.toLowerCase() === String(stakingRouter.target).toLowerCase())
        .map((log) => stakingRouter.interface.parseLog(log))
        .find((log) => log?.name === "StakingRouterETHTopUp");
      expect(event, "real StakingRouter top-up event").not.to.equal(undefined);
      expect(event!.args.amount).to.equal(0n);
      expect(await depositContract.get_deposit_count()).to.equal(depositCount);
    });

    it("enforces the block interval and rejects the old root once that interval passes", async () => {
      const { topUpGateway } = ctx.contracts;
      await expect(
        topUpGateway.topUp(buildTopUpInput(active, validatorIndex, ctx.modules.compounding)),
      ).to.be.revertedWithCustomError(topUpGateway, "MinBlockDistanceNotMet");
      // With scratch defaults, 75 real 12-second blocks outlive the 300-second root window.
      await panda.advanceSlots(Number(await topUpGateway.getMinBlockDistance()));
      expect(await topUpGateway.isBlockDistancePassed()).to.equal(true);
      await expect(
        topUpGateway.topUp(buildTopUpInput(active, validatorIndex, ctx.modules.compounding)),
      ).to.be.revertedWithCustomError(topUpGateway, "RootIsTooOld");
    });
  });

  describe("ConsolidationGateway: target proof and the EL-to-CL request", () => {
    let targetState: AnchoredState;
    before(async () => {
      targetState = await anchorHead(ctx, "consolidation-target");
    });

    it("rejects a target whose CL withdrawal credentials do not belong to the Lido vault", async () => {
      const { withdrawalVault, consolidationGateway } = ctx.contracts;
      const foreignTarget = targetState.witness(0).pubkey;
      const groups = [{ targetWitness: foreignTarget, sourcePubkeys: [validDeposit.pubkey] }];
      const fee = await withdrawalVault.getConsolidationRequestFee();
      await expect(
        consolidationGateway.addConsolidationRequests(groups, ctx.signer.address, { value: fee }),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("accepts a valid target proof and delivers the request to CL without scheduling a foreign source exit", async () => {
      const { withdrawalVault, consolidationGateway } = ctx.contracts;
      const source = targetState.state.validators[0].pubkey;
      const groups = [{ targetWitness: targetState.witness(validatorIndex).pubkey, sourcePubkeys: [source] }];
      const fee = await withdrawalVault.getConsolidationRequestFee();
      await recordTransaction(
        ctx,
        consolidationGateway.addConsolidationRequests(groups, ctx.signer.address, {
          value: fee,
        }),
      );
      await advanceUntilConsolidationRequest(ctx, source, validDeposit.pubkey);
      const validator = await readValidator(ctx, 0);
      expect(validator.validator.exit_epoch).to.equal((2n ** 64n - 1n).toString());
    });
  });

  describe("ValidatorExitDelayVerifier: recent and historical CL evidence", () => {
    let requests: ExitRequestBatch;
    let eligible: AnchoredState;

    before("deliver real VEB requests and advance to their unchanged eligibility deadline", async () => {
      requests = await submitExitRequests(ctx, initial, [0, 1], ctx.modules.curated);
      await advancePastExitDeadline(ctx, requests);
      eligible = await anchorHead(ctx, "exit-eligible");
    });

    it("rejects a forged block header and a corrupted validator proof", async () => {
      const { validatorExitDelayVerifier } = ctx.contracts;
      const witness = eligible.witness(0).exit;
      const forged = {
        ...eligible.beacon,
        header: { ...eligible.beacon.header, stateRoot: damaged(eligible.header.state_root) },
      };
      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(forged, [witness], requests),
      ).to.be.revertedWithCustomError(validatorExitDelayVerifier, "InvalidBlockHeader");
      const corrupted = {
        ...witness,
        validatorProof: [damaged(witness.validatorProof[0]), ...witness.validatorProof.slice(1)],
      };
      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(eligible.beacon, [corrupted], requests),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("reports a proven recent exit delay through StakingRouter into the real registry", async () => {
      const { validatorExitDelayVerifier, nor } = ctx.contracts;
      const validator = eligible.state.validators[0];
      const proofTimestamp = BigInt(ctx.genesis.genesis_time) + BigInt(eligible.header.slot) * 12n;
      const committeePeriod = await validatorExitDelayVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS();
      const delay = proofTimestamp - exitEligibilityTimestamp(ctx, requests, validator, committeePeriod);
      expect(await nor.isValidatorExitingKeyReported(validator.pubkey)).to.equal(false);

      const tx = validatorExitDelayVerifier.verifyValidatorExitDelay(
        eligible.beacon,
        [eligible.witness(0).exit],
        requests,
      );
      await recordTransaction(ctx, tx);
      await expect(tx)
        .to.emit(nor, "ValidatorExitStatusUpdated")
        .withArgs(requests.module.operatorId, validator.pubkey, delay, proofTimestamp);
      expect(await nor.isValidatorExitingKeyReported(validator.pubkey)).to.equal(true);
    });

    it("proves an older block through the historical summary actually created by CL", async () => {
      const { validatorExitDelayVerifier, nor } = ctx.contracts;
      const history = await advanceToHistoricalSummary(ctx, eligible);
      const witness = { ...eligible.witness(1).exit, exitRequestIndex: 1 };
      const broken = { ...history.old, proof: [damaged(history.old.proof[0]), ...history.old.proof.slice(1)] };
      await expect(
        validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
          history.recent.beacon,
          broken,
          [witness],
          requests,
        ),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
      const validator = eligible.state.validators[1];
      const proofTimestamp = BigInt(ctx.genesis.genesis_time) + BigInt(eligible.header.slot) * 12n;
      const committeePeriod = await validatorExitDelayVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS();
      const delay = proofTimestamp - exitEligibilityTimestamp(ctx, requests, validator, committeePeriod);
      expect(await nor.isValidatorExitingKeyReported(validator.pubkey)).to.equal(false);

      const tx = validatorExitDelayVerifier.verifyHistoricalValidatorExitDelay(
        history.recent.beacon,
        history.old,
        [witness],
        requests,
      );
      await recordTransaction(ctx, tx);
      await expect(tx)
        .to.emit(nor, "ValidatorExitStatusUpdated")
        .withArgs(requests.module.operatorId, validator.pubkey, delay, proofTimestamp);
      expect(await nor.isValidatorExitingKeyReported(validator.pubkey)).to.equal(true);
    });

    it("rejects an exit-delay proof after CL accepts a real signed voluntary exit", async () => {
      const { validatorExitDelayVerifier } = ctx.contracts;
      const exitRequest = await submitExitRequests(ctx, active, [validatorIndex], ctx.modules.curated);
      await panda.exitValidator(validDeposit.pubkey);
      await panda.advanceSlots(2);
      const exiting = await anchorHead(ctx, "scheduled-exit");
      expect(exiting.state.validators[validatorIndex].exit_epoch).not.to.equal((2n ** 64n - 1n).toString());
      await expect(
        validatorExitDelayVerifier.verifyValidatorExitDelay(
          exiting.beacon,
          [exiting.witness(validatorIndex).exit],
          exitRequest,
        ),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("resumes real finality and accepts a fresh proof after the time jumps", async () => {
      const { predepositGuarantee } = ctx.contracts;
      const before = await readFinalizedCheckpoint(ctx);
      await panda.advanceSlots(96);
      const after = await readFinalizedCheckpoint(ctx);
      expect(BigInt(after.epoch)).to.be.greaterThan(BigInt(before.epoch));
      expect(BigInt(after.executionNumber)).to.be.greaterThan(BigInt(before.executionNumber));
      const resumed = await anchorHead(ctx, "resumed-finality");
      expect(resumed.state.validators.every((validator) => !validator.slashed)).to.equal(true);
      await expect(
        predepositGuarantee.validatePubKeyWCProof(
          resumed.witness(validatorIndex).pubkey,
          validDeposit.withdrawalCredentials,
        ),
      ).not.to.be.reverted;
    });
  });
});
