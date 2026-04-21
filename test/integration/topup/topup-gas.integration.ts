import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { SSZValidatorsMerkleTree, StakingModuleV2__MockForStakingRouter, TopUpGateway } from "typechain-types";

import { WithdrawalCredentialsType } from "lib";
import { addressToWC, generateBeaconHeader, generateValidator, setBeaconBlockRoot, Validator } from "lib/pdg";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { prepareLocalMerkleTree } from "lib/top-ups";

import { Snapshot } from "test/suite";

/**
 * Gas measurement integration test for TopUpGateway.topUp().
 *
 * Uses a mock V2 staking module (WC 0x02) added to the real StakingRouter.
 * Merkle proofs are built locally via SSZValidatorsMerkleTree.
 * Validators effectiveBalance = targetBalanceGwei → topUpLimits = 0, no depositable ether needed.
 *
 * To find the maximum batch size, change NUM_VALIDATORS and rerun.
 */
describe("Integration: TopUpGateway gas measurement", () => {
  let ctx: ProtocolContext;
  let topUpGateway: TopUpGateway;
  let mockModuleV2: StakingModuleV2__MockForStakingRouter;
  let moduleId: bigint;

  let caller: HardhatEthersSigner;

  const MAX_BLOCK_GAS = 16_000_000n;
  const FAR_FUTURE_EPOCH = 2n ** 64n - 1n;
  const SLOT = 3200; // epoch = 100

  // *** Change this value to find the maximum batch size ***
  const NUM_VALIDATORS = 100;

  let targetBalanceGwei: bigint;

  // Tree state
  let sszMerkleTree: SSZValidatorsMerkleTree;
  let firstValidatorLeafIndex: bigint;

  // Pre-built data
  let validators: Validator[];
  let allValidatorIndices: number[];
  let allProofValidators: string[][];
  let childBlockTimestamp: number;
  let beaconBlockHeader: ReturnType<typeof generateBeaconHeader>;

  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    originalState = await Snapshot.take();

    [, caller] = await ethers.getSigners();
    const [deployer] = await ethers.getSigners();

    const { stakingRouter } = ctx.contracts;

    // =========================================
    // Get TopUpGateway from LidoLocator
    // =========================================
    const topUpGatewayAddress = await ctx.contracts.locator.topUpGateway();
    topUpGateway = await ethers.getContractAt("TopUpGateway", topUpGatewayAddress);

    targetBalanceGwei = BigInt(await topUpGateway.getTargetBalanceGwei());

    // =========================================
    // Deploy mock V2 module and add to StakingRouter
    // =========================================
    mockModuleV2 = await ethers.deployContract("StakingModuleV2__MockForStakingRouter");

    const agentSigner = await ctx.getSigner("agent");

    const STAKING_MODULE_MANAGE_ROLE = await stakingRouter.STAKING_MODULE_MANAGE_ROLE();
    await stakingRouter.connect(agentSigner).grantRole(STAKING_MODULE_MANAGE_ROLE, agentSigner.address);

    const modulesCountBefore = await stakingRouter.getStakingModulesCount();
    moduleId = modulesCountBefore + 1n;

    await stakingRouter.connect(agentSigner).addStakingModule("MockV2TopUp", await mockModuleV2.getAddress(), {
      stakeShareLimit: 10000,
      priorityExitShareThreshold: 10000,
      stakingModuleFee: 500,
      treasuryFee: 500,
      maxDepositsPerBlock: 150,
      minDepositBlockDistance: 25,
      withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
    });

    expect(await stakingRouter.getStakingModulesCount()).to.equal(modulesCountBefore + 1n);

    // =========================================
    // Grant roles on TopUpGateway
    // =========================================
    const TOP_UP_ROLE = await topUpGateway.TOP_UP_ROLE();
    const MANAGE_LIMITS_ROLE = await topUpGateway.MANAGE_LIMITS_ROLE();

    await topUpGateway.connect(deployer).grantRole(TOP_UP_ROLE, caller.address);
    await topUpGateway.connect(deployer).grantRole(MANAGE_LIMITS_ROLE, deployer.address);
    await topUpGateway.connect(deployer).setMaxValidatorsPerTopUp(NUM_VALIDATORS);

    // =========================================
    // Build SSZValidatorsMerkleTree with NUM_VALIDATORS
    // =========================================
    const localTree = await prepareLocalMerkleTree();
    sszMerkleTree = localTree.stateTree;
    firstValidatorLeafIndex = localTree.firstValidatorLeafIndex;

    const withdrawalCredentials = addressToWC(await ctx.contracts.withdrawalVault.getAddress(), 2);

    validators = [];
    allValidatorIndices = [];

    for (let i = 0; i < NUM_VALIDATORS; i++) {
      const v = generateValidator(withdrawalCredentials);

      v.container.effectiveBalance = targetBalanceGwei; // → topUpLimit = 0
      v.container.slashed = false;
      v.container.activationEligibilityEpoch = 1n;
      v.container.activationEpoch = 2n; // < epoch(SLOT=3200) = 100
      v.container.exitEpoch = FAR_FUTURE_EPOCH;
      v.container.withdrawableEpoch = FAR_FUTURE_EPOCH;

      await sszMerkleTree.addValidatorsLeaf(v.container);
      validators.push(v);

      const leafCount = await sszMerkleTree.leafCount();
      const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);
      allValidatorIndices.push(validatorIndex);
    }

    // Commit state root to EIP-4788
    const stateRoot = await sszMerkleTree.getStateRoot();
    beaconBlockHeader = generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(beaconBlockHeader);
    childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    // Build all proofs: validator[i] → state_root → beacon_block_root
    allProofValidators = await Promise.all(
      allValidatorIndices.map(async (vi) => {
        const validatorProof = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(vi));
        const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);
        return [...validatorProof, ...headerMerkle.proof];
      }),
    );
  });

  after(async () => await Snapshot.restore(originalState));

  it(`should measure gas for topUp with ${NUM_VALIDATORS} validators`, async () => {
    await ethers.provider.send("evm_increaseTime", [1]);
    await ethers.provider.send("evm_mine", []);

    const topUpData = {
      moduleId,
      keyIndices: allValidatorIndices.map((_, i) => BigInt(i)),
      operatorIds: allValidatorIndices.map(() => 0n),
      validatorIndices: allValidatorIndices.map((vi) => BigInt(vi)),
      beaconRootData: {
        childBlockTimestamp,
        slot: beaconBlockHeader.slot,
        proposerIndex: beaconBlockHeader.proposerIndex,
      },
      validatorWitness: validators.map((v, i) => ({
        proofValidator: allProofValidators[i],
        pubkey: v.container.pubkey,
        effectiveBalance: v.container.effectiveBalance,
        slashed: v.container.slashed,
        activationEligibilityEpoch: v.container.activationEligibilityEpoch,
        activationEpoch: v.container.activationEpoch,
        exitEpoch: v.container.exitEpoch,
        withdrawableEpoch: v.container.withdrawableEpoch,
      })),
      pendingBalanceGwei: allValidatorIndices.map(() => 0n),
    };

    const tx = await topUpGateway.connect(caller).topUp(topUpData);
    const receipt = await tx.wait();

    const gasUsed = receipt!.gasUsed;
    const fitsInBlock = gasUsed < MAX_BLOCK_GAS;
    const perValidator = gasUsed / BigInt(NUM_VALIDATORS);

    console.log(`\n  TopUpGateway.topUp() with ${NUM_VALIDATORS} validators:`);
    console.log(`    Gas used:         ${Number(gasUsed).toLocaleString()}`);
    console.log(`    Per validator:    ${Number(perValidator).toLocaleString()}`);
    console.log(
      `    Fits in block:    ${fitsInBlock ? "YES" : "NO"} (limit: ${Number(MAX_BLOCK_GAS).toLocaleString()})`,
    );

    expect(gasUsed).to.be.greaterThan(0n);
  });
});
