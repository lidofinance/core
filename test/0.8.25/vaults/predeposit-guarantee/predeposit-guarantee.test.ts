import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  LidoLocator,
  OssifiableProxy,
  PredepositGuarantee,
  SSZMerkleTree,
  StakingVault,
  StakingVault__factory,
  VaultFactory__MockForStakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import { ether, findEvents } from "lib";
import {
  generateBeaconHeader,
  generatePostDeposit,
  generatePredeposit,
  generateValidator,
  prepareLocalMerkleTree,
  setBeaconBlockRoot,
} from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("PredepositGuarantee.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let vaultOperator: HardhatEthersSigner;
  let vaultOperatorGuarantor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let proxy: OssifiableProxy;
  let pdgImpl: PredepositGuarantee;
  let pdg: PredepositGuarantee;
  let locator: LidoLocator;
  let vaultHub: VaultHub__MockForStakingVault;
  let sszMerkleTree: SSZMerkleTree;
  let stakingVault: StakingVault;
  let depositContract: DepositContract__MockForStakingVault;

  let firstValidatorLeafIndex: bigint;

  let originalState: string;

  async function deployStakingVault(owner: HardhatEthersSigner, operator: HardhatEthersSigner): Promise<StakingVault> {
    const stakingVaultImplementation_ = await ethers.deployContract("StakingVault", [
      vaultHub,
      pdg,
      await depositContract.getAddress(),
    ]);

    // deploying factory/beacon
    const vaultFactory_: VaultFactory__MockForStakingVault = await ethers.deployContract(
      "VaultFactory__MockForStakingVault",
      [await stakingVaultImplementation_.getAddress()],
    );

    // deploying beacon proxy
    const vaultCreation = await vaultFactory_.createVault(owner, operator).then((tx) => tx.wait());
    if (!vaultCreation) throw new Error("Vault creation failed");
    const events = findEvents(vaultCreation, "VaultCreated");
    if (events.length != 1) throw new Error("There should be exactly one VaultCreated event");
    const vaultCreatedEvent = events[0];

    const stakingVault_ = StakingVault__factory.connect(vaultCreatedEvent.args.vault, owner);
    expect(await stakingVault_.owner()).to.equal(owner);

    return stakingVault_;
  }

  before(async () => {
    [deployer, admin, vaultOwner, vaultOperator, vaultOperatorGuarantor, stranger] = await ethers.getSigners();

    // local merkle tree with 1st validator
    const localMerkle = await prepareLocalMerkleTree();
    sszMerkleTree = localMerkle.sszMerkleTree;
    firstValidatorLeafIndex = localMerkle.firstValidatorLeafIndex;

    // ether deposit contract
    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");

    // PDG
    pdgImpl = await ethers.deployContract(
      "PredepositGuarantee",
      [localMerkle.gIFirstValidator, localMerkle.gIFirstValidator, 0],
      { from: deployer },
    );
    proxy = await ethers.deployContract("OssifiableProxy", [pdgImpl, admin, new Uint8Array()], admin);
    pdg = await ethers.getContractAt("PredepositGuarantee", proxy, vaultOperator);

    // PDG init
    const initTX = await pdg.initialize(admin);
    await expect(initTX).to.be.emit(pdg, "Initialized").withArgs(1);

    // PDG dependants
    locator = await deployLidoLocator({ predepositGuarantee: pdg });
    expect(await locator.predepositGuarantee()).to.equal(await pdg.getAddress());
    vaultHub = await ethers.deployContract("VaultHub__MockForStakingVault");
    stakingVault = await deployStakingVault(vaultOwner, vaultOperator);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts on impl initialization", async () => {
      await expect(pdgImpl.initialize(stranger)).to.be.revertedWithCustomError(pdgImpl, "InvalidInitialization");
    });
    it("reverts on `_admin` address is zero", async () => {
      const pdgProxy = await ethers.deployContract("OssifiableProxy", [pdgImpl, admin, new Uint8Array()], admin);
      const pdgLocal = await ethers.getContractAt("PredepositGuarantee", pdgProxy, vaultOperator);
      await expect(pdgLocal.initialize(ZeroAddress))
        .to.be.revertedWithCustomError(pdgImpl, "ZeroArgument")
        .withArgs("_defaultAdmin");
    });
  });

  context("happy path", () => {
    it("can use PDG happy path", async () => {
      // NO sets guarantor
      await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
      expect(await pdg.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperatorGuarantor);

      // guarantor funds PDG for operator
      await pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });
      let [operatorBondTotal, operatorBondLocked] = await pdg.nodeOperatorBalance(vaultOperator);
      expect(operatorBondTotal).to.equal(ether("1"));
      expect(operatorBondLocked).to.equal(0n);

      // Staking Vault is funded with enough ether to run validator
      await stakingVault.fund({ value: ether("32") });
      expect(await stakingVault.valuation()).to.equal(ether("32"));

      // NO generates validator for vault
      const vaultWC = await stakingVault.withdrawalCredentials();
      const validator = generateValidator(vaultWC);

      // NO runs predeposit for the vault
      const predepositData = generatePredeposit(validator);
      const predepositTX = pdg.predeposit(stakingVault, [predepositData]);

      await expect(predepositTX)
        .to.emit(pdg, "ValidatorPreDeposited")
        .withArgs(predepositData.pubkey, vaultOperator, stakingVault, vaultWC)
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(pdg, 1, predepositData.amount)
        .to.emit(depositContract, "DepositEvent")
        .withArgs(predepositData.pubkey, vaultWC, predepositData.signature, predepositData.depositDataRoot);

      [operatorBondTotal, operatorBondLocked] = await pdg.nodeOperatorBalance(vaultOperator);
      expect(operatorBondTotal).to.equal(ether("1"));
      expect(operatorBondLocked).to.equal(ether("1"));

      // Validator is added to CL merkle tree
      await sszMerkleTree.addValidatorLeaf(validator);
      const validatorLeafIndex = firstValidatorLeafIndex + 1n;
      const validatorIndex = 1n;

      // Beacon Block is generated with new CL state
      const stateRoot = await sszMerkleTree.getMerkleRoot();
      const beaconBlockHeader = generateBeaconHeader(stateRoot);
      const beaconBlockMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);

      /// Beacon Block root is posted to EL
      const childBlockTimestamp = await setBeaconBlockRoot(beaconBlockMerkle.root);

      // NO collects validator proof
      const validatorMerkle = await sszMerkleTree.getValidatorPubkeyWCParentProof(validator);
      const stateProof = await sszMerkleTree.getMerkleProof(validatorLeafIndex);
      const concatenatedProof = [...validatorMerkle.proof, ...stateProof, ...beaconBlockMerkle.proof];

      // NO posts proof and triggers deposit to total of 32 ether
      const postDepositData = generatePostDeposit(validator, ether("31"));
      const proveAndDepositTx = pdg.proveAndDeposit(
        [{ pubkey: validator.pubkey, validatorIndex, childBlockTimestamp, proof: concatenatedProof }],
        [postDepositData],
        stakingVault,
      );

      await expect(proveAndDepositTx)
        .to.emit(pdg, "ValidatorProven")
        .withArgs(validator.pubkey, vaultOperator, stakingVault, vaultWC)
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(pdg, 1, postDepositData.amount)
        .to.emit(depositContract, "DepositEvent")
        .withArgs(postDepositData.pubkey, vaultWC, postDepositData.signature, postDepositData.depositDataRoot);

      [operatorBondTotal, operatorBondLocked] = await pdg.nodeOperatorBalance(vaultOperator);
      expect(operatorBondTotal).to.equal(ether("1"));
      expect(operatorBondLocked).to.equal(ether("0"));

      // NOs guarantor withdraws bond from PDG
      await pdg.connect(vaultOperatorGuarantor).withdrawNodeOperatorBalance(vaultOperator, ether("1"), vaultOperator);
      [operatorBondTotal, operatorBondLocked] = await pdg.nodeOperatorBalance(vaultOperator);
      expect(operatorBondTotal).to.equal(ether("0"));
      expect(operatorBondLocked).to.equal(ether("0"));
    });
  });
});
