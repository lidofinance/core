import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationBus, ConsolidationGateway__HarnessForTests, WithdrawalVault } from "typechain-types";

import { EIP7002_ADDRESS, EIP7251_ADDRESS, proxify } from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
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
  let consolidationGateway: ConsolidationGateway__HarnessForTests;
  let withdrawalVault: WithdrawalVault;

  let admin: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;

  const MAX_BLOCK_GAS = 16_000_000n;
  const BATCH_SIZE = 200;
  const FEE = 1n;

  const DUMMY_GI = "0x0000000000000000000000000000000000000000000000000096000000000028";
  const DUMMY_WC = "0x010000000000000000000000b9d7934878b5fb9610b3fe8a5e441e8fad7e293f";

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
    [admin, publisher, executor, treasury] = await ethers.getSigners();

    // 1. Deploy EIP-7251 mock at system contract address
    const eip7251Mock = await ethers.deployContract("EIP7251ConsolidationRequest__Mock");
    const eip7251MockAddress = await eip7251Mock.getAddress();
    await ethers.provider.send("hardhat_setCode", [EIP7251_ADDRESS, await ethers.provider.getCode(eip7251MockAddress)]);
    const eip7251 = await ethers.getContractAt("EIP7251ConsolidationRequest__Mock", EIP7251_ADDRESS);
    await eip7251.mock__setFee(FEE);

    // 2. Deploy Lido mock (needs canDeposit for _checkConsolidationPreconditions)
    const lido = await ethers.deployContract("Lido__MockForConsolidationGateway");

    // 3. Deploy LidoLocator
    const locator = await deployLidoLocator();
    const locatorAddress = await locator.getAddress();

    // 3a. Deploy DSM mock (needed for _checkConsolidationPreconditions check in ConsolidationGateway)
    const dsm = await ethers.deployContract("DepositSecurityModule__MockForConsolidationGateway");

    // 4. Deploy ConsolidationGateway
    consolidationGateway = await ethers.deployContract("ConsolidationGateway__HarnessForTests", [
      admin.address,
      locatorAddress,
      10000, // maxConsolidationRequestsLimit
      10000, // consolidationsPerFrame
      86400, // frameDurationInSec
      DUMMY_GI,
      DUMMY_GI,
      0,
      DUMMY_WC,
    ]);

    // 5. Deploy real WithdrawalVault
    const vaultImpl = await ethers.deployContract("WithdrawalVault", [
      await lido.getAddress(),
      treasury.address,
      treasury.address, // triggerableWithdrawalsGateway (not used in this test)
      await consolidationGateway.getAddress(),
      EIP7002_ADDRESS,
      EIP7251_ADDRESS,
    ]);
    const [vault] = await proxify({ impl: vaultImpl, admin });
    withdrawalVault = vault as unknown as WithdrawalVault;

    // 6. Update LidoLocator to point to real WithdrawalVault, DSM mock, and Lido mock
    await updateLidoLocatorImplementation(locatorAddress, {
      withdrawalVault: await withdrawalVault.getAddress(),
      depositSecurityModule: await dsm.getAddress(),
      lido: await lido.getAddress(),
    });

    // 7. Deploy ConsolidationBus
    consolidationBus = await ethers.deployContract("ConsolidationBus", [
      admin.address,
      await consolidationGateway.getAddress(),
      200,
      200,
    ]);

    // 8. Set up roles
    await consolidationBus.connect(admin).grantRole(await consolidationBus.MANAGE_ROLE(), admin.address);
    await consolidationBus.connect(admin).grantRole(await consolidationBus.PUBLISH_ROLE(), publisher.address);

    // Grant ADD_CONSOLIDATION_REQUEST_ROLE to ConsolidationBus
    await consolidationGateway
      .connect(admin)
      .grantRole(await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE(), await consolidationBus.getAddress());

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
