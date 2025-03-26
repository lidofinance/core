import { expect } from "chai";
import { hexlify, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  EthRejector,
  LidoLocator,
  OssifiableProxy,
  PredepositGuarantee,
  SSZHelpers,
  SSZMerkleTree,
  StakingVault,
  StakingVault__factory,
  StakingVault__MockForVaultHub,
  VaultFactory__MockForStakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";
import { CLProofVerifier } from "typechain-types/contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee";

import {
  addressToWC,
  ether,
  findEvents,
  generateBeaconHeader,
  generatePostDeposit,
  generatePredeposit,
  generateValidator,
  prepareLocalMerkleTree,
  randomBytes32,
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
  let pauser: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let proxy: OssifiableProxy;
  let pdgImpl: PredepositGuarantee;
  let pdg: PredepositGuarantee;
  let locator: LidoLocator;
  let vaultHub: VaultHub__MockForStakingVault;
  let sszMerkleTree: SSZMerkleTree;
  let stakingVault: StakingVault;
  let wcMockStakingVault: StakingVault__MockForVaultHub;
  let depositContract: DepositContract__MockForStakingVault;
  let rejector: EthRejector;

  let firstValidatorLeafIndex: bigint;

  let originalState: string;

  async function deployStakingVault(
    owner: HardhatEthersSigner,
    operator: HardhatEthersSigner,
    vaultHub_: VaultHub__MockForStakingVault,
  ): Promise<StakingVault> {
    const stakingVaultImplementation_ = await ethers.deployContract("StakingVault", [
      pdg,
      await depositContract.getAddress(),
    ]);

    // deploying factory/beacon
    const vaultFactory_: VaultFactory__MockForStakingVault = await ethers.deployContract(
      "VaultFactory__MockForStakingVault",
      [await stakingVaultImplementation_.getAddress()],
    );

    // deploying beacon proxy
    const vaultCreation = await vaultFactory_.createVault(owner, operator, vaultHub_).then((tx) => tx.wait());
    if (!vaultCreation) throw new Error("Vault creation failed");
    const events = findEvents(vaultCreation, "VaultCreated");
    if (events.length != 1) throw new Error("There should be exactly one VaultCreated event");
    const vaultCreatedEvent = events[0];

    const stakingVault_ = StakingVault__factory.connect(vaultCreatedEvent.args.vault, owner);
    expect(await stakingVault_.owner()).to.equal(owner);

    return stakingVault_;
  }

  before(async () => {
    [deployer, admin, vaultOwner, vaultOperator, vaultOperatorGuarantor, pauser, stranger] = await ethers.getSigners();

    // local merkle tree with 1st validator
    const localMerkle = await prepareLocalMerkleTree();
    sszMerkleTree = localMerkle.sszMerkleTree;
    firstValidatorLeafIndex = localMerkle.firstValidatorLeafIndex;

    // eth rejector
    rejector = await ethers.deployContract("EthRejector");

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
    stakingVault = await deployStakingVault(vaultOwner, vaultOperator, vaultHub);
    wcMockStakingVault = await ethers.deployContract("StakingVault__MockForVaultHub", [depositContract, pdg]);
    await wcMockStakingVault.initialize(vaultOwner, vaultOperator, vaultHub, "0x00");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constructor", () => {
    it("ossifies the implementation", async () => {
      expect(await pdgImpl.isPaused()).to.be.true;
      await expect(pdgImpl.initialize(stranger)).to.be.revertedWithCustomError(pdgImpl, "InvalidInitialization");
    });

    it("reverts on `_defaultAdmin` address is zero", async () => {
      const pdgProxy = await ethers.deployContract("OssifiableProxy", [pdgImpl, admin, new Uint8Array()], admin);
      const pdgLocal = await ethers.getContractAt("PredepositGuarantee", pdgProxy, vaultOperator);
      await expect(pdgLocal.initialize(ZeroAddress))
        .to.be.revertedWithCustomError(pdgImpl, "ZeroArgument")
        .withArgs("_defaultAdmin");
    });

    it("reverts after reinitialization", async () => {
      const pdgProxy = await ethers.deployContract("OssifiableProxy", [pdgImpl, admin, new Uint8Array()], admin);
      const pdgLocal = await ethers.getContractAt("PredepositGuarantee", pdgProxy, vaultOperator);
      await pdgLocal.initialize(admin);

      await expect(pdgLocal.initialize(admin)).to.be.revertedWithCustomError(pdgImpl, "InvalidInitialization");
    });

    it("should assign DEFAULT_ADMIN_ROLE to the '_defaultAdmin' after initialize", async () => {
      const pdgProxy = await ethers.deployContract("OssifiableProxy", [pdgImpl, admin, new Uint8Array()], admin);
      const pdgLocal = await ethers.getContractAt("PredepositGuarantee", pdgProxy, vaultOperator);
      await pdgLocal.initialize(admin);

      const DEFAULT_ADMIN_ROLE = await pdgLocal.DEFAULT_ADMIN_ROLE();
      const hasRole = await pdgLocal.hasRole(DEFAULT_ADMIN_ROLE, admin);
      expect(hasRole).to.be.true;
    });
  });

  context("Happy path", () => {
    it("allows NO to complete PDG happy path ", async () => {
      // NO sets guarantor
      await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
      expect(await pdg.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperatorGuarantor);

      // guarantor funds PDG for operator
      await expect(pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: ether("1") }))
        .to.emit(pdg, "BalanceToppedUp")
        .withArgs(vaultOperator, vaultOperatorGuarantor, ether("1"));

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

  context("Node Operator Accounting", () => {
    context("setNodeOperatorGuarantor", () => {
      it("reverts when the 'setNodeOperatorGuarantor' got address is zero", async () => {
        await expect(pdg.connect(vaultOperator).setNodeOperatorGuarantor(ZeroAddress)).to.be.revertedWithCustomError(
          pdg,
          "ZeroArgument",
        );
      });

      it("reverts when the 'setNodeOperatorGuarantor' got the same guarantor address", async () => {
        await pdg.connect(vaultOperator).setNodeOperatorGuarantor(vaultOperatorGuarantor);
        await expect(
          pdg.connect(vaultOperator).setNodeOperatorGuarantor(vaultOperatorGuarantor),
        ).to.be.revertedWithCustomError(pdg, "SameGuarantor");
      });

      it("reverts when setting guarantor with in-flight deposits", async () => {
        await stakingVault.fund({ value: ether("32") });
        await pdg.predeposit(stakingVault, [generatePredeposit(generateValidator())], { value: ether("1") });

        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([ether("1"), ether("1")]);

        await expect(pdg.connect(vaultOperator).setNodeOperatorGuarantor(vaultOperatorGuarantor))
          .to.be.revertedWithCustomError(pdg, "LockedIsNotZero")
          .withArgs(ether("1"));
      });

      it("NO is refunded with setting guarantor", async () => {
        const pdgNO = pdg.connect(vaultOperator);

        const balance = ether("1");

        // init
        await pdgNO.topUpNodeOperatorBalance(vaultOperator, { value: balance });
        const [operatorBondTotal] = await pdgNO.nodeOperatorBalance(vaultOperator);
        expect(operatorBondTotal).to.equal(balance);
        expect(await pdgNO.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperator);

        // set guarantor

        const setGuarantorTx = await pdg.connect(vaultOperator).setNodeOperatorGuarantor(vaultOperatorGuarantor);

        await expect(setGuarantorTx)
          .to.emit(pdg, "BalanceRefunded")
          .withArgs(vaultOperator, vaultOperatorGuarantor)
          .to.emit(pdg, "GuarantorRefundAdded")
          .withArgs(vaultOperator, vaultOperator, balance)
          .to.emit(pdg, "GuarantorSet")
          .withArgs(vaultOperator, vaultOperatorGuarantor, vaultOperator);

        const [operatorBondTotalAfter] = await pdg.nodeOperatorBalance(vaultOperator);
        expect(operatorBondTotalAfter).to.equal(0n);

        // refund

        expect(await pdgNO.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperatorGuarantor);
        expect(await pdg.claimableRefund(vaultOperator)).to.equal(balance);
        const strangerBefore = await ethers.provider.getBalance(stranger);

        const refundTx = await pdgNO.claimGuarantorRefund(stranger);

        await expect(refundTx).to.emit(pdg, "GuarantorRefundClaimed").withArgs(vaultOperator, stranger, balance);
        expect(await ethers.provider.getBalance(stranger)).to.equal(strangerBefore + balance);
        expect(await pdg.claimableRefund(vaultOperator)).to.equal(0n);
      });

      it("Guarantor is refunded when returning to NO", async () => {
        const balance = ether("20");
        await pdg.connect(vaultOperator).setNodeOperatorGuarantor(vaultOperatorGuarantor);
        expect(await pdg.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperatorGuarantor);

        await pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance });

        const returnTx = pdg.setNodeOperatorGuarantor(vaultOperator);
        await expect(returnTx)
          .to.emit(pdg, "BalanceRefunded")
          .withArgs(vaultOperator, vaultOperator)
          .to.emit(pdg, "GuarantorRefundAdded")
          .withArgs(vaultOperatorGuarantor, vaultOperator, balance)
          .to.emit(pdg, "GuarantorSet")
          .withArgs(vaultOperator, vaultOperator, vaultOperatorGuarantor);

        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);
        expect(await pdg.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperator);
        expect(await pdg.claimableRefund(vaultOperatorGuarantor)).to.equal(balance);
      });
    });

    context("claimGuarantorRefund", () => {
      it("reverts on zero refund", async () => {
        expect(await pdg.claimableRefund(vaultOperator)).to.equal(0n);
        await expect(pdg.connect(vaultOperator).claimGuarantorRefund(vaultOperator)).to.be.revertedWithCustomError(
          pdg,
          "NothingToRefund",
        );
      });

      it("reverts on failed refund", async () => {
        const pdgNO = pdg.connect(vaultOperator);
        const balance = ether("1");
        await pdgNO.topUpNodeOperatorBalance(vaultOperator, { value: balance });
        await pdgNO.setNodeOperatorGuarantor(vaultOperatorGuarantor);

        await expect(pdgNO.claimGuarantorRefund(rejector)).to.be.revertedWithCustomError(pdg, "RefundFailed");
      });

      it("allows guarantor to claim refund", async () => {
        // set guarantor and top up
        const balance = ether("20");
        await pdg.connect(vaultOperator).setNodeOperatorGuarantor(vaultOperatorGuarantor);
        expect(await pdg.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperatorGuarantor);
        await pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance });

        // set different guarantor
        const returnTx = pdg.setNodeOperatorGuarantor(vaultOperator);
        await expect(returnTx)
          .to.emit(pdg, "BalanceRefunded")
          .withArgs(vaultOperator, vaultOperator)
          .to.emit(pdg, "GuarantorRefundAdded")
          .withArgs(vaultOperatorGuarantor, vaultOperator, balance)
          .to.emit(pdg, "GuarantorSet")
          .withArgs(vaultOperator, vaultOperator, vaultOperatorGuarantor);

        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);
        expect(await pdg.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperator);
        expect(await pdg.claimableRefund(vaultOperatorGuarantor)).to.equal(balance);

        // claim refund
        const balanceBefore = await ethers.provider.getBalance(stranger);
        const claimTx = await pdg.connect(vaultOperatorGuarantor).claimGuarantorRefund(stranger);
        const balanceAfter = await ethers.provider.getBalance(stranger);
        await expect(claimTx)
          .to.emit(pdg, "GuarantorRefundClaimed")
          .withArgs(vaultOperatorGuarantor, stranger, balance);
        expect(balanceAfter - balanceBefore).to.equal(balance);
      });
    });

    context("topUpNodeOperatorBalance", () => {
      it("reverts on not valid guarantor (self-guarantor)", async () => {
        const balance = ether("1");

        await expect(
          pdg.connect(stranger).topUpNodeOperatorBalance(ZeroAddress, { value: balance }),
        ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

        await expect(
          pdg.connect(stranger).topUpNodeOperatorBalance(vaultOperator, { value: balance }),
        ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

        await expect(
          pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance }),
        ).to.be.revertedWithCustomError(pdg, "NotGuarantor");
      });

      it("reverts on not valid guarantor (external guarantor)", async () => {
        const balance = ether("1");

        await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
        expect(await pdg.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperatorGuarantor);
        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);

        await expect(
          pdg.connect(vaultOperator).topUpNodeOperatorBalance(vaultOperator, { value: balance }),
        ).to.be.revertedWithCustomError(pdg, "NotGuarantor");
      });

      it("reverts on invalid top up amount", async () => {
        const balance = ether("1");

        await expect(pdg.topUpNodeOperatorBalance(vaultOperator, { value: 0n }))
          .to.be.revertedWithCustomError(pdg, "ZeroArgument")
          .withArgs("msg.value");

        await expect(pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance / 2n }))
          .to.be.revertedWithCustomError(pdg, "ValueNotMultipleOfPredepositAmount")
          .withArgs(balance / 2n);

        await expect(pdg.topUpNodeOperatorBalance(vaultOperator, { value: (balance * 3n) / 2n }))
          .to.be.revertedWithCustomError(pdg, "ValueNotMultipleOfPredepositAmount")
          .withArgs((balance * 3n) / 2n);
      });

      it("allows NO to topUpNodeOperatorBalance", async () => {
        const balance = ether("1");
        const topUpTx = await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });
        await expect(topUpTx).to.emit(pdg, "BalanceToppedUp").withArgs(vaultOperator, vaultOperator, balance);

        const [balanceTotal, balanceLocked] = await pdg.nodeOperatorBalance(vaultOperator);
        expect(balanceTotal).to.equal(balance);
        expect(balanceLocked).to.equal(0n);
        expect(await pdg.unlockedBalance(vaultOperator)).to.equal(balance);
      });

      it("allows guarantor to topUpNodeOperatorBalance", async () => {
        const balance = ether("1");

        await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
        expect(await pdg.nodeOperatorGuarantor(vaultOperator)).to.equal(vaultOperatorGuarantor);
        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);

        const topUpTx = pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance });
        await expect(topUpTx).to.emit(pdg, "BalanceToppedUp").withArgs(vaultOperator, vaultOperatorGuarantor, balance);
        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([balance, 0n]);
      });
    });

    context("withdrawNodeOperatorBalance", () => {
      const balance = ether("1");

      it("reverts on not valid guarantor (self-guarantor)", async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });

        await expect(
          pdg.connect(stranger).withdrawNodeOperatorBalance(ZeroAddress, balance, stranger),
        ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

        await expect(
          pdg.connect(stranger).withdrawNodeOperatorBalance(vaultOperator, balance, stranger),
        ).to.be.revertedWithCustomError(pdg, "NotGuarantor");
      });

      it("reverts on not valid guarantor (external guarantor)", async () => {
        await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
        await pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance });

        await expect(
          pdg.connect(vaultOperator).withdrawNodeOperatorBalance(vaultOperator, balance, stranger),
        ).to.be.revertedWithCustomError(pdg, "NotGuarantor");
      });

      it("reverts on invalid withdrawal amount", async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });

        await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, 0, stranger))
          .to.be.revertedWithCustomError(pdg, "ZeroArgument")
          .withArgs("_amount");

        await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, balance / 2n, stranger))
          .to.be.revertedWithCustomError(pdg, "ValueNotMultipleOfPredepositAmount")
          .withArgs(balance / 2n);

        await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, (balance * 3n) / 2n, stranger))
          .to.be.revertedWithCustomError(pdg, "ValueNotMultipleOfPredepositAmount")
          .withArgs((balance * 3n) / 2n);
      });

      it("reverts on invalid zero address recipient", async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });

        await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, balance, ZeroAddress))
          .to.be.revertedWithCustomError(pdg, "ZeroArgument")
          .withArgs("_recipient");
      });

      it("reverts on withdrawing locked balance", async () => {
        await stakingVault.fund({ value: ether("32") });

        await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, balance, stranger))
          .to.be.revertedWithCustomError(pdg, "NotEnoughUnlocked")
          .withArgs(0n, balance);

        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });
        await pdg.predeposit(stakingVault, [generatePredeposit(generateValidator())]);

        await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, balance, stranger))
          .to.be.revertedWithCustomError(pdg, "NotEnoughUnlocked")
          .withArgs(0n, balance);

        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance * 2n });
        await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, balance * 3n, stranger))
          .to.be.revertedWithCustomError(pdg, "NotEnoughUnlocked")
          .withArgs(balance * 2n, balance * 3n);
      });

      it("reverts when withdrawal recipient is reverting", async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });

        await expect(
          pdg.withdrawNodeOperatorBalance(vaultOperator, ether("1"), rejector),
        ).to.be.revertedWithCustomError(pdg, "WithdrawalFailed");
      });

      it("allows NO to withdrawNodeOperatorBalance", async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });
        const balanceBefore = await ethers.provider.getBalance(stranger);
        const withdrawTx = await pdg.withdrawNodeOperatorBalance(vaultOperator, balance, stranger);
        const balanceAfter = await ethers.provider.getBalance(stranger);

        await expect(withdrawTx).to.emit(pdg, "BalanceWithdrawn").withArgs(vaultOperator, stranger, balance);
        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);
        expect(balanceAfter - balanceBefore).to.equal(balance);
      });

      it("allows set guarantor to withdrawNodeOperatorBalance", async () => {
        await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
        await pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance });

        const balanceBefore = await ethers.provider.getBalance(stranger);
        const withdrawTx = pdg
          .connect(vaultOperatorGuarantor)
          .withdrawNodeOperatorBalance(vaultOperator, balance, stranger);
        await expect(withdrawTx).to.emit(pdg, "BalanceWithdrawn").withArgs(vaultOperator, stranger, balance);

        const balanceAfter = await ethers.provider.getBalance(stranger);

        expect(balanceAfter - balanceBefore).to.equal(balance);
        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);
      });
    });
  });

  context("Deposits & Proving", () => {
    context("predeposit", () => {
      it("reverts when the 'predeposit' got empty deposits", async () => {
        // NO runs predeposit for the vault without predepositData
        await expect(pdg.connect(stranger).predeposit(stakingVault, [])).to.be.revertedWithCustomError(
          pdg,
          "EmptyDeposits",
        );
      });

      it("revert when not NO tries to predeposit", async () => {
        const predeposit = generatePredeposit(generateValidator());
        await expect(pdg.connect(vaultOwner).predeposit(stakingVault, [predeposit])).to.be.revertedWithCustomError(
          pdg,
          "NotNodeOperator",
        );
        await expect(pdg.connect(stranger).predeposit(stakingVault, [predeposit])).to.be.revertedWithCustomError(
          pdg,
          "NotNodeOperator",
        );
      });

      it("reverts when using locked balance", async () => {
        const predeposit = generatePredeposit(generateValidator());
        await expect(pdg.predeposit(stakingVault, [predeposit]))
          .to.be.revertedWithCustomError(pdg, "NotEnoughUnlocked")
          .withArgs(0n, ether("1"));

        const predeposit2 = generatePredeposit(generateValidator());

        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });

        await expect(pdg.predeposit(stakingVault, [predeposit, predeposit2]))
          .to.be.revertedWithCustomError(pdg, "NotEnoughUnlocked")
          .withArgs(ether("1"), ether("2"));
      });

      it("reverts on re-use of validator", async () => {
        await stakingVault.fund({ value: ether("32") });
        const validator = generateValidator();
        const predeposit = generatePredeposit(validator);
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("3") });

        const PREDEPOSITED_STAGE = 1n;

        await pdg.predeposit(stakingVault, [predeposit]);
        const validatorStatus = await pdg.validatorStatus(validator.pubkey);
        expect(validatorStatus.stage).to.equal(PREDEPOSITED_STAGE);

        const predeposit2 = generatePredeposit(generateValidator());

        await expect(pdg.predeposit(stakingVault, [predeposit2, predeposit]))
          .to.be.revertedWithCustomError(pdg, "ValidatorNotNew")
          .withArgs(validator.pubkey, PREDEPOSITED_STAGE);
      });

      it("reverts on invalid predeposit amount", async () => {
        await stakingVault.fund({ value: ether("32") });
        const validator = generateValidator();
        const predeposit = generatePredeposit(validator);
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("3") });

        predeposit.amount = ether("2");

        await expect(pdg.predeposit(stakingVault, [predeposit]))
          .to.be.revertedWithCustomError(pdg, "PredepositAmountInvalid")
          .withArgs(validator.pubkey, predeposit.amount);
      });

      it("reverts on top up with predeposit if has guarantor", async () => {
        // Staking Vault is funded with enough ether to run validator
        await stakingVault.fund({ value: ether("32") });

        const balance = ether("1");

        await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
        await pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance });

        // NO generates validator for vault
        const vaultWC = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(vaultWC);

        // NO runs predeposit for the vault
        const predepositData = generatePredeposit(validator);
        await expect(pdg.predeposit(stakingVault, [predepositData], { value: balance })).to.revertedWithCustomError(
          pdg,
          "NotGuarantor",
        );
      });

      it("allows NO as self-guarantor to top up on predeposit", async () => {
        // Staking Vault is funded with enough ether to run validator
        await stakingVault.fund({ value: ether("32") });

        const balance = ether("1");

        // NO generates validator for vault
        const vaultWC = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(vaultWC);

        const [total, locked] = await pdg.nodeOperatorBalance(vaultOperator);
        expect(total).to.equal(0n);
        expect(locked).to.equal(0n);

        // NO runs predeposit for the vault
        const predepositData = generatePredeposit(validator);
        const predepositTX = pdg.predeposit(stakingVault, [predepositData], { value: balance });

        await expect(predepositTX).to.emit(pdg, "BalanceToppedUp").withArgs(vaultOperator, vaultOperator, balance);

        const [totalAfter, lockedAfter] = await pdg.nodeOperatorBalance(vaultOperator);
        expect(totalAfter).to.equal(balance);
        expect(lockedAfter).to.equal(balance);
      });

      it("allows to batch predeposit validators", async () => {
        const batchCount = 10n;
        const totalBalance = ether("1") * batchCount;
        await stakingVault.fund({ value: ether("1") * batchCount });
        const vaultWC = await stakingVault.withdrawalCredentials();

        const validators = Array.from({ length: Number(batchCount) }, () => generateValidator(vaultWC));
        const predeposits = validators.map((validator) => generatePredeposit(validator));

        const predepositTX = await pdg.predeposit(stakingVault, predeposits, { value: totalBalance });

        await Promise.all(
          validators.map(async (validator) => {
            await expect(predepositTX)
              .to.emit(pdg, "ValidatorPreDeposited")
              .withArgs(validator.pubkey, vaultOperator, stakingVault, vaultWC);
            const validatorStatus = await pdg.validatorStatus(validator.pubkey);
            expect(validatorStatus.stage).to.equal(1n);
            expect(validatorStatus.nodeOperator).to.equal(vaultOperator);
            expect(validatorStatus.stakingVault).to.equal(stakingVault);
          }),
        );

        await expect(predepositTX)
          .to.emit(pdg, "BalanceLocked")
          .withArgs(vaultOperator, totalBalance, totalBalance)
          .to.emit(stakingVault, "DepositedToBeaconChain")
          .withArgs(pdg, batchCount, totalBalance);

        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([totalBalance, totalBalance]);
        expect(await pdg.unlockedBalance(vaultOperator)).to.equal(0n);
      });
    });

    context("invalid WC vault", () => {
      it("reverts when vault has WC with wrong version", async () => {
        let wc = await wcMockStakingVault.withdrawalCredentials();
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("200") });

        const min = await pdg.MIN_SUPPORTED_WC_VERSION();
        const max = await pdg.MAX_SUPPORTED_WC_VERSION();

        expect(min).to.equal(1n);
        expect(max).to.equal(2n);

        for (let version = 0n; version < 5n; version++) {
          wc = `0x0${version.toString()}` + wc.slice(4);
          const predeposit = generatePredeposit(generateValidator(wc));
          await wcMockStakingVault.mock__setWithdrawalCredentials(wc);

          const shouldRevert = version < min || version > max;

          if (shouldRevert) {
            await expect(pdg.predeposit(wcMockStakingVault, [predeposit]))
              .to.be.revertedWithCustomError(pdg, "WithdrawalCredentialsInvalidVersion")
              .withArgs(version);
          } else {
            await pdg.predeposit(wcMockStakingVault, [predeposit]);
          }
        }
      });

      it("reverts when WC are misformed", async () => {
        let wc = await wcMockStakingVault.withdrawalCredentials();
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("200") });
        wc = wc.slice(0, 4) + "ff" + wc.slice(6);
        await wcMockStakingVault.mock__setWithdrawalCredentials(wc);
        const predeposit = generatePredeposit(generateValidator(wc));
        await expect(pdg.predeposit(wcMockStakingVault, [predeposit]))
          .to.be.revertedWithCustomError(pdg, "WithdrawalCredentialsMisformed")
          .withArgs(wc);
      });

      it("reverts when WC do not belong to the vault", async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("200") });
        await wcMockStakingVault.mock__setWithdrawalCredentials(addressToWC(stranger.address));
        const wc = await wcMockStakingVault.withdrawalCredentials();
        const predeposit = generatePredeposit(generateValidator(wc));
        await expect(pdg.predeposit(wcMockStakingVault, [predeposit]))
          .to.be.revertedWithCustomError(pdg, "WithdrawalCredentialsMismatch")
          .withArgs(await wcMockStakingVault.getAddress(), stranger.address);
      });
    });

    context("proveValidatorWC", () => {
      it("reverts on proving not predeposited validator", async () => {
        const balance = ether("200");
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });
        await stakingVault.fund({ value: balance });

        const wc = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(wc);
        await sszMerkleTree.addValidatorLeaf(validator);
        const validatorIndex = 1n;
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);
        const proof = [
          ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(validator)).proof,
          ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + validatorIndex)),
          ...beaconProof,
        ];

        const witness = {
          validatorIndex,
          pubkey: validator.pubkey,
          proof,
          childBlockTimestamp,
        };

        // stage NONE
        await expect(pdg.proveValidatorWC(witness))
          .to.be.revertedWithCustomError(pdg, "ValidatorNotPreDeposited")
          .withArgs(validator.pubkey, 0n);

        // stage PREDEPOSITED
        await pdg.predeposit(stakingVault, [generatePredeposit(validator)]);

        const proveTx = await pdg.proveValidatorWC(witness);
        await expect(proveTx)
          .to.emit(pdg, "BalanceUnlocked")
          .withArgs(vaultOperator.address, balance, 0)
          .to.emit(pdg, "ValidatorProven")
          .withArgs(validator.pubkey, vaultOperator.address, await stakingVault.getAddress(), wc);

        expect((await pdg.validatorStatus(validator.pubkey)).stage).to.equal(2n);

        // stage PROVEN
        await expect(pdg.proveValidatorWC(witness))
          .to.be.revertedWithCustomError(pdg, "ValidatorNotPreDeposited")
          .withArgs(validator.pubkey, 2n);
      });

      it("allows NO to proveValidatorWC", async () => {
        // guarantor funds PDG for operator
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });

        // Staking Vault is funded with enough ether to run validator
        await stakingVault.fund({ value: ether("32") });
        expect(await stakingVault.valuation()).to.equal(ether("32"));

        // NO generates validator for vault
        const vaultWC = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(vaultWC);

        // NO runs predeposit for the vault
        const predepositData = generatePredeposit(validator);
        await pdg.predeposit(stakingVault, [predepositData]);

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
        const witness = {
          pubkey: validator.pubkey,
          validatorIndex,
          childBlockTimestamp,
          proof: concatenatedProof,
        };

        const proveValidatorWCTX = pdg.connect(vaultOwner).proveValidatorWC(witness);

        await expect(proveValidatorWCTX)
          .to.emit(pdg, "BalanceUnlocked")
          .withArgs(vaultOperator, ether("1"), ether("0"))
          .to.emit(pdg, "ValidatorProven")
          .withArgs(validator.pubkey, vaultOperator, stakingVault, vaultWC);

        const validatorStatus = await pdg.validatorStatus(validator.pubkey);
        expect(validatorStatus.stage).to.equal(2n);
        expect(validatorStatus.stakingVault).to.equal(stakingVault);
        expect(validatorStatus.nodeOperator).to.equal(vaultOperator);
      });
    });

    context("depositToBeaconChain", () => {
      it("reverts for not PROVEN validator", async () => {
        const validator = generateValidator();
        const predeposit = generatePredeposit(validator);

        await expect(pdg.depositToBeaconChain(stakingVault, [predeposit])).to.be.revertedWithCustomError(
          pdg,
          "DepositToUnprovenValidator",
        );
      });

      it("reverts for stranger to deposit", async () => {
        const validator = generateValidator();
        const predeposit = generatePredeposit(validator);

        await expect(
          pdg.connect(stranger).depositToBeaconChain(stakingVault, [predeposit]),
        ).to.be.revertedWithCustomError(pdg, "NotNodeOperator");
      });

      it("reverts to deposit someone else validators", async () => {
        const sideStakingVault = await deployStakingVault(stranger, stranger, vaultHub);
        const sameNOVault = await deployStakingVault(stranger, vaultOperator, vaultHub);
        const sideValidator = generateValidator(await sideStakingVault.withdrawalCredentials());
        const mainValidator = generateValidator(await stakingVault.withdrawalCredentials());
        const sameNOValidator = generateValidator(await sameNOVault.withdrawalCredentials());

        // top up pdg
        await pdg.connect(stranger).topUpNodeOperatorBalance(stranger, { value: ether("20") });
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("20") });

        // top up vaults
        await stakingVault.fund({ value: ether("320") });
        await sideStakingVault.fund({ value: ether("320") });
        await sameNOVault.fund({ value: ether("320") });

        // predeposit both validators
        await pdg.predeposit(stakingVault, [generatePredeposit(mainValidator)]);
        await pdg.predeposit(sameNOVault, [generatePredeposit(sameNOValidator)]);
        await pdg.connect(stranger).predeposit(sideStakingVault, [generatePredeposit(sideValidator)]);

        // add them to CL
        await sszMerkleTree.addValidatorLeaf(mainValidator);
        const mainValidatorIndex = 1n;
        await sszMerkleTree.addValidatorLeaf(sideValidator);
        const sideValidatorIndex = 2n;
        await sszMerkleTree.addValidatorLeaf(sameNOValidator);
        const sameNoValidatorIndex = 3n;
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);

        // Collect proofs
        const mainValidatorProof = await sszMerkleTree.getValidatorPubkeyWCParentProof(mainValidator);
        const mainStateProof = await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + mainValidatorIndex);
        const mainProof = [...mainValidatorProof.proof, ...mainStateProof, ...beaconProof];

        const sideValidatorProof = await sszMerkleTree.getValidatorPubkeyWCParentProof(sideValidator);
        const sideStateProof = await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + sideValidatorIndex);
        const sideProof = [...sideValidatorProof.proof, ...sideStateProof, ...beaconProof];

        const sameNoValidatorProof = await sszMerkleTree.getValidatorPubkeyWCParentProof(sameNOValidator);
        const sameNoStateProof = await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + sameNoValidatorIndex);
        const sameNoProof = [...sameNoValidatorProof.proof, ...sameNoStateProof, ...beaconProof];

        // prove
        await pdg.proveValidatorWC({
          proof: mainProof,
          pubkey: mainValidator.pubkey,
          validatorIndex: mainValidatorIndex,
          childBlockTimestamp: childBlockTimestamp,
        });

        await pdg.proveValidatorWC({
          proof: sideProof,
          pubkey: sideValidator.pubkey,
          validatorIndex: sideValidatorIndex,
          childBlockTimestamp: childBlockTimestamp,
        });

        await pdg.proveValidatorWC({
          proof: sameNoProof,
          pubkey: sameNOValidator.pubkey,
          validatorIndex: sameNoValidatorIndex,
          childBlockTimestamp: childBlockTimestamp,
        });

        expect((await pdg.validatorStatus(mainValidator.pubkey)).stage).to.deep.equal(2n);
        expect((await pdg.validatorStatus(sideValidator.pubkey)).stage).to.deep.equal(2n);
        expect((await pdg.validatorStatus(sameNOValidator.pubkey)).stage).to.deep.equal(2n);

        const mainDeposit = generatePostDeposit(mainValidator, ether("31"));
        const sideDeposit = generatePostDeposit(sideValidator, ether("31"));
        const sameNoDeposit = generatePostDeposit(sameNOValidator, ether("31"));

        await expect(pdg.depositToBeaconChain(stakingVault, [mainDeposit, sideDeposit])).to.be.revertedWithCustomError(
          pdg,
          "NotNodeOperator",
        );

        await expect(pdg.depositToBeaconChain(stakingVault, [mainDeposit, sameNoDeposit]))
          .to.be.revertedWithCustomError(pdg, "DepositToWrongVault")
          .withArgs(sameNoDeposit.pubkey, stakingVault);
      });
    });

    context("proveUnknownValidator", () => {
      it("revert the proveUnknownValidator if it was called by not StakingVault Owner", async () => {
        let witness = { validatorIndex: 1n, childBlockTimestamp: 1n, pubkey: "0x00", proof: [] };
        await expect(pdg.connect(stranger).proveUnknownValidator(witness, stakingVault)).to.be.revertedWithCustomError(
          pdg,
          "NotStakingVaultOwner",
        );

        await expect(
          pdg.connect(vaultOwner).proveUnknownValidator(witness, stakingVault),
        ).to.be.revertedWithCustomError(pdg, "InvalidPubkeyLength");

        witness = {
          validatorIndex: 1n,
          childBlockTimestamp: 1n,
          pubkey: hexlify(generateValidator().pubkey),
          proof: [],
        };

        await expect(
          pdg.connect(vaultOwner).proveUnknownValidator(witness, stakingVault),
        ).to.be.revertedWithCustomError(pdg, "RootNotFound");
      });

      it("can use PDG with proveUnknownValidator", async () => {
        const vaultWC = await stakingVault.withdrawalCredentials();
        const unknownValidator = generateValidator(vaultWC);

        // Validator is added to CL merkle tree
        await sszMerkleTree.addValidatorLeaf(unknownValidator);
        const validatorLeafIndex = firstValidatorLeafIndex + 1n;
        const validatorIndex = 1n;

        // Beacon Block is generated with new CL state
        const stateRoot = await sszMerkleTree.getMerkleRoot();
        const beaconBlockHeader = generateBeaconHeader(stateRoot);
        const beaconBlockMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);

        /// Beacon Block root is posted to EL
        const childBlockTimestamp = await setBeaconBlockRoot(beaconBlockMerkle.root);

        // NO collects validator proof
        const validatorMerkle = await sszMerkleTree.getValidatorPubkeyWCParentProof(unknownValidator);
        const stateProof = await sszMerkleTree.getMerkleProof(validatorLeafIndex);
        const concatenatedProof = [...validatorMerkle.proof, ...stateProof, ...beaconBlockMerkle.proof];

        let validatorStatusTx = await pdg.validatorStatus(unknownValidator.pubkey);
        // ValidatorStatus.stage
        expect(validatorStatusTx[0]).to.equal(0n); // 0n is NONE

        const witness = {
          pubkey: unknownValidator.pubkey,
          validatorIndex,
          childBlockTimestamp,
          proof: concatenatedProof,
        };

        const proveUnknownValidatorTx = await pdg.connect(vaultOwner).proveUnknownValidator(witness, stakingVault);

        await expect(proveUnknownValidatorTx)
          .to.emit(pdg, "ValidatorProven")
          .withArgs(unknownValidator.pubkey, vaultOperator, stakingVault, vaultWC);

        validatorStatusTx = await pdg.validatorStatus(unknownValidator.pubkey);
        // ValidatorStatus.stage
        expect(validatorStatusTx[0]).to.equal(2n); // 2n is PROVEN

        // revert ValidatorNotNew
        await expect(
          pdg.connect(vaultOwner).proveUnknownValidator(witness, stakingVault),
        ).to.be.revertedWithCustomError(pdg, "ValidatorNotNew");
      });
    });

    context("proveInvalidValidatorWC", () => {
      let invalidWC: string;
      let invalidValidator: SSZHelpers.ValidatorStruct;
      let invalidValidatorWitness: CLProofVerifier.ValidatorWitnessStruct;

      let validWC: string;
      let validValidator: SSZHelpers.ValidatorStruct;
      let validValidatorWitness: CLProofVerifier.ValidatorWitnessStruct;

      let validNotPredepostedValidator: SSZHelpers.ValidatorStruct;
      let validNotPredepostedValidatorWitness: CLProofVerifier.ValidatorWitnessStruct;

      beforeEach(async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("20") });

        // Staking Vault is funded with enough ether to run validator
        await stakingVault.fund({ value: ether("32") });

        // Generate a validator
        invalidWC = addressToWC(await stakingVault.nodeOperator()); // vaultOperator is same
        validWC = await stakingVault.withdrawalCredentials();

        invalidValidator = generateValidator(invalidWC);
        validValidator = generateValidator(validWC);
        validNotPredepostedValidator = generateValidator(validWC);

        await pdg.predeposit(stakingVault, [generatePredeposit(invalidValidator), generatePredeposit(validValidator)]);

        await sszMerkleTree.addValidatorLeaf(invalidValidator);
        await sszMerkleTree.addValidatorLeaf(validValidator);
        await sszMerkleTree.addValidatorLeaf(validNotPredepostedValidator);
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);

        invalidValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 1n,
          pubkey: invalidValidator.pubkey,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(invalidValidator)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 1n)),
            ...beaconProof,
          ],
        };

        validValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 2n,
          pubkey: validValidator.pubkey,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(validValidator)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 2n)),
            ...beaconProof,
          ],
        };

        validNotPredepostedValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 3n,
          pubkey: validNotPredepostedValidator.pubkey,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(validNotPredepostedValidator)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 3n)),
            ...beaconProof,
          ],
        };
      });

      it("reverts when trying to prove validator that is not predeposited ", async () => {
        // Not predeposited
        await expect(pdg.connect(vaultOperator).proveInvalidValidatorWC(validNotPredepostedValidatorWitness, validWC))
          .to.revertedWithCustomError(pdg, "ValidatorNotPreDeposited")
          .withArgs(validNotPredepostedValidator.pubkey, 0n);

        // predepsit
        await pdg.predeposit(stakingVault, [generatePredeposit(validNotPredepostedValidator)]);

        // Predeposited but it's valid
        await expect(
          pdg.connect(vaultOperator).proveInvalidValidatorWC(validNotPredepostedValidatorWitness, validWC),
        ).to.revertedWithCustomError(pdg, "WithdrawalCredentialsMatch");

        // proving
        await pdg.proveValidatorWC(validNotPredepostedValidatorWitness);
        await expect(pdg.connect(vaultOperator).proveInvalidValidatorWC(validNotPredepostedValidatorWitness, validWC))
          .to.revertedWithCustomError(pdg, "ValidatorNotPreDeposited")
          .withArgs(validNotPredepostedValidator.pubkey, 2n);
      });

      it("reverts when trying to prove valid validator", async () => {
        await expect(
          pdg.connect(vaultOperator).proveInvalidValidatorWC(validValidatorWitness, validWC),
        ).to.revertedWithCustomError(pdg, "WithdrawalCredentialsMatch");
      });

      it("allows to prove validator as invalid", async () => {
        // predeposted
        expect((await pdg.validatorStatus(invalidValidator.pubkey)).stage).to.equal(1n);
        const [total, locked] = await pdg.nodeOperatorBalance(vaultOperator);

        const proveInvalidTX = await pdg.connect(stranger).proveInvalidValidatorWC(invalidValidatorWitness, invalidWC);
        await expect(proveInvalidTX)
          .to.emit(pdg, "ValidatorDisproven")
          .withArgs(invalidValidator.pubkey, vaultOperator, stakingVault, invalidWC);

        const [totalAfter, lockedAfter] = await pdg.nodeOperatorBalance(vaultOperator);
        expect(totalAfter).to.equal(total);
        expect(lockedAfter).to.equal(locked);

        // disproven
        expect((await pdg.validatorStatus(invalidValidator.pubkey)).stage).to.equal(3n);
      });
    });

    context("compensateDisprovenPredeposit", () => {
      let invalidWC: string;
      let invalidValidator: SSZHelpers.ValidatorStruct;

      let validWC: string;
      let validValidator: SSZHelpers.ValidatorStruct;

      beforeEach(async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("20") });

        // Staking Vault is funded with enough ether to run validator
        await stakingVault.fund({ value: ether("32") });

        // Generate a validator
        invalidWC = addressToWC(await stakingVault.nodeOperator()); // vaultOperator is same
        validWC = await stakingVault.withdrawalCredentials();

        invalidValidator = generateValidator(invalidWC);
        validValidator = generateValidator(validWC);

        await pdg.predeposit(stakingVault, [generatePredeposit(invalidValidator), generatePredeposit(validValidator)]);

        await sszMerkleTree.addValidatorLeaf(invalidValidator);
        await sszMerkleTree.addValidatorLeaf(validValidator);
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);

        const invalidValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 1n,
          pubkey: invalidValidator.pubkey,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(invalidValidator)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 1n)),
            ...beaconProof,
          ],
        };

        const validValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 2n,
          pubkey: validValidator.pubkey,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(validValidator)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 2n)),
            ...beaconProof,
          ],
        };

        await pdg.proveInvalidValidatorWC(invalidValidatorWitness, invalidWC);
        await pdg.proveValidatorWC(validValidatorWitness);
      });

      it("reverts if _recipient is zero address", async () => {
        await expect(pdg.connect(vaultOwner).compensateDisprovenPredeposit(invalidValidator.pubkey, ZeroAddress))
          .to.be.revertedWithCustomError(pdg, "ZeroArgument")
          .withArgs("_recipient");
      });

      it("reverts if trying to compensate directly to vault", async () => {
        await expect(
          pdg
            .connect(vaultOwner)
            .compensateDisprovenPredeposit(invalidValidator.pubkey, await stakingVault.getAddress()),
        ).to.be.revertedWithCustomError(pdg, "CompensateToVaultNotAllowed");
      });

      it("reverts if trying to compensate when not staking vault owner", async () => {
        await expect(
          pdg.connect(stranger).compensateDisprovenPredeposit(invalidValidator.pubkey, vaultOperator.address),
        ).to.be.revertedWithCustomError(pdg, "NotStakingVaultOwner");
      });

      it("reverts if trying to compensate not disproven validator", async () => {
        await expect(
          pdg.connect(vaultOwner).compensateDisprovenPredeposit(validValidator.pubkey, vaultOperator.address),
        ).to.be.revertedWithCustomError(pdg, "ValidatorNotDisproven");

        await expect(
          pdg.connect(vaultOwner).compensateDisprovenPredeposit(generateValidator().pubkey, vaultOperator.address),
        ).to.be.revertedWithCustomError(pdg, "ValidatorNotDisproven");
      });

      it("reverts if compensation is rejected", async () => {
        await expect(
          pdg.connect(vaultOwner).compensateDisprovenPredeposit(invalidValidator.pubkey, rejector),
        ).to.revertedWithCustomError(pdg, "CompensateFailed");
      });

      it("allows to compensate disproven validator", async () => {
        const PREDEPOSIT_AMOUNT = await pdg.PREDEPOSIT_AMOUNT();
        const [balanceTotal, balanceLocked] = await pdg.nodeOperatorBalance(vaultOperator.address);

        let validatorStatus = await pdg.validatorStatus(invalidValidator.pubkey);
        expect(validatorStatus.stage).to.equal(3n); // 3n is DISPROVEN
        expect(validatorStatus.stakingVault).to.equal(stakingVault);
        expect(validatorStatus.nodeOperator).to.equal(vaultOperator.address);

        // Call compensateDisprovenPredeposit and expect it to succeed
        const compensateDisprovenPredepositTx = pdg
          .connect(vaultOwner)
          .compensateDisprovenPredeposit(invalidValidator.pubkey, vaultOperator.address);

        await expect(compensateDisprovenPredepositTx)
          .to.emit(pdg, "BalanceCompensated")
          .withArgs(
            vaultOperator.address,
            vaultOperator.address,
            balanceTotal - PREDEPOSIT_AMOUNT,
            balanceLocked - PREDEPOSIT_AMOUNT,
          )
          .to.emit(pdg, "ValidatorCompensated")
          .withArgs(
            invalidValidator.pubkey,
            vaultOperator.address,
            await stakingVault.getAddress(),
            vaultOperator.address,
          );

        await expect(compensateDisprovenPredepositTx).to.be.ok;

        // Check that the locked balance of the node operator has been reduced
        const nodeOperatorBalance = await pdg.nodeOperatorBalance(vaultOperator.address);
        expect(nodeOperatorBalance.total).to.equal(balanceTotal - PREDEPOSIT_AMOUNT);
        expect(nodeOperatorBalance.locked).to.equal(balanceLocked - PREDEPOSIT_AMOUNT);

        validatorStatus = await pdg.validatorStatus(invalidValidator.pubkey);
        expect(validatorStatus.stage).to.equal(4n); // 4n is COMPENSATED
      });
    });
  });

  context("Pausing", () => {
    it("should pause core methods", async () => {
      // Roles
      await pdg.connect(admin).grantRole(await pdg.PAUSE_ROLE(), pauser);
      await pdg.connect(admin).grantRole(await pdg.RESUME_ROLE(), pauser);
      const infinitePause = await pdg.PAUSE_INFINITELY();

      // Pause state
      const pauseTX = await pdg.connect(pauser).pauseFor(infinitePause);
      await expect(pauseTX).to.emit(pdg, "Paused").withArgs(infinitePause);
      expect(await pdg.isPaused()).to.be.true;

      // Paused Methods
      await expect(pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("1") })).to.revertedWithCustomError(
        pdg,
        "ResumedExpected",
      );
      await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, 1n, vaultOperator)).to.revertedWithCustomError(
        pdg,
        "ResumedExpected",
      );

      await expect(pdg.setNodeOperatorGuarantor(vaultOperator)).to.revertedWithCustomError(pdg, "ResumedExpected");
      await expect(pdg.claimGuarantorRefund(vaultOperator)).to.revertedWithCustomError(pdg, "ResumedExpected");

      const witness = { validatorIndex: 1n, childBlockTimestamp: 1n, pubkey: "0x00", proof: [] };

      await expect(pdg.predeposit(stakingVault, [])).to.revertedWithCustomError(pdg, "ResumedExpected");
      await expect(pdg.proveValidatorWC(witness)).to.revertedWithCustomError(pdg, "ResumedExpected");
      await expect(pdg.depositToBeaconChain(stakingVault, [])).to.revertedWithCustomError(pdg, "ResumedExpected");
      await expect(pdg.proveAndDeposit([], [], stakingVault)).to.revertedWithCustomError(pdg, "ResumedExpected");

      await expect(pdg.proveUnknownValidator(witness, stakingVault)).to.revertedWithCustomError(pdg, "ResumedExpected");

      await expect(pdg.proveInvalidValidatorWC(witness, randomBytes32())).to.revertedWithCustomError(
        pdg,
        "ResumedExpected",
      );
      await expect(pdg.compensateDisprovenPredeposit("0x00", stakingVault)).to.revertedWithCustomError(
        pdg,
        "ResumedExpected",
      );

      // Resume state
      const resumeTx = pdg.connect(pauser).resume();
      await expect(resumeTx).to.emit(pdg, "Resumed");
      expect(await pdg.isPaused()).to.be.false;
    });
  });
});
