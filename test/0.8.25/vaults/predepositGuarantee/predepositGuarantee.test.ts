import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  EthRejector,
  LidoLocator,
  OssifiableProxy,
  PredepositGuarantee,
  SSZMerkleTree,
  StakingVault__MockForPDG,
} from "typechain-types";
import { IPredepositGuarantee } from "typechain-types/contracts/0.8.25/vaults/interfaces/IPredepositGuarantee";

import {
  addressToWC,
  certainAddress,
  ether,
  generateBeaconHeader,
  generatePredeposit,
  generateTopUp,
  generateValidator,
  GENESIS_FORK_VERSION,
  prepareLocalMerkleTree,
  randomBytes32,
  setBeaconBlockRoot,
  Validator,
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
  let sszMerkleTree: SSZMerkleTree;
  let stakingVault: StakingVault__MockForPDG;
  let rejector: EthRejector;

  let firstValidatorLeafIndex: bigint;

  let originalState: string;

  before(async () => {
    [deployer, admin, vaultOwner, vaultOperator, vaultOperatorGuarantor, pauser, stranger] = await ethers.getSigners();

    // local merkle tree with 1st validator
    const localMerkle = await prepareLocalMerkleTree();
    sszMerkleTree = localMerkle.sszMerkleTree;
    firstValidatorLeafIndex = localMerkle.firstValidatorLeafIndex;

    // eth rejector
    rejector = await ethers.deployContract("EthRejector");

    // PDG
    pdgImpl = await ethers.deployContract(
      "PredepositGuarantee",
      [GENESIS_FORK_VERSION, localMerkle.gIFirstValidator, localMerkle.gIFirstValidator, 0],
      { from: deployer },
    );
    proxy = await ethers.deployContract("OssifiableProxy", [pdgImpl, admin, new Uint8Array()], admin);
    pdg = await ethers.getContractAt("PredepositGuarantee", proxy, vaultOperator);

    // PDG init
    const initTX = await pdg.initialize(admin);
    await expect(initTX).to.be.emit(pdg, "Initialized").withArgs(1);

    // staking vault
    stakingVault = await ethers.deployContract("StakingVault__MockForPDG", [vaultOwner, vaultOperator, pdg]);

    // PDG dependents
    locator = await deployLidoLocator({ predepositGuarantee: pdg });
    expect(await locator.predepositGuarantee()).to.equal(await pdg.getAddress());
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
      expect(await stakingVault.availableBalance()).to.equal(ether("32"));

      // NO generates validator for vault
      const vaultWC = await stakingVault.withdrawalCredentials();
      const validator = generateValidator(vaultWC);

      // NO runs predeposit for the vault
      const { deposit, depositY } = await generatePredeposit(validator);

      await expect(pdg.predeposit(stakingVault, [deposit], [depositY]))
        .to.emit(pdg, "ValidatorPreDeposited")
        .withArgs(deposit.pubkey, vaultOperator, stakingVault, vaultWC)
        .to.emit(stakingVault, "Mock_depositToBeaconChain")
        .withArgs(pdg, deposit.amount);

      [operatorBondTotal, operatorBondLocked] = await pdg.nodeOperatorBalance(vaultOperator);
      expect(operatorBondTotal).to.equal(ether("1"));
      expect(operatorBondLocked).to.equal(ether("1"));

      // Validator is added to CL merkle tree
      await sszMerkleTree.addValidatorLeaf(validator.container);
      const validatorLeafIndex = firstValidatorLeafIndex + 1n;
      const validatorIndex = 1n;

      // Beacon Block is generated with new CL state
      const stateRoot = await sszMerkleTree.getMerkleRoot();
      const beaconBlockHeader = generateBeaconHeader(stateRoot);
      const beaconBlockMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);

      /// Beacon Block root is posted to EL
      const childBlockTimestamp = await setBeaconBlockRoot(beaconBlockMerkle.root);

      // NO collects validator proof
      const validatorMerkle = await sszMerkleTree.getValidatorPubkeyWCParentProof(validator.container);
      const stateProof = await sszMerkleTree.getMerkleProof(validatorLeafIndex);
      const concatenatedProof = [...validatorMerkle.proof, ...stateProof, ...beaconBlockMerkle.proof];

      // NO posts proof and triggers deposit to total of 32 ether
      const proveAndDepositTx = pdg.proveWCActivateAndTopUpValidators(
        [
          {
            pubkey: validator.container.pubkey,
            validatorIndex,
            childBlockTimestamp,
            proposerIndex: beaconBlockHeader.proposerIndex,
            slot: beaconBlockHeader.slot,
            proof: concatenatedProof,
          },
        ],
        [ether("31")],
      );

      await expect(proveAndDepositTx)
        .to.emit(pdg, "ValidatorProven")
        .withArgs(validator.container.pubkey, vaultOperator, stakingVault, vaultWC)
        .to.emit(stakingVault, "Mock_depositFromStaged")
        .withArgs(pdg, ether("62"));

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
        const validator = generateValidator(await stakingVault.withdrawalCredentials());
        const predeposit = await generatePredeposit(validator);
        await pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY], { value: ether("1") });

        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([ether("1"), ether("1")]);

        await expect(pdg.connect(vaultOperator).setNodeOperatorGuarantor(vaultOperatorGuarantor))
          .to.be.revertedWithCustomError(pdg, "LockedIsNotZero")
          .withArgs(ether("1"));
      });

      it("reverts when calling predeposit with invalid depositY length", async () => {
        await stakingVault.fund({ value: ether("32") });
        const validator = generateValidator(await stakingVault.withdrawalCredentials());
        const predeposit = await generatePredeposit(validator);
        await expect(
          pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY, predeposit.depositY]),
        ).to.be.revertedWithCustomError(pdg, "InvalidDepositYLength");
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
          .withArgs(vaultOperator, vaultOperator)
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
          .withArgs(vaultOperator, vaultOperatorGuarantor)
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
          .withArgs(vaultOperator, vaultOperatorGuarantor)
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
        const predeposit = await generatePredeposit(generateValidator(await stakingVault.withdrawalCredentials()));
        await pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]);

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
        await expect(pdg.connect(stranger).predeposit(stakingVault, [], [])).to.be.revertedWithCustomError(
          pdg,
          "EmptyDeposits",
        );
      });

      it("revert when not NO tries to predeposit", async () => {
        const { deposit, depositY } = await generatePredeposit(
          generateValidator(await stakingVault.withdrawalCredentials()),
        );
        await expect(
          pdg.connect(vaultOwner).predeposit(stakingVault, [deposit], [depositY]),
        ).to.be.revertedWithCustomError(pdg, "NotDepositor");
        await expect(
          pdg.connect(stranger).predeposit(stakingVault, [deposit], [depositY]),
        ).to.be.revertedWithCustomError(pdg, "NotDepositor");
      });

      it("reverts when using locked balance", async () => {
        const wc = await stakingVault.withdrawalCredentials();
        const predeposit = await generatePredeposit(generateValidator(wc));
        await expect(pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]))
          .to.be.revertedWithCustomError(pdg, "NotEnoughUnlocked")
          .withArgs(0n, ether("1"));

        const predeposit2 = await generatePredeposit(generateValidator(wc));

        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });

        await expect(
          pdg.predeposit(
            stakingVault,
            [predeposit.deposit, predeposit2.deposit],
            [predeposit.depositY, predeposit2.depositY],
          ),
        )
          .to.be.revertedWithCustomError(pdg, "NotEnoughUnlocked")
          .withArgs(ether("1"), ether("2"));
      });

      it("reverts on re-use of validator", async () => {
        await stakingVault.fund({ value: ether("32") });
        const wc = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(wc);
        const predeposit = await generatePredeposit(validator);
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("3") });

        const PREDEPOSITED_STAGE = 1n;

        await pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]);
        const validatorStatus = await pdg.validatorStatus(validator.container.pubkey);
        expect(validatorStatus.stage).to.equal(PREDEPOSITED_STAGE);

        const predeposit2 = await generatePredeposit(generateValidator(wc));

        await expect(
          pdg.predeposit(
            stakingVault,
            [predeposit2.deposit, predeposit.deposit],
            [predeposit2.depositY, predeposit.depositY],
          ),
        )
          .to.be.revertedWithCustomError(pdg, "ValidatorNotNew")
          .withArgs(validator.container.pubkey, PREDEPOSITED_STAGE);
      });

      it("reverts on invalid predeposit amount", async () => {
        await stakingVault.fund({ value: ether("32") });
        const wc = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(wc);
        const predeposit = await generatePredeposit(validator, { overrideAmount: ether("2") });
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("3") });

        await expect(pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]))
          .to.be.revertedWithCustomError(pdg, "PredepositAmountInvalid")
          .withArgs(validator.container.pubkey, predeposit.deposit.amount);
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
        const predepositData = await generatePredeposit(validator);
        await expect(
          pdg.predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY], { value: balance }),
        ).to.revertedWithCustomError(pdg, "NotGuarantor");
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
        const predeposit = await generatePredeposit(validator);
        const predepositTX = pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY], {
          value: balance,
        });

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
        const predeposits = await Promise.all(validators.map((validator) => generatePredeposit(validator)));

        const predepositTX = await pdg.predeposit(
          stakingVault,
          predeposits.map((p) => p.deposit),
          predeposits.map((p) => p.depositY),
          { value: totalBalance },
        );

        await Promise.all(
          validators.map(async (validator) => {
            await expect(predepositTX)
              .to.emit(pdg, "ValidatorPreDeposited")
              .withArgs(validator.container.pubkey, vaultOperator, stakingVault, vaultWC);
            const validatorStatus = await pdg.validatorStatus(validator.container.pubkey);
            expect(validatorStatus.stage).to.equal(1n);
            expect(validatorStatus.nodeOperator).to.equal(vaultOperator);
            expect(validatorStatus.stakingVault).to.equal(stakingVault);
          }),
        );

        await expect(predepositTX).to.emit(pdg, "BalanceLocked").withArgs(vaultOperator, totalBalance, totalBalance);

        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([totalBalance, totalBalance]);
        expect(await pdg.unlockedBalance(vaultOperator)).to.equal(0n);
      });
    });

    context("invalid WC vault", () => {
      it("reverts when vault has WC with wrong version", async () => {
        let wc = await stakingVault.withdrawalCredentials();
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("200") });

        const min = await pdg.MIN_SUPPORTED_WC_VERSION();
        const max = await pdg.MAX_SUPPORTED_WC_VERSION();

        expect(min).to.equal(1n);
        expect(max).to.equal(2n);

        for (let version = 0n; version < 5n; version++) {
          wc = `0x0${version.toString()}` + wc.slice(4);
          const predeposit = await generatePredeposit(generateValidator(wc));
          await stakingVault.mock__setWithdrawalCredentials(wc);

          const shouldRevert = version < min || version > max;

          if (shouldRevert) {
            await expect(pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]))
              .to.be.revertedWithCustomError(pdg, "WithdrawalCredentialsInvalidVersion")
              .withArgs(version);
          } else {
            await pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]);
          }
        }
      });

      it("reverts when WC are misformed", async () => {
        let wc = await stakingVault.withdrawalCredentials();
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("200") });
        wc = wc.slice(0, 4) + "ff" + wc.slice(6);
        await stakingVault.mock__setWithdrawalCredentials(wc);
        const predeposit = await generatePredeposit(generateValidator(wc));
        await expect(pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]))
          .to.be.revertedWithCustomError(pdg, "WithdrawalCredentialsMisformed")
          .withArgs(wc);
      });

      it("reverts when WC do not belong to the vault", async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("200") });
        await stakingVault.mock__setWithdrawalCredentials(addressToWC(stranger.address));
        const wc = await stakingVault.withdrawalCredentials();
        const predeposit = await generatePredeposit(generateValidator(wc));
        await expect(pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]))
          .to.be.revertedWithCustomError(pdg, "WithdrawalCredentialsMismatch")
          .withArgs(await stakingVault.getAddress(), stranger.address);
      });
    });

    context("validatePubKeyWCProof", () => {
      it("revert if deposit proof is invalid", async () => {
        const wc = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(wc);
        await sszMerkleTree.addValidatorLeaf(validator.container);
        const childBlockTimestamp = await setBeaconBlockRoot(await sszMerkleTree.getMerkleRoot());
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());

        await expect(
          pdg.validatePubKeyWCProof(
            {
              slot: beaconHeader.slot,
              pubkey: validator.container.pubkey,
              validatorIndex: 0n,
              proof: [],
              childBlockTimestamp,
              proposerIndex: beaconHeader.proposerIndex,
            },
            wc,
          ),
        ).to.be.reverted;
      });

      it("should not revert on valid proof", async () => {
        const wc = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(wc);
        await sszMerkleTree.addValidatorLeaf(validator.container);
        const validatorIndex = 1n;
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);
        const proof = [
          ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(validator.container)).proof,
          ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + validatorIndex)),
          ...beaconProof,
        ];
        const witness = {
          validatorIndex,
          pubkey: validator.container.pubkey,
          proof,
          childBlockTimestamp,
          proposerIndex: beaconHeader.proposerIndex,
          slot: beaconHeader.slot,
        };

        await expect(pdg.validatePubKeyWCProof(witness, wc)).not.to.be.reverted;
      });
    });

    context("verifyDepositMessage", () => {
      it("reverts on invalid signature", async () => {
        const wc = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(wc);
        const { deposit, depositY } = await generatePredeposit(validator);

        const invalidDepositY = {
          ...depositY,
          signatureY: {
            ...depositY.signatureY,
            c0_a: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        };

        await expect(pdg.verifyDepositMessage(deposit, invalidDepositY, wc)).to.be.reverted;
      });

      it("should not revert on valid signature", async () => {
        const wc = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(wc);
        const { deposit, depositY } = await generatePredeposit(validator);

        await expect(pdg.verifyDepositMessage(deposit, depositY, wc)).not.to.be.reverted;
      });
    });

    context("proveValidatorWC", () => {
      it("reverts on proving not predeposited validator", async () => {
        const balance = ether("200");
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });
        await stakingVault.fund({ value: balance });

        const wc = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(wc);
        await sszMerkleTree.addValidatorLeaf(validator.container);
        const validatorIndex = 1n;
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);
        const proof = [
          ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(validator.container)).proof,
          ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + validatorIndex)),
          ...beaconProof,
        ];

        const witness = {
          validatorIndex,
          pubkey: validator.container.pubkey,
          proof,
          childBlockTimestamp,
          slot: beaconHeader.slot,
          proposerIndex: beaconHeader.proposerIndex,
        };

        // stage NONE
        await expect(pdg.proveWCAndActivate(witness))
          .to.be.revertedWithCustomError(pdg, "ValidatorNotPreDeposited")
          .withArgs(validator.container.pubkey, 0n);

        // stage PREDEPOSITED
        const { deposit, depositY } = await generatePredeposit(validator);
        await pdg.predeposit(stakingVault, [deposit], [depositY]);

        const proveTx = await pdg.proveWCAndActivate(witness);
        await expect(proveTx)
          .to.emit(pdg, "BalanceUnlocked")
          .withArgs(vaultOperator.address, balance, 0)
          .to.emit(pdg, "ValidatorProven")
          .withArgs(validator.container.pubkey, vaultOperator.address, await stakingVault.getAddress(), wc)
          .to.emit(pdg, "ValidatorActivated")
          .withArgs(validator.container.pubkey, vaultOperator.address, await stakingVault.getAddress(), wc);

        expect((await pdg.validatorStatus(validator.container.pubkey)).stage).to.equal(3n); // 3n is ACTIVATED

        // stage ACTIVATED
        await expect(pdg.proveWCAndActivate(witness))
          .to.be.revertedWithCustomError(pdg, "ValidatorNotPreDeposited")
          .withArgs(validator.container.pubkey, 3n); // 3n is ACTIVATED
      });

      it("allows NO to proveValidatorWC", async () => {
        // guarantor funds PDG for operator
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });

        // Staking Vault is funded with enough ether to run validator
        await stakingVault.fund({ value: ether("32") });
        expect(await stakingVault.availableBalance()).to.equal(ether("32"));

        // NO generates validator for vault
        const vaultWC = await stakingVault.withdrawalCredentials();
        const validator = generateValidator(vaultWC);

        // NO runs predeposit for the vault
        const predepositData = await generatePredeposit(validator);
        await pdg.predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]);

        // Validator is added to CL merkle tree
        await sszMerkleTree.addValidatorLeaf(validator.container);
        const validatorLeafIndex = firstValidatorLeafIndex + 1n;
        const validatorIndex = 1n;

        // Beacon Block is generated with new CL state
        const stateRoot = await sszMerkleTree.getMerkleRoot();
        const beaconBlockHeader = generateBeaconHeader(stateRoot);
        const beaconBlockMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);

        /// Beacon Block root is posted to EL
        const childBlockTimestamp = await setBeaconBlockRoot(beaconBlockMerkle.root);

        // NO collects validator proof
        const validatorMerkle = await sszMerkleTree.getValidatorPubkeyWCParentProof(validator.container);
        const stateProof = await sszMerkleTree.getMerkleProof(validatorLeafIndex);
        const concatenatedProof = [...validatorMerkle.proof, ...stateProof, ...beaconBlockMerkle.proof];

        // NO posts proof and triggers deposit to total of 32 ether
        const witness = {
          pubkey: validator.container.pubkey,
          validatorIndex,
          childBlockTimestamp,
          proof: concatenatedProof,
          slot: beaconBlockHeader.slot,
          proposerIndex: beaconBlockHeader.proposerIndex,
        };

        const proveValidatorWCTX = pdg.connect(vaultOwner).proveWCAndActivate(witness);

        await expect(proveValidatorWCTX)
          .to.emit(pdg, "BalanceUnlocked")
          .withArgs(vaultOperator, ether("1"), ether("0"))
          .to.emit(pdg, "ValidatorProven")
          .withArgs(validator.container.pubkey, vaultOperator, stakingVault, vaultWC)
          .to.emit(pdg, "ValidatorActivated")
          .withArgs(validator.container.pubkey, vaultOperator, stakingVault, vaultWC);

        const validatorStatus = await pdg.validatorStatus(validator.container.pubkey);
        expect(validatorStatus.stage).to.equal(3n); // 3n is ACTIVATED
        expect(validatorStatus.stakingVault).to.equal(stakingVault);
        expect(validatorStatus.nodeOperator).to.equal(vaultOperator);
      });
    });

    context("depositToBeaconChain", () => {
      it("reverts for not PROVEN validator", async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });
        await stakingVault.fund({ value: ether("32") });

        const validator = generateValidator(await stakingVault.withdrawalCredentials());
        const { deposit, depositY } = await generatePredeposit(validator);
        await pdg.predeposit(stakingVault, [deposit], [depositY]);

        const topUp = generateTopUp(validator.container);
        await expect(pdg.topUpExistingValidators([topUp]))
          .to.be.revertedWithCustomError(pdg, "ValidatorNotActivated")
          .withArgs(validator.container.pubkey, 1n);
      });

      it("reverts for stranger to deposit", async () => {
        const validator = generateValidator();
        const deposit = generateTopUp(validator.container);

        await expect(pdg.connect(stranger).topUpExistingValidators([deposit])).to.be.revertedWithCustomError(
          pdg,
          "NotDepositor",
        );
      });

      it("reverts when deposits are delegated to a depositor", async () => {
        await pdg.connect(vaultOperator).setNodeOperatorDepositor(stranger);
        const validator = generateValidator();
        const topUp = generateTopUp(validator.container);
        await expect(pdg.connect(vaultOperator).topUpExistingValidators([topUp])).to.be.revertedWithCustomError(
          pdg,
          "NotDepositor",
        );
      });

      it("reverts to deposit someone else validators", async () => {
        const sideStakingVault = await ethers.deployContract("StakingVault__MockForPDG", [stranger, stranger, pdg]);
        const sameNOVault = await ethers.deployContract("StakingVault__MockForPDG", [stranger, vaultOperator, pdg]);
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
        let predeposit = await generatePredeposit(mainValidator);
        await pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]);
        predeposit = await generatePredeposit(sameNOValidator);
        await pdg.predeposit(sameNOVault, [predeposit.deposit], [predeposit.depositY]);
        predeposit = await generatePredeposit(sideValidator);
        await pdg.connect(stranger).predeposit(sideStakingVault, [predeposit.deposit], [predeposit.depositY]);

        // add them to CL
        await sszMerkleTree.addValidatorLeaf(mainValidator.container);
        const mainValidatorIndex = 1n;
        await sszMerkleTree.addValidatorLeaf(sideValidator.container);
        const sideValidatorIndex = 2n;
        await sszMerkleTree.addValidatorLeaf(sameNOValidator.container);
        const sameNoValidatorIndex = 3n;
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);

        // Collect proofs
        const mainValidatorProof = await sszMerkleTree.getValidatorPubkeyWCParentProof(mainValidator.container);
        const mainStateProof = await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + mainValidatorIndex);
        const mainProof = [...mainValidatorProof.proof, ...mainStateProof, ...beaconProof];

        const sideValidatorProof = await sszMerkleTree.getValidatorPubkeyWCParentProof(sideValidator.container);
        const sideStateProof = await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + sideValidatorIndex);
        const sideProof = [...sideValidatorProof.proof, ...sideStateProof, ...beaconProof];

        const sameNoValidatorProof = await sszMerkleTree.getValidatorPubkeyWCParentProof(sameNOValidator.container);
        const sameNoStateProof = await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + sameNoValidatorIndex);
        const sameNoProof = [...sameNoValidatorProof.proof, ...sameNoStateProof, ...beaconProof];

        // prove
        await pdg.proveWCAndActivate({
          proof: mainProof,
          pubkey: mainValidator.container.pubkey,
          validatorIndex: mainValidatorIndex,
          childBlockTimestamp: childBlockTimestamp,
          slot: beaconHeader.slot,
          proposerIndex: beaconHeader.proposerIndex,
        });

        await pdg.proveWCAndActivate({
          proof: sideProof,
          pubkey: sideValidator.container.pubkey,
          validatorIndex: sideValidatorIndex,
          childBlockTimestamp: childBlockTimestamp,
          slot: beaconHeader.slot,
          proposerIndex: beaconHeader.proposerIndex,
        });

        await pdg.proveWCAndActivate({
          proof: sameNoProof,
          pubkey: sameNOValidator.container.pubkey,
          validatorIndex: sameNoValidatorIndex,
          childBlockTimestamp: childBlockTimestamp,
          slot: beaconHeader.slot,
          proposerIndex: beaconHeader.proposerIndex,
        });

        expect((await pdg.validatorStatus(mainValidator.container.pubkey)).stage).to.equal(3n); // 3n is ACTIVATED
        expect((await pdg.validatorStatus(sideValidator.container.pubkey)).stage).to.equal(3n); // 3n is ACTIVATED
        expect((await pdg.validatorStatus(sameNOValidator.container.pubkey)).stage).to.equal(3n); // 3n is ACTIVATED

        const mainDeposit = generateTopUp(mainValidator.container, ether("31"));
        const sideDeposit = generateTopUp(sideValidator.container, ether("31"));

        await expect(pdg.topUpExistingValidators([mainDeposit, sideDeposit])).to.be.revertedWithCustomError(
          pdg,
          "NotDepositor",
        );
      });
    });

    context("proveUnknownValidator", () => {
      it("revert the proveUnknownValidator if it was called by not StakingVault Owner", async () => {
        const witness = {
          validatorIndex: 1n,
          childBlockTimestamp: 1n,
          pubkey: "0x00",
          proof: [],
          slot: 1n,
          proposerIndex: 1n,
        };
        await expect(pdg.connect(stranger).proveUnknownValidator(witness, stakingVault)).to.be.revertedWithCustomError(
          pdg,
          "NotStakingVaultOwner",
        );
      });

      it("can use PDG with proveUnknownValidator", async () => {
        const vaultWC = await stakingVault.withdrawalCredentials();
        const unknownValidator = generateValidator(vaultWC);

        // Validator is added to CL merkle tree
        await sszMerkleTree.addValidatorLeaf(unknownValidator.container);
        const validatorLeafIndex = firstValidatorLeafIndex + 1n;
        const validatorIndex = 1n;

        // Beacon Block is generated with new CL state
        const stateRoot = await sszMerkleTree.getMerkleRoot();
        const beaconBlockHeader = generateBeaconHeader(stateRoot);
        const beaconBlockMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);

        /// Beacon Block root is posted to EL
        const childBlockTimestamp = await setBeaconBlockRoot(beaconBlockMerkle.root);

        // NO collects validator proof
        const validatorMerkle = await sszMerkleTree.getValidatorPubkeyWCParentProof(unknownValidator.container);
        const stateProof = await sszMerkleTree.getMerkleProof(validatorLeafIndex);
        const concatenatedProof = [...validatorMerkle.proof, ...stateProof, ...beaconBlockMerkle.proof];

        let validatorStatusTx = await pdg.validatorStatus(unknownValidator.container.pubkey);
        // ValidatorStatus.stage
        expect(validatorStatusTx[0]).to.equal(0n); // 0n is NONE

        const witness = {
          pubkey: unknownValidator.container.pubkey,
          validatorIndex,
          childBlockTimestamp,
          proof: concatenatedProof,
          slot: beaconBlockHeader.slot,
          proposerIndex: beaconBlockHeader.proposerIndex,
        };

        const proveUnknownValidatorTx = await pdg.connect(vaultOwner).proveUnknownValidator(witness, stakingVault);

        await expect(proveUnknownValidatorTx)
          .to.emit(pdg, "ValidatorProven")
          .withArgs(unknownValidator.container.pubkey, vaultOperator, stakingVault, vaultWC)
          .to.emit(pdg, "ValidatorActivated")
          .withArgs(unknownValidator.container.pubkey, vaultOperator, stakingVault, vaultWC);

        validatorStatusTx = await pdg.validatorStatus(unknownValidator.container.pubkey);
        // ValidatorStatus.stage
        expect(validatorStatusTx[0]).to.equal(3n); // 3n is ACTIVATED

        // revert ValidatorNotNew
        await expect(
          pdg.connect(vaultOwner).proveUnknownValidator(witness, stakingVault),
        ).to.be.revertedWithCustomError(pdg, "ValidatorNotNew");
      });
    });

    context("proveInvalidValidatorWC", () => {
      let invalidWC: string;
      let invalidValidator: Validator;
      let invalidValidatorWitness: IPredepositGuarantee.ValidatorWitnessStruct;

      let validWC: string;
      let validValidator: Validator;
      let validValidatorWitness: IPredepositGuarantee.ValidatorWitnessStruct;

      let validNotPredepostedValidator: Validator;
      let validNotPredepostedValidatorWitness: IPredepositGuarantee.ValidatorWitnessStruct;

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

        // sign predeposit with valid WC
        const invalidPredeposit = await generatePredeposit({
          ...invalidValidator,
          container: { ...invalidValidator.container, withdrawalCredentials: validWC },
        });
        const validPredeposit = await generatePredeposit(validValidator);

        await pdg.predeposit(
          stakingVault,
          [invalidPredeposit.deposit, validPredeposit.deposit],
          [invalidPredeposit.depositY, validPredeposit.depositY],
        );

        await sszMerkleTree.addValidatorLeaf(invalidValidator.container);
        await sszMerkleTree.addValidatorLeaf(validValidator.container);
        await sszMerkleTree.addValidatorLeaf(validNotPredepostedValidator.container);
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);

        invalidValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 1n,
          slot: beaconHeader.slot,
          proposerIndex: beaconHeader.proposerIndex,
          pubkey: invalidValidator.container.pubkey,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(invalidValidator.container)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 1n)),
            ...beaconProof,
          ],
        };

        validValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 2n,
          slot: beaconHeader.slot,
          proposerIndex: beaconHeader.proposerIndex,
          pubkey: validValidator.container.pubkey,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(validValidator.container)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 2n)),
            ...beaconProof,
          ],
        };

        validNotPredepostedValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 3n,
          slot: beaconHeader.slot,
          proposerIndex: beaconHeader.proposerIndex,
          pubkey: validNotPredepostedValidator.container.pubkey,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(validNotPredepostedValidator.container)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 3n)),
            ...beaconProof,
          ],
        };
      });

      it("reverts when trying to prove validator that is not predeposited ", async () => {
        // Not predeposited
        await expect(pdg.connect(vaultOperator).proveInvalidValidatorWC(validNotPredepostedValidatorWitness, validWC))
          .to.revertedWithCustomError(pdg, "ValidatorNotPreDeposited")
          .withArgs(validNotPredepostedValidator.container.pubkey, 0n);

        const predeposit = await generatePredeposit(validNotPredepostedValidator);
        // predeposit
        await pdg.predeposit(stakingVault, [predeposit.deposit], [predeposit.depositY]);

        // Predeposited but it's valid
        await expect(
          pdg.connect(vaultOperator).proveInvalidValidatorWC(validNotPredepostedValidatorWitness, validWC),
        ).to.revertedWithCustomError(pdg, "WithdrawalCredentialsMatch");

        // proving
        await pdg.proveWCAndActivate(validNotPredepostedValidatorWitness);
        await expect(pdg.connect(vaultOperator).proveInvalidValidatorWC(validNotPredepostedValidatorWitness, validWC))
          .to.revertedWithCustomError(pdg, "ValidatorNotPreDeposited")
          .withArgs(validNotPredepostedValidator.container.pubkey, 3n); // 3n is ACTIVATED
      });

      it("reverts when trying to prove valid validator", async () => {
        await expect(
          pdg.connect(vaultOperator).proveInvalidValidatorWC(validValidatorWitness, validWC),
        ).to.revertedWithCustomError(pdg, "WithdrawalCredentialsMatch");
      });

      it("allows to prove validator as invalid", async () => {
        // predeposted
        expect((await pdg.validatorStatus(invalidValidator.container.pubkey)).stage).to.equal(1n); // 1n is PREDEPOSITED
        const [total, locked] = await pdg.nodeOperatorBalance(vaultOperator);
        const expectedTotal = total - ether("1");
        const expectedLocked = locked - ether("1");

        const proveInvalidTX = await pdg.connect(stranger).proveInvalidValidatorWC(invalidValidatorWitness, invalidWC);
        await expect(proveInvalidTX)
          .to.emit(pdg, "ValidatorCompensated")
          .withArgs(stakingVault, vaultOperator, invalidValidator.container.pubkey, expectedTotal, expectedLocked);

        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([expectedTotal, expectedLocked]);
        // disproven
        expect((await pdg.validatorStatus(invalidValidator.container.pubkey)).stage).to.equal(4n); // 4n is COMPENSATED
      });
    });

    context("compensateDisprovenPredeposit", () => {
      let invalidWC: string;
      let invalidValidator: Validator;
      let invalidValidatorWitness: IPredepositGuarantee.ValidatorWitnessStruct;

      let validWC: string;
      let validValidator: Validator;

      beforeEach(async () => {
        await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("20") });

        // Staking Vault is funded with enough ether to run validator
        await stakingVault.fund({ value: ether("32") });

        // Generate a validator
        invalidWC = addressToWC(await stakingVault.nodeOperator()); // vaultOperator is same
        validWC = await stakingVault.withdrawalCredentials();

        invalidValidator = generateValidator(invalidWC);
        validValidator = generateValidator(validWC);

        const invalidValidatorHackedWC = {
          ...invalidValidator,
          container: { ...invalidValidator.container, withdrawalCredentials: validWC },
        };

        const invalidPredeposit = await generatePredeposit(invalidValidatorHackedWC);
        const validPredeposit = await generatePredeposit(validValidator);

        await pdg.predeposit(
          stakingVault,
          [invalidPredeposit.deposit, validPredeposit.deposit],
          [invalidPredeposit.depositY, validPredeposit.depositY],
        );

        await sszMerkleTree.addValidatorLeaf(invalidValidator.container);
        await sszMerkleTree.addValidatorLeaf(validValidator.container);
        const beaconHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot());
        const { proof: beaconProof, root: beaconRoot } = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
        const childBlockTimestamp = await setBeaconBlockRoot(beaconRoot);

        invalidValidatorWitness = {
          childBlockTimestamp,
          validatorIndex: 1n,
          pubkey: invalidValidator.container.pubkey,
          slot: beaconHeader.slot,
          proposerIndex: beaconHeader.proposerIndex,
          proof: [
            ...(await sszMerkleTree.getValidatorPubkeyWCParentProof(invalidValidator.container)).proof,
            ...(await sszMerkleTree.getMerkleProof(firstValidatorLeafIndex + 1n)),
            ...beaconProof,
          ],
        };
      });

      it("allows to compensate disproven validator", async () => {
        const PREDEPOSIT_AMOUNT = await pdg.PREDEPOSIT_AMOUNT();
        const [balanceTotal, balanceLocked] = await pdg.nodeOperatorBalance(vaultOperator);

        let validatorStatus = await pdg.validatorStatus(invalidValidator.container.pubkey);
        expect(validatorStatus.stage).to.equal(1n); // 1n is PREDEPOSITED
        expect(validatorStatus.stakingVault).to.equal(stakingVault);
        expect(validatorStatus.nodeOperator).to.equal(vaultOperator);

        // Call compensateDisprovenPredeposit and expect it to succeed
        const compensateDisprovenPredepositTx = pdg
          .connect(vaultOwner)
          .proveInvalidValidatorWC(invalidValidatorWitness, invalidWC);

        await expect(compensateDisprovenPredepositTx)
          .to.emit(pdg, "ValidatorCompensated")
          .withArgs(
            stakingVault,
            vaultOperator,
            invalidValidatorWitness.pubkey,
            balanceTotal - PREDEPOSIT_AMOUNT,
            balanceLocked - PREDEPOSIT_AMOUNT,
          );

        expect(compensateDisprovenPredepositTx).to.be.ok;

        // Check that the locked balance of the node operator has been reduced
        expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([
          balanceTotal - PREDEPOSIT_AMOUNT,
          balanceLocked - PREDEPOSIT_AMOUNT,
        ]);

        validatorStatus = await pdg.validatorStatus(invalidValidator.container.pubkey);
        expect(validatorStatus.stage).to.equal(4n); // 4n is COMPENSATED
      });
    });
  });

  context("nodeOperatorDepositor", () => {
    it("returns the node operator if not set", async () => {
      expect(await pdg.nodeOperatorDepositor(vaultOperator)).to.equal(vaultOperator);
    });

    it("returns the depositor if set", async () => {
      const depositor = certainAddress("depositor");
      await expect(pdg.setNodeOperatorDepositor(depositor))
        .to.emit(pdg, "DepositorSet")
        .withArgs(vaultOperator, depositor, vaultOperator);
      expect(await pdg.nodeOperatorDepositor(vaultOperator)).to.equal(depositor);
    });

    it("reverts if trying to set the same depositor", async () => {
      await expect(pdg.setNodeOperatorDepositor(vaultOperator)).to.be.revertedWithCustomError(pdg, "SameDepositor");
    });

    it("reverts if trying to set the depositor to zero address", async () => {
      await expect(pdg.setNodeOperatorDepositor(ZeroAddress)).to.be.revertedWithCustomError(pdg, "ZeroArgument");
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

      const witness = {
        validatorIndex: 1n,
        childBlockTimestamp: 1n,
        pubkey: "0x00",
        proof: [],
        slot: 1n,
        proposerIndex: 1n,
      };

      await expect(pdg.predeposit(stakingVault, [], [])).to.revertedWithCustomError(pdg, "ResumedExpected");
      await expect(pdg.proveWCAndActivate(witness)).to.revertedWithCustomError(pdg, "ResumedExpected");
      await expect(pdg.activateValidator(witness.pubkey)).to.revertedWithCustomError(pdg, "ResumedExpected");
      await expect(pdg.topUpExistingValidators([])).to.revertedWithCustomError(pdg, "ResumedExpected");
      await expect(pdg.proveWCActivateAndTopUpValidators([], [])).to.revertedWithCustomError(pdg, "ResumedExpected");

      await expect(pdg.proveUnknownValidator(witness, stakingVault)).to.revertedWithCustomError(pdg, "ResumedExpected");

      await expect(pdg.proveInvalidValidatorWC(witness, randomBytes32())).to.revertedWithCustomError(
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
