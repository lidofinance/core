import { expect } from "chai";
import { toChecksumAddress } from "ethereumjs-util";
import { hexlify, parseUnits } from "ethers";
import { ethers } from "hardhat";
import { getMode } from "hardhat.helpers";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Dashboard,
  DepositContract,
  OssifiableProxy,
  PredepositGuarantee,
  SSZBLSHelpers,
  StakingVault,
} from "typechain-types";

import {
  ether,
  impersonate,
  LocalMerkleTree,
  PDGPolicy,
  prepareLocalMerkleTree,
  toGwei,
  toLittleEndian64,
  ValidatorStage,
} from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

/**
 * Integration test for PDG with a specific validator deposited during soft launch
 *
 * This test ONLY runs in forking mode (MODE=forking) against mainnet.
 * It uses an existing mainnet vault and upgrades PDG to Phase 2 implementation.
 *
 * Run with: yarn test:fork:pdg-validator
 *
 * Validator pubkey: 0x85b99739ca7fab3129c57a8cf63b2ad2494ddc02b3d26ce2eb07a3a1c67226fdea89c715b7560fd5dc642925356b7dcc
 * Vault address: 0x62e0d92cf7b8752b5292b9bcbbace4cfa1633428
 */
describe("Scenario: PDG specific validator prove and top up on mainnet fork", function () {
  let ctx: ProtocolContext;
  let originalSnapshot: string;

  let stakingVault: StakingVault;
  let depositContract: DepositContract;
  let dashboard: Dashboard;
  let predepositGuarantee: PredepositGuarantee;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  // The specific validator pubkey to test, deposited during soft launch
  const VALIDATOR_PUBKEY =
    "0x85b99739ca7fab3129c57a8cf63b2ad2494ddc02b3d26ce2eb07a3a1c67226fdea89c715b7560fd5dc642925356b7dcc";

  // Mainnet vault address
  const MAINNET_VAULT_ADDRESS = toChecksumAddress("0x62e0d92cf7b8752b5292b9bcbbace4cfa1633428");

  // Pre-deployed PDG implementation address
  const PDG_IMPLEMENTATION_ADDRESS = toChecksumAddress("0xE78717192C45736DF0E4be55c0219Ee7f9aDdd0D");

  // Withdrawal credentials will be set to the vault's WC
  let withdrawalCredentials: string;

  // Mock CL tree and proof data
  let mockCLtree: LocalMerkleTree;
  let slot: bigint;

  before(async function () {
    ctx = await getProtocolContext();

    // Skip if not mainnet
    if (!ctx.isMainnet) this.skip();

    originalSnapshot = await Snapshot.take();

    // Upgrade PDG to the pre-deployed implementation
    await upgradePDG();

    // Setup existing mainnet vault
    await setupExistingVault();

    depositContract = await ethers.getContractAt("DepositContract", await stakingVault.DEPOSIT_CONTRACT());
    predepositGuarantee = ctx.contracts.predepositGuarantee;

    // Get the vault's withdrawal credentials
    withdrawalCredentials = await stakingVault.withdrawalCredentials();

    // Initialize mock CL tree for proof generation
    slot = await predepositGuarantee.PIVOT_SLOT();
    mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_CURR());
  });

  async function upgradePDG() {
    const agent = await ctx.getSigner("agent");

    // Get PDG proxy
    const pdgAddress = ctx.contracts.predepositGuarantee.address;
    const pdgProxy = (await ethers.getContractAt("OssifiableProxy", pdgAddress)) as OssifiableProxy;

    // Upgrade proxy to the pre-deployed implementation
    await pdgProxy.connect(agent).proxy__upgradeTo(PDG_IMPLEMENTATION_ADDRESS);

    // Resume PDG after upgrade (it starts paused)
    const pdg = ctx.contracts.predepositGuarantee;
    if (await pdg.isPaused()) {
      await pdg.connect(agent).grantRole(await pdg.RESUME_ROLE(), agent);
      await pdg.connect(agent).resume();
      await pdg.connect(agent).revokeRole(await pdg.RESUME_ROLE(), agent);
    }
  }

  async function setupExistingVault() {
    // Attach to the existing vault on mainnet
    stakingVault = await ethers.getContractAt("StakingVault", MAINNET_VAULT_ADDRESS);

    // Get VaultHub to find the dashboard (owner stored in vaultConnection when connected)
    const vaultHub = ctx.contracts.vaultHub;
    const vaultConnection = await vaultHub.vaultConnection(MAINNET_VAULT_ADDRESS);
    const dashboardAddress = vaultConnection.owner;
    dashboard = await ethers.getContractAt("Dashboard", dashboardAddress);

    // Get the node operator from the vault
    const nodeOperatorAddress = await stakingVault.nodeOperator();
    nodeOperator = await impersonate(nodeOperatorAddress, ether("100"));

    // Get the vault owner (admin of the dashboard)
    const adminRole = await dashboard.DEFAULT_ADMIN_ROLE();
    const adminAddress = await dashboard.getRoleMember(adminRole, 0);
    owner = await impersonate(adminAddress, ether("1000"));

    // Fund the vault
    await dashboard.connect(owner).fund({ value: ether("100") });
  }

  beforeEach(bailOnFailure);

  after(async function () {
    if (getMode() === "forking" && originalSnapshot) {
      await Snapshot.restore(originalSnapshot);
    }
  });

  function createValidatorContainer(): SSZBLSHelpers.ValidatorStruct {
    return {
      pubkey: VALIDATOR_PUBKEY,
      withdrawalCredentials: withdrawalCredentials,
      effectiveBalance: parseUnits("32", "gwei"),
      slashed: false,
      activationEligibilityEpoch: 100000,
      activationEpoch: 100001,
      exitEpoch: 2n ** 64n - 1n,
      withdrawableEpoch: 2n ** 64n - 1n,
    };
  }

  async function addValidatorAndGenerateWitness(validator: SSZBLSHelpers.ValidatorStruct, slotOffset: number) {
    const { validatorIndex } = await mockCLtree.addValidator(validator);
    const { childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(
      Number(slot) + slotOffset,
    );
    const proof = await mockCLtree.buildProof(validatorIndex, beaconBlockHeader);

    return {
      proof,
      pubkey: hexlify(validator.pubkey),
      validatorIndex,
      childBlockTimestamp,
      slot: beaconBlockHeader.slot,
      proposerIndex: beaconBlockHeader.proposerIndex,
    };
  }

  it("vault exists at the expected address with correct withdrawal credentials", async () => {
    const vaultWC = await stakingVault.withdrawalCredentials();
    const expectedWC = "0x02000000000000000000000062e0d92cf7b8752b5292b9bcbbace4cfa1633428";
    expect(vaultWC.toLowerCase()).to.equal(expectedWC.toLowerCase());
  });

  it("top up Node Operator balance for predeposit guarantee", async () => {
    await expect(
      predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") }),
    )
      .to.emit(predepositGuarantee, "BalanceToppedUp")
      .withArgs(nodeOperator, nodeOperator, ether("1"));

    const [nodeOperatorBalanceAmount] = await predepositGuarantee.nodeOperatorBalance(nodeOperator);
    expect(nodeOperatorBalanceAmount).to.be.gte(ether("1"));
  });

  it("set PDG policy to allow proving", async () => {
    const currentPolicy = await dashboard.pdgPolicy();

    if (
      currentPolicy !== BigInt(PDGPolicy.ALLOW_PROVE) &&
      currentPolicy !== BigInt(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE)
    ) {
      await expect(dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_PROVE))
        .to.emit(dashboard, "PDGPolicyEnacted")
        .withArgs(PDGPolicy.ALLOW_PROVE);
    }

    const policy = await dashboard.pdgPolicy();
    expect(policy === BigInt(PDGPolicy.ALLOW_PROVE) || policy === BigInt(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE)).to.be.true;
  });

  it("prove validator via Dashboard.proveUnknownValidatorsToPDG", async () => {
    const validator = createValidatorContainer();
    const witness = await addValidatorAndGenerateWitness(validator, 100);

    // Manager role has prove role by default
    const managerRole = await dashboard.NODE_OPERATOR_MANAGER_ROLE();
    const managerAddress = await dashboard.getRoleMember(managerRole, 0);
    const manager = await impersonate(managerAddress, ether("1"));

    await expect(dashboard.connect(manager).proveUnknownValidatorsToPDG([witness]))
      .to.emit(predepositGuarantee, "ValidatorProven")
      .withArgs(witness.pubkey, nodeOperator, stakingVault, withdrawalCredentials)
      .and.to.emit(predepositGuarantee, "ValidatorActivated")
      .withArgs(witness.pubkey, nodeOperator, stakingVault, withdrawalCredentials);

    const status = await predepositGuarantee.validatorStatus(witness.pubkey);
    expect(status.stage).to.equal(ValidatorStage.ACTIVATED);
    expect(status.stakingVault).to.equal(await stakingVault.getAddress());
  });

  it("top up: Proven validator can be topped up via PDG", async () => {
    const topUpAmount = ether("100");

    const tx = predepositGuarantee
      .connect(nodeOperator)
      .topUpExistingValidators([{ pubkey: VALIDATOR_PUBKEY, amount: topUpAmount }]);

    await expect(tx)
      .to.emit(depositContract, "DepositEvent")
      .withArgs(VALIDATOR_PUBKEY, withdrawalCredentials, toLittleEndian64(toGwei(topUpAmount)), anyValue, anyValue);

    await expect(tx).changeEtherBalance(stakingVault, -topUpAmount);
  });
});
