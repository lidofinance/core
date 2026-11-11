import { expect } from "chai";
import { ethers } from "hardhat";
import {
  assertCMv2ConsolidationMigratorDeployState,
  main as deployCMv2ConsolidationMigrator,
} from "scripts/upgrade/steps/0920-cmv2-consolidation-migrator-deploy";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationMigrator } from "typechain-types";

import { ether, findEventsWithInterfaces, impersonate, loadContract } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  calcConsolidationBatchHash,
  cmv2EnsureDepositedOperatorKeys,
  CMv2OperatorKeys,
  cmv2SuiteEnabled,
  ConsolidationPubkeyGroup,
  ConsolidationTargetWitness,
  decodeConsolidationRequest,
  ensureBatchNotPending,
  prepareConsolidationTargetWitnesses,
  waitUntilBatchExecutable,
} from "lib/protocol/helpers";
import { LoadedContract } from "lib/protocol/types";
import { getAddressValidated, readNetworkState, Sk } from "lib/state-file";

import { Snapshot } from "test/suite";

// Curated Module Committee multisig by chain id. It holds DISALLOW_PAIR_ROLE on the CMv1 -> CMv2 migrator.
const CURATED_MODULE_COMMITTEE: Record<string, string> = {
  "1": "0x2570e0b22AD904501dfB0d49575991ACB801dD91",
  "560048": "0x84DffcfB232594975C608DE92544Ff239a24c9E9",
};

type IndexGroup = { sourceKeyIndices: bigint[]; targetKeyIndex: bigint };

/**
 * Integration test for the ConsolidationMigrator instance whose source and target module are both
 * Curated Module v2. A CMv2 operator moves stake between its own validators with a pair (N, N).
 *
 * The suite gets the instance from the deploy step `0920-cmv2-consolidation-migrator-deploy`, or uses
 * the instance recorded in the state file. The deploy step grants the pair roles to the committee and
 * leaves the Agent as the only admin. When the ConsolidationBus does not list the instance as a
 * publisher yet, the suite checks the deploy state and then applies the DAO vote action as the Agent:
 * ConsolidationBus.grantRole(PUBLISH_ROLE, migrator).
 */
