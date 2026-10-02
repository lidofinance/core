import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "chai";
import { ethers, network } from "hardhat";

import { Panda } from "lib/panda";

import { deployScratch } from "./helpers/deploy";
import { damaged, Protocol } from "./helpers/protocol";
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
  let protocol: Protocol;
  let initial: Awaited<ReturnType<Protocol["capture"]>>;
  let active: Awaited<ReturnType<Protocol["capture"]>>;
  let validDeposit: ReturnType<Protocol["makeDeposit"]>;
  let invalidDeposit: ReturnType<Protocol["makeDeposit"]>;
  let validatorIndex: number;

  before("start one Panda network and scratch-deploy once for the whole suite", async () => {
    await initializeSSZ();
    panda = await Panda.start({ port: Number(process.env.PANDA_PORT || 18547), timeoutMs: 120_000 });
    const deployment = await deployScratch(panda);
    console.log(`    Scratch: ${deployment.steps} steps in ${deployment.elapsedSeconds.toFixed(2)}s`);
    protocol = new Protocol(panda, deployment, await ethers.getSigner(deployment.state.deployer));
    await protocol.initialize();
    await protocol.authorizeVerifierCalls();
    initial = await protocol.capture("initial");
  });

  after("save evidence and stop only this suite's Panda network", async () => {
    try {
      if (protocol) {
        await writeFile(
          path.join(panda.directory, "verifiers.json"),
          JSON.stringify(
            {
              bake: await panda.status(),
              endpoints: { rpc: panda.url, beacon: panda.beaconUrl },
              deploymentSeconds: protocol.deployment.elapsedSeconds,
              captures: protocol.captures,
              transactions: protocol.receipts,
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

  describe("PredepositGuarantee: real CL proofs and BLS deposit signatures", () => {
    it("accepts validators across the Gloas progressive-list subtree boundaries", async () => {
      for (const index of [0, 1, 4, 5, 20, 21, 63]) {
        const witness = initial.witness(index).pubkey;
        const credentials = initial.state.validators[index].withdrawal_credentials;
        await expect(protocol.pdg.validatePubKeyWCProof(witness, credentials)).not.to.be.reverted;
      }
    });

    it("rejects a changed pubkey, credentials, index, slot, proposer and Merkle branch", async () => {
      const witness = initial.witness(21).pubkey;
      const credentials = initial.state.validators[21].withdrawal_credentials;
      for (const changed of [
        { ...witness, pubkey: initial.state.validators[1].pubkey },
        { ...witness, validatorIndex: 22 },
        { ...witness, proof: [damaged(witness.proof[0]), ...witness.proof.slice(1)] },
      ]) {
        await expect(protocol.pdg.validatePubKeyWCProof(changed, credentials)).to.be.revertedWithCustomError(
          sszErrors,
          "InvalidProof",
        );
      }
      await expect(protocol.pdg.validatePubKeyWCProof(witness, damaged(credentials))).to.be.revertedWithCustomError(
        sszErrors,
        "InvalidProof",
      );
      await expect(
        protocol.pdg.validatePubKeyWCProof({ ...witness, proof: witness.proof.slice(1) }, credentials),
      ).to.be.revertedWithCustomError(sszErrors, "BranchHasMissingItem");
      await expect(
        protocol.pdg.validatePubKeyWCProof({ ...witness, proof: [witness.proof[0], ...witness.proof] }, credentials),
      ).to.be.revertedWithCustomError(sszErrors, "BranchHasExtraItem");
      for (const field of ["slot", "proposerIndex"] as const) {
        await expect(
          protocol.pdg.validatePubKeyWCProof({ ...witness, [field]: BigInt(witness[field]) + 1n }, credentials),
        ).to.be.revertedWithCustomError(protocol.pdg, "InvalidSlot");
      }
    });

    it("reads the real EIP-4788 timestamp, rejecting an absent or unrelated anchor", async () => {
      const witness = initial.witness(0).pubkey;
      const credentials = initial.state.validators[0].withdrawal_credentials;
      await expect(
        protocol.pdg.validatePubKeyWCProof({ ...witness, childBlockTimestamp: initial.timestamp + 1 }, credentials),
      ).to.be.revertedWithCustomError(protocol.pdg, "RootNotFound");
      await expect(
        protocol.pdg.validatePubKeyWCProof({ ...witness, childBlockTimestamp: initial.timestamp - 12 }, credentials),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("uses Geth's BLS precompiles to accept the correct deposit domain and reject a wrong one", async () => {
      validDeposit = protocol.makeDeposit();
      invalidDeposit = protocol.makeDeposit({ amount: ethers.parseEther("1"), wrongDomain: true });
      await expect(protocol.pdg.verifyDepositMessage(validDeposit.deposit, validDeposit.y, validDeposit.wc)).not.to.be
        .reverted;
      await expect(
        protocol.pdg.verifyDepositMessage(invalidDeposit.deposit, invalidDeposit.y, invalidDeposit.wc),
      ).to.be.revertedWithCustomError(protocol.pdg, "InvalidSignature");
    });

    it("observes that EL accepts both deposit transactions but CL registers only the valid signature", async () => {
      await protocol.importValidator(validDeposit);
      await protocol.depositValidator(validDeposit);
      const invalidReceipt = await protocol.depositValidator(invalidDeposit);
      const validator = await protocol.waitForValidator(validDeposit.pubkey);
      validatorIndex = Number(validator.index);
      await protocol.waitForFinalizedBlock(invalidReceipt.blockNumber);
      const deposited = await protocol.capture("deposited");
      expect(deposited.state.validators.some((v) => v.pubkey === invalidDeposit.pubkey)).to.equal(false);
      expect(deposited.state.pending_deposits.some((v) => v.pubkey === invalidDeposit.pubkey)).to.equal(false);
      await expect(protocol.pdg.validatePubKeyWCProof(deposited.witness(validatorIndex).pubkey, validDeposit.wc)).not.to
        .be.reverted;
    });
  });

  describe("TopUpGateway: full validator witness from CL", () => {
    before("wait for real activation and capture the active validator", async () => {
      await protocol.waitForValidator(validDeposit.pubkey, { active: true });
      active = await protocol.capture("active-validator");
    });

    it("rejects forged balance, lifecycle epochs and slashing status", async () => {
      const input = protocol.topUpInput(active, validatorIndex);
      for (const field of [
        "effectiveBalance",
        "activationEligibilityEpoch",
        "exitEpoch",
        "withdrawableEpoch",
      ] as const) {
        const validator = { ...input.validatorWitness[0], [field]: BigInt(input.validatorWitness[0][field]) ^ 1n };
        await expect(protocol.topUp.topUp({ ...input, validatorWitness: [validator] })).to.be.revertedWithCustomError(
          sszErrors,
          "InvalidProof",
        );
      }
      const validator = { ...input.validatorWitness[0], slashed: true };
      await expect(protocol.topUp.topUp({ ...input, validatorWitness: [validator] })).to.be.revertedWithCustomError(
        sszErrors,
        "InvalidProof",
      );
      const earlierActivation = {
        ...input.validatorWitness[0],
        activationEpoch: BigInt(input.validatorWitness[0].activationEpoch) - 1n,
      };
      await expect(
        protocol.topUp.topUp({ ...input, validatorWitness: [earlierActivation] }),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("accepts the genuine proof through StakingRouter with zero available allocation", async () => {
      // This covers verification and routing; it does not claim a funded top-up was performed.
      // Scratch seeds Lido with 10 wei; the router rounds deposit allocation down to whole gwei.
      expect(await protocol.lido.getDepositableEther()).to.be.lessThan(ethers.parseUnits("1", "gwei"));
      const depositCount = await protocol.deposit.get_deposit_count();
      const receipt = await protocol.send(protocol.topUp, "topUp", [protocol.topUpInput(active, validatorIndex)]);
      const event = receipt.logs
        .filter((log) => log.address.toLowerCase() === String(protocol.router.target).toLowerCase())
        .map((log) => protocol.router.interface.parseLog(log))
        .find((log) => log?.name === "StakingRouterETHTopUp");
      expect(event, "real StakingRouter top-up event").not.to.equal(undefined);
      expect(event!.args.amount).to.equal(0n);
      expect(await protocol.deposit.get_deposit_count()).to.equal(depositCount);
    });

    it("enforces the block interval and rejects the old root once that interval passes", async () => {
      await expect(protocol.topUp.topUp(protocol.topUpInput(active, validatorIndex))).to.be.revertedWithCustomError(
        protocol.topUp,
        "MinBlockDistanceNotMet",
      );
      // With scratch defaults, 75 real 12-second blocks outlive the 300-second root window.
      await panda.advanceSlots(Number(await protocol.topUp.getMinBlockDistance()));
      expect(await protocol.topUp.isBlockDistancePassed()).to.equal(true);
      await expect(protocol.topUp.topUp(protocol.topUpInput(active, validatorIndex))).to.be.revertedWithCustomError(
        protocol.topUp,
        "RootIsTooOld",
      );
    });
  });

  describe("ConsolidationGateway: target proof and the EL-to-CL request", () => {
    let capture: Awaited<ReturnType<Protocol["capture"]>>;
    before(async () => {
      capture = await protocol.capture("consolidation-target");
    });

    it("rejects a target whose CL withdrawal credentials do not belong to the Lido vault", async () => {
      const foreignTarget = capture.witness(0).pubkey;
      const groups = [{ targetWitness: foreignTarget, sourcePubkeys: [validDeposit.pubkey] }];
      const fee = await protocol.withdrawalVault.getConsolidationRequestFee();
      await expect(
        protocol.consolidation.addConsolidationRequests(groups, protocol.account, { value: fee }),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("accepts a valid target proof and delivers the request to CL without scheduling a foreign source exit", async () => {
      const source = capture.state.validators[0].pubkey;
      const groups = [{ targetWitness: capture.witness(validatorIndex).pubkey, sourcePubkeys: [source] }];
      const fee = await protocol.withdrawalVault.getConsolidationRequestFee();
      await protocol.send(protocol.consolidation, "addConsolidationRequests", [groups, protocol.account], {
        value: fee,
      });
      await protocol.expectConsolidationRequest(source, validDeposit.pubkey);
      const validator = await protocol.validator(0);
      expect(validator.validator.exit_epoch).to.equal((2n ** 64n - 1n).toString());
    });
  });

  describe("ValidatorExitDelayVerifier: recent and historical CL evidence", () => {
    let requests: Awaited<ReturnType<Protocol["submitExitRequests"]>>;
    let eligible: Awaited<ReturnType<Protocol["capture"]>>;

    before("deliver real VEB requests and advance to their unchanged eligibility deadline", async () => {
      requests = await protocol.submitExitRequests(initial, [0, 1]);
      await protocol.advancePastExitDeadline(requests.delivered);
      eligible = await protocol.capture("exit-eligible");
    });

    it("rejects a forged block header and a corrupted validator proof", async () => {
      const witness = eligible.witness(0).exit;
      const forged = {
        ...eligible.beacon,
        header: { ...eligible.beacon.header, stateRoot: damaged(eligible.header.state_root) },
      };
      await expect(
        protocol.exitVerifier.verifyValidatorExitDelay(forged, [witness], requests),
      ).to.be.revertedWithCustomError(protocol.exitVerifier, "InvalidBlockHeader");
      const corrupted = {
        ...witness,
        validatorProof: [damaged(witness.validatorProof[0]), ...witness.validatorProof.slice(1)],
      };
      await expect(
        protocol.exitVerifier.verifyValidatorExitDelay(eligible.beacon, [corrupted], requests),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("reports a proven recent exit delay through StakingRouter into the real registry", async () => {
      const receipt = await protocol.send(protocol.exitVerifier, "verifyValidatorExitDelay", [
        eligible.beacon,
        [eligible.witness(0).exit],
        requests,
      ]);
      protocol.expectExitDelayEvent(receipt, initial.state.validators[0].pubkey);
    });

    it("proves an older block through the historical summary actually created by CL", async () => {
      const history = await protocol.historical(eligible);
      const witness = { ...eligible.witness(1).exit, exitRequestIndex: 1 };
      const broken = { ...history.old, proof: [damaged(history.old.proof[0]), ...history.old.proof.slice(1)] };
      await expect(
        protocol.exitVerifier.verifyHistoricalValidatorExitDelay(history.recent.beacon, broken, [witness], requests),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
      const receipt = await protocol.send(protocol.exitVerifier, "verifyHistoricalValidatorExitDelay", [
        history.recent.beacon,
        history.old,
        [witness],
        requests,
      ]);
      protocol.expectExitDelayEvent(receipt, initial.state.validators[1].pubkey);
    });

    it("rejects an exit-delay proof after CL accepts a real signed voluntary exit", async () => {
      const exitRequest = await protocol.submitExitRequests(active, [validatorIndex]);
      await panda.exitValidator(validDeposit.pubkey);
      await panda.advanceSlots(2);
      const exiting = await protocol.capture("scheduled-exit");
      expect(exiting.state.validators[validatorIndex].exit_epoch).not.to.equal((2n ** 64n - 1n).toString());
      await expect(
        protocol.exitVerifier.verifyValidatorExitDelay(
          exiting.beacon,
          [exiting.witness(validatorIndex).exit],
          exitRequest,
        ),
      ).to.be.revertedWithCustomError(sszErrors, "InvalidProof");
    });

    it("resumes real finality and accepts a fresh proof after the time jumps", async () => {
      const before = await protocol.finality();
      await panda.advanceSlots(96);
      const after = await protocol.finality();
      expect(BigInt(after.epoch)).to.be.greaterThan(BigInt(before.epoch));
      expect(BigInt(after.executionNumber)).to.be.greaterThan(BigInt(before.executionNumber));
      const resumed = await protocol.capture("resumed-finality");
      expect(resumed.state.validators.every((validator) => !validator.slashed)).to.equal(true);
      await expect(protocol.pdg.validatePubKeyWCProof(resumed.witness(validatorIndex).pubkey, validDeposit.wc)).not.to
        .be.reverted;
    });
  });
});
