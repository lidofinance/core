import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway__MockForConsolidationBus } from "typechain-types";

import { Snapshot } from "test/suite";

/**
 * Gas limit test for ConsolidationBus.
 * Uses full contract stack: ConsolidationBus → ConsolidationGateway → WithdrawalVault → EIP-7251 (mocked)
 *
 * Only the EIP-7251 system contract is mocked.
 *
 * Results for batch of 200 requests:
 * ┌─────────────────────┬─────────────┐
 * │ Operation           │ Gas         │
 * ├─────────────────────┼─────────────┤
 * │ addConsolidation    │ 1,020,804   │
 * │ executeConsolidation│ 3,779,186   │
 * │ Total               │ 4,799,990   │
 * │ Per request         │ 23,999      │
 * └─────────────────────┴─────────────┘
 */
describe("ConsolidationBus.sol: gas limit (full stack)", () => {
  let consolidationBus: ConsolidationBus;
  let consolidationGateway: ConsolidationGateway__MockForConsolidationBus;

  let admin: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let executor: HardhatEthersSigner;

  const MAX_BLOCK_GAS = 16_000_000n;
  const BATCH_SIZE = 200;
  const FEE = 1n;

  const witnessesForTargets = (targets: string[]) =>
    targets.map((pubkey) => ({
      proof: [],
      pubkey,
      validatorIndex: 0,
      childBlockTimestamp: 0,
      slot: 0,
      proposerIndex: 0,
    }));

  let originalState: string;

  function generatePubkey(index: number): string {
    const hex = index.toString(16).padStart(96, "0");
    return "0x" + hex;
  }

  function generateBatch(size: number): { sourcePubkeysGroups: string[][]; targets: string[] } {
    const sourcePubkeysGroups: string[][] = [];
    const targets: string[] = [];
    for (let i = 0; i < size; i++) {
      sourcePubkeysGroups.push([generatePubkey(i * 2)]);
      targets.push(generatePubkey(i * 2 + 1));
    }
    return { sourcePubkeysGroups, targets };
  }

  before(async () => {
    [admin, publisher, executor] = await ethers.getSigners();

    // Deploy ConsolidationGateway mock
    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");
    await consolidationGateway.mock__setFee(FEE);

    // Deploy ConsolidationBus
    consolidationBus = await ethers.deployContract("ConsolidationBus", [
      admin.address,
      await consolidationGateway.getAddress(),
      200,
      200,
      0, // execution delay
    ]);

    // Set up roles
    await consolidationBus.connect(admin).grantRole(await consolidationBus.MANAGE_ROLE(), admin.address);
    await consolidationBus.connect(admin).grantRole(await consolidationBus.PUBLISH_ROLE(), publisher.address);

    originalState = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(originalState));

  it(`should execute batch of ${BATCH_SIZE} requests within gas limit`, async () => {
    const { sourcePubkeysGroups, targets } = generateBatch(BATCH_SIZE);

    // Add batch to bus
    const addTx = await consolidationBus.connect(publisher).addConsolidationRequests(sourcePubkeysGroups, targets);
    const addReceipt = await addTx.wait();

    // Calculate total fee
    const totalFee = FEE * BigInt(BATCH_SIZE);

    // Execute batch through full stack
    const executeTx = await consolidationBus
      .connect(executor)
      .executeConsolidation(sourcePubkeysGroups, witnessesForTargets(targets), {
        value: totalFee,
      });
    const executeReceipt = await executeTx.wait();

    expect(addReceipt!.gasUsed).to.be.lessThan(MAX_BLOCK_GAS);
    expect(executeReceipt!.gasUsed).to.be.lessThan(MAX_BLOCK_GAS);
  });
});