describe("Integration: Consolidation inside CMv2 (Real CMv2 -> Real CMv2)", () => {
  let ctx: ProtocolContext;
  let consolidationBus: LoadedContract<ConsolidationBus>;
  let legacyMigrator: LoadedContract<ConsolidationMigrator>;
  let migrator: ConsolidationMigrator;
  let migratorAddress: string;

  let agent: HardhatEthersSigner;
  let committee: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let submitter: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let cmv2ModuleId: bigint;
  let operator: CMv2OperatorKeys;
  let operatorId: bigint;

  let targetWitnesses: ConsolidationTargetWitness[];

  let knownCommittee: string | undefined;
  let voteSimulated: boolean;
  let globalSnapshot: string;
  let testSnapshot: string;

  // Positions in `operator.keyIndices`: sources first, then targets
  const SOURCE_1 = 0;
  const SOURCE_2 = 1;
  const TARGET_1 = 2;
  const TARGET_2 = 3;

  before(async function () {
    ctx = await getProtocolContext();
    globalSnapshot = await Snapshot.take();

    if (!cmv2SuiteEnabled(ctx, "the CMv2 internal consolidation suite")) {
      return this.skip();
    }

    [, executor, submitter, stranger] = await ethers.getSigners();
    consolidationBus = ctx.contracts.consolidationBus;
    legacyMigrator = ctx.contracts.consolidationMigrator;
    cmv2ModuleId = ctx.modules.cmv2!.id;
    agent = await ctx.getSigner("agent");

    const deployedAddress = getAddressValidated(Sk.consolidationMigratorCMv2, readNetworkState());
    if (!deployedAddress || (await ethers.provider.getCode(deployedAddress)) === "0x") {
      await deployCMv2ConsolidationMigrator();
    }
    migratorAddress = getAddressValidated(Sk.consolidationMigratorCMv2, readNetworkState())!;
    migrator = await loadContract<ConsolidationMigrator>("ConsolidationMigrator", migratorAddress);

    const { chainId } = await ethers.provider.getNetwork();
    knownCommittee = CURATED_MODULE_COMMITTEE[chainId.toString()];
    const [committeeAddress] = await migrator.getRoleMembers(await migrator.ALLOW_PAIR_ROLE());
    committee = await impersonate(committeeAddress, ether("10"));

    const PUBLISH_ROLE = await consolidationBus.PUBLISH_ROLE();
    voteSimulated = !(await consolidationBus.hasRole(PUBLISH_ROLE, migratorAddress));
    if (voteSimulated) {
      await assertCMv2ConsolidationMigratorDeployState(readNetworkState());
      await consolidationBus.connect(agent).grantRole(PUBLISH_ROLE, migratorAddress);
    }

    // REMOVE_ROLE lets the suite clear an identical batch left pending on a live fork block
    await consolidationBus.connect(agent).grantRole(await consolidationBus.REMOVE_ROLE(), agent.address);

    operator = await cmv2EnsureDepositedOperatorKeys(ctx, 4n, { name: "cmv2_internal_consolidation_operator" });
    operatorId = operator.operatorId;

    await migrator.connect(committee).allowPair(operatorId, operatorId, submitter.address);

    ({ witnesses: targetWitnesses } = await prepareConsolidationTargetWitnesses(ctx, [
      operator.pubkeys[TARGET_1],
      operator.pubkeys[TARGET_2],
    ]));
  });

  after(async () => await Snapshot.restore(globalSnapshot));

  beforeEach(async () => (testSnapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(testSnapshot));

  const indexGroup = (sources: number[], target: number): IndexGroup => ({
    sourceKeyIndices: sources.map((p) => operator.keyIndices[p]),
    targetKeyIndex: operator.keyIndices[target],
  });

  const pubkeyGroup = (sources: number[], target: number): ConsolidationPubkeyGroup => ({
    sourcePubkeys: sources.map((p) => operator.pubkeys[p]),
    targetPubkey: operator.pubkeys[target],
  });

  const witnessFor = (target: number) => targetWitnesses[target === TARGET_1 ? 0 : 1];

  const submit = async (groups: [number[], number][]) => {
    const batchHash = calcConsolidationBatchHash(groups.map(([s, t]) => pubkeyGroup(s, t)));
    await ensureBatchNotPending(consolidationBus, agent, batchHash);
    const tx = await migrator.connect(submitter).submitConsolidationBatch(
      operatorId,
      operatorId,
      groups.map(([s, t]) => indexGroup(s, t)),
    );
    return { tx, batchHash };
  };

  const execute = async (groups: [number[], number][], batchHash: string) => {
    const { withdrawalVault } = ctx.contracts;
    await waitUntilBatchExecutable(consolidationBus, batchHash);

    const requestsCount = groups.reduce((sum, [s]) => sum + s.length, 0);
    const fee = (await withdrawalVault.getConsolidationRequestFee()) * BigInt(requestsCount);

    const tx = await consolidationBus.connect(executor).executeConsolidation(
      groups.map(([s, t]) => ({ sourcePubkeys: pubkeyGroup(s, t).sourcePubkeys, targetWitness: witnessFor(t) })),
      { value: fee },
    );
    const receipt = (await tx.wait())!;
    return findEventsWithInterfaces(receipt, "ConsolidationRequestAdded", [withdrawalVault.interface]).map((e) =>
      decodeConsolidationRequest(e.args.request),
    );
  };

  const request = (source: number, target: number) => ({
    sourcePubkey: operator.pubkeys[source].toLowerCase(),
    targetPubkey: operator.pubkeys[target].toLowerCase(),
  });

  context("Deployment and vote", () => {
    it("binds the new migrator to CMv2 as both source and target module", async () => {
      expect(await migrator.sourceModuleId()).to.equal(cmv2ModuleId);
      expect(await migrator.targetModuleId()).to.equal(cmv2ModuleId);
      expect(await migrator.getStakingRouter()).to.equal(await ctx.contracts.stakingRouter.getAddress());
      expect(await migrator.getConsolidationBus()).to.equal(await consolidationBus.getAddress());
    });

    it("leaves the Agent as the only admin and the committee as the only pair manager", async () => {
      const DEFAULT_ADMIN_ROLE = await migrator.DEFAULT_ADMIN_ROLE();
      const ALLOW_PAIR_ROLE = await migrator.ALLOW_PAIR_ROLE();
      const DISALLOW_PAIR_ROLE = await migrator.DISALLOW_PAIR_ROLE();

      expect(await migrator.getRoleMembers(DEFAULT_ADMIN_ROLE)).to.deep.equal([agent.address]);
      expect(await migrator.getRoleMembers(ALLOW_PAIR_ROLE)).to.deep.equal([committee.address]);
      expect(await migrator.getRoleMembers(DISALLOW_PAIR_ROLE)).to.deep.equal([committee.address]);
    });

    it("adds the new migrator as a ConsolidationBus publisher next to the CMv1 -> CMv2 migrator", async () => {
      const PUBLISH_ROLE = await consolidationBus.PUBLISH_ROLE();
      expect(await consolidationBus.hasRole(PUBLISH_ROLE, migratorAddress)).to.be.true;
      expect(await consolidationBus.hasRole(PUBLISH_ROLE, await legacyMigrator.getAddress())).to.be.true;
      expect(await legacyMigrator.sourceModuleId()).to.equal(ctx.modules.nor.id);
      expect(await legacyMigrator.targetModuleId()).to.equal(cmv2ModuleId);
    });

    it("gives the pair roles to the network's committee", async function () {
      if (!knownCommittee) return this.skip();
      expect(await legacyMigrator.getRoleMembers(await legacyMigrator.DISALLOW_PAIR_ROLE())).to.deep.equal([
        knownCommittee,
      ]);
      expect(committee.address).to.equal(knownCommittee);
    });
  });

  context("Consolidation inside one CMv2 operator", () => {
    it("moves one validator into another validator of the same operator", async () => {
      const groups: [number[], number][] = [[[SOURCE_1], TARGET_1]];
      const { tx, batchHash } = await submit(groups);

      await expect(tx)
        .to.emit(migrator, "ConsolidationSubmitted")
        .withArgs(operatorId, operatorId, [[[operator.keyIndices[SOURCE_1]], operator.keyIndices[TARGET_1]]]);
      expect((await consolidationBus.getBatchInfo(batchHash)).publisher).to.equal(migratorAddress);

      expect(await execute(groups, batchHash)).to.deep.equal([request(SOURCE_1, TARGET_1)]);
      expect((await consolidationBus.getBatchInfo(batchHash)).publisher).to.equal(ethers.ZeroAddress);
    });

    it("executes several groups in one batch", async () => {
      const groups: [number[], number][] = [
        [[SOURCE_1], TARGET_1],
        [[SOURCE_2], TARGET_2],
      ];
      const { batchHash } = await submit(groups);

      expect(await execute(groups, batchHash)).to.deep.equal([
        request(SOURCE_1, TARGET_1),
        request(SOURCE_2, TARGET_2),
      ]);
    });

    it("moves several validators into one target", async () => {
      const groups: [number[], number][] = [[[SOURCE_1, SOURCE_2], TARGET_1]];
      const { batchHash } = await submit(groups);

      expect(await execute(groups, batchHash)).to.deep.equal([
        request(SOURCE_1, TARGET_1),
        request(SOURCE_2, TARGET_1),
      ]);
    });

    it("reverts when a key is both the source and the target", async () => {
      await expect(
        migrator
          .connect(submitter)
          .submitConsolidationBatch(operatorId, operatorId, [indexGroup([TARGET_1], TARGET_1)]),
      )
        .to.be.revertedWithCustomError(consolidationBus, "SourceEqualsTarget")
        .withArgs(0, 0);
    });

    it("reverts when a source or target key is not deposited", async () => {
      const cmv2 = new ethers.Contract(
        ctx.modules.cmv2!.stakingModuleAddress,
        [
          "function getNodeOperatorSummary(uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
        ],
        ethers.provider,
      );
      const totalDeposited: bigint = (await cmv2.getNodeOperatorSummary(operatorId))[6];

      await expect(
        migrator
          .connect(submitter)
          .submitConsolidationBatch(operatorId, operatorId, [
            { sourceKeyIndices: [totalDeposited], targetKeyIndex: operator.keyIndices[TARGET_1] },
          ]),
      )
        .to.be.revertedWithCustomError(migrator, "KeyNotDeposited")
        .withArgs(cmv2ModuleId, operatorId, totalDeposited);

      await expect(
        migrator
          .connect(submitter)
          .submitConsolidationBatch(operatorId, operatorId, [
            { sourceKeyIndices: [operator.keyIndices[SOURCE_1]], targetKeyIndex: totalDeposited },
          ]),
      )
        .to.be.revertedWithCustomError(migrator, "KeyNotDeposited")
        .withArgs(cmv2ModuleId, operatorId, totalDeposited);
    });

    it("reverts when the caller is not the pair submitter", async () => {
      await expect(
        migrator.connect(stranger).submitConsolidationBatch(operatorId, operatorId, [indexGroup([SOURCE_1], TARGET_1)]),
      )
        .to.be.revertedWithCustomError(migrator, "NotAuthorized")
        .withArgs(stranger.address, operatorId, operatorId);
    });
  });

  context("Pair management", () => {
    it("lets only the committee allow a pair", async () => {
      const ALLOW_PAIR_ROLE = await migrator.ALLOW_PAIR_ROLE();
      for (const caller of [stranger, agent]) {
        await expect(migrator.connect(caller).allowPair(operatorId, operatorId, caller.address))
          .to.be.revertedWithCustomError(migrator, "AccessControlUnauthorizedAccount")
          .withArgs(caller.address, ALLOW_PAIR_ROLE);
      }
    });

    it("blocks new batches after the committee disallows the pair, and keeps a pending batch executable", async () => {
      const groups: [number[], number][] = [[[SOURCE_1], TARGET_1]];
      const { batchHash } = await submit(groups);

      await expect(migrator.connect(committee).disallowPair(operatorId, operatorId))
        .to.emit(migrator, "ConsolidationPairDisallowed")
        .withArgs(operatorId, operatorId, submitter.address);

      await expect(
        migrator
          .connect(submitter)
          .submitConsolidationBatch(operatorId, operatorId, [indexGroup([SOURCE_2], TARGET_2)]),
      )
        .to.be.revertedWithCustomError(migrator, "NotAuthorized")
        .withArgs(submitter.address, operatorId, operatorId);

      expect(await execute(groups, batchHash)).to.deep.equal([request(SOURCE_1, TARGET_1)]);
    });

    it("lets the submitter disallow its own pair", async () => {
      await migrator.connect(submitter).selfDisallowPair(operatorId, operatorId);
      expect(await migrator.isPairAllowed(operatorId, operatorId)).to.be.false;
      expect(await migrator.getSubmitter(operatorId, operatorId)).to.equal(ethers.ZeroAddress);
    });

    it("lets the committee allow a pair of two different CMv2 operators (trusted committee)", async () => {
      const otherOperatorId = operatorId + 1n;
      await migrator.connect(committee).allowPair(operatorId, otherOperatorId, submitter.address);
      expect(await migrator.isPairAllowed(operatorId, otherOperatorId)).to.be.true;
    });
  });
});
