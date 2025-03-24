import { expect } from "chai";
import { zeroAddress } from "ethereumjs-util";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  EthRejector,
  LidoLocator,
  OssifiableProxy,
  PredepositGuarantee,
  SSZMerkleTree,
  StakingVault,
  StakingVault__factory,
  VaultFactory__MockForStakingVault,
  VaultHub__MockForStakingVault,
} from "typechain-types";

import { ether, findEvents, randomBytes32 } from "lib";
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

// TODO: move
function to02Type(address: string): string {
  const normalizedAddress = address.toLowerCase().replace(/^0x/, "");
  const padding = "0000000000000000000000";
  return `0x02${padding}${normalizedAddress}`;
}

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
  let depositContract: DepositContract__MockForStakingVault;
  let rejector: EthRejector;

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
    stakingVault = await deployStakingVault(vaultOwner, vaultOperator);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts on impl initialization", async () => {
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

  context("node operator accounting logic (nodeOperator = nodeOperatorGuarantor)", () => {
    it("check that nodeOperator and nodeOperatorGuarantor are the same address", async () => {
      // vaultOperator is nodeOperator here
      await pdg.connect(vaultOperator).topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });
      const nodeOperatorGuarantor = await pdg.nodeOperatorGuarantor(vaultOperator);
      expect(nodeOperatorGuarantor).to.equal(vaultOperator);
    });

    it("check that nodeOperator can topUpNodeOperatorBalance", async () => {
      // vaultOperator is nodeOperator here
      await pdg.connect(vaultOperator).topUpNodeOperatorBalance(vaultOperator, { value: ether("1") });
      await pdg.connect(vaultOperator).topUpNodeOperatorBalance(vaultOperator, { value: ether("100") });
      const [operatorBondTotal] = await pdg.nodeOperatorBalance(vaultOperator);
      expect(operatorBondTotal).to.equal(ether("101"));

      const unlockedBalance = await pdg.unlockedBalance(vaultOperator);
      expect(unlockedBalance).to.equal(ether("101"));
    });

    it("check that nodeOperator can withdrawNodeOperatorBalance", async () => {
      // vaultOperator is nodeOperator here
      await pdg.connect(vaultOperator).topUpNodeOperatorBalance(vaultOperator, { value: ether("100") });
      await pdg.withdrawNodeOperatorBalance(vaultOperator, ether("50"), vaultOperator);

      const [operatorBondTotal] = await pdg.nodeOperatorBalance(vaultOperator);
      expect(operatorBondTotal).to.equal(ether("50"));
    });
  });

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

    it("reverts when the 'setNodeOperatorGuarantor' got address is zero", async () => {
      await expect(pdg.connect(vaultOperator).setNodeOperatorGuarantor(ZeroAddress)).to.be.revertedWithCustomError(
        pdg,
        "ZeroArgument",
      );
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
  });

  context("topUpNodeOperatorBalance", () => {
    it("allows only valid guarantor to top up balance", async () => {
      const balance = ether("1");

      await expect(
        pdg.connect(stranger).topUpNodeOperatorBalance(zeroAddress(), { value: balance }),
      ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

      await expect(
        pdg.connect(stranger).topUpNodeOperatorBalance(vaultOperator, { value: balance }),
      ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

      let topUpTx = pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });
      await expect(topUpTx).to.emit(pdg, "BalanceToppedUp").withArgs(vaultOperator, vaultOperator, balance);
      expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([balance, 0n]);

      await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
      expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);
      await expect(
        pdg.connect(vaultOperator).topUpNodeOperatorBalance(vaultOperator, { value: balance }),
      ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

      topUpTx = pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance });
      await expect(topUpTx).to.emit(pdg, "BalanceToppedUp").withArgs(vaultOperator, vaultOperatorGuarantor, balance);
      expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([balance, 0n]);
    });

    it("allows only valid top up amount", async () => {
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
  });

  context("withdrawNodeOperatorBalance", () => {
    it("allows only valid guarantor to withdraw balance", async () => {
      const balance = ether("1");
      await pdg.topUpNodeOperatorBalance(vaultOperator, { value: balance });

      await expect(
        pdg.connect(stranger).withdrawNodeOperatorBalance(zeroAddress(), balance, stranger),
      ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

      await expect(
        pdg.connect(stranger).withdrawNodeOperatorBalance(vaultOperator, balance, stranger),
      ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

      let withdrawTx = pdg.withdrawNodeOperatorBalance(vaultOperator, balance, vaultOperatorGuarantor);
      await expect(withdrawTx)
        .to.emit(pdg, "BalanceWithdrawn")
        .withArgs(vaultOperator, vaultOperatorGuarantor, balance);
      expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);

      await pdg.setNodeOperatorGuarantor(vaultOperatorGuarantor);
      await pdg.connect(vaultOperatorGuarantor).topUpNodeOperatorBalance(vaultOperator, { value: balance });
      await expect(
        pdg.connect(vaultOperator).withdrawNodeOperatorBalance(vaultOperator, balance, stranger),
      ).to.be.revertedWithCustomError(pdg, "NotGuarantor");

      withdrawTx = pdg
        .connect(vaultOperatorGuarantor)
        .withdrawNodeOperatorBalance(vaultOperator, balance, vaultOperatorGuarantor);
      await expect(withdrawTx)
        .to.emit(pdg, "BalanceWithdrawn")
        .withArgs(vaultOperator, vaultOperatorGuarantor, balance);
      expect(await pdg.nodeOperatorBalance(vaultOperator)).to.deep.equal([0n, 0n]);
    });

    it("allows only valid withdrawal amount", async () => {
      const balance = ether("1");
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

    it("allow only to withdraw unlocked balance", async () => {
      await stakingVault.fund({ value: ether("32") });
      const balance = ether("1");
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

      await expect(pdg.withdrawNodeOperatorBalance(vaultOperator, ether("1"), rejector)).to.be.revertedWithCustomError(
        pdg,
        "WithdrawalFailed",
      );
    });
  });

  context("predeposit", () => {
    it("reverts when the 'predeposit' got empty deposits", async () => {
      // NO runs predeposit for the vault without predepositData
      await expect(pdg.connect(stranger).predeposit(stakingVault, [])).to.be.revertedWithCustomError(
        pdg,
        "EmptyDeposits",
      );
    });

    it("allows only NO to predeposit", async () => {
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

    it("not allows to use locked balance", async () => {
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

    it("not allows to re-use validator", async () => {
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

    it("not allows invalid predeposit amount", async () => {
      await stakingVault.fund({ value: ether("32") });
      const validator = generateValidator();
      const predeposit = generatePredeposit(validator);
      await pdg.topUpNodeOperatorBalance(vaultOperator, { value: ether("3") });

      predeposit.amount = ether("2");

      await expect(pdg.predeposit(stakingVault, [predeposit]))
        .to.be.revertedWithCustomError(pdg, "PredepositAmountInvalid")
        .withArgs(validator.pubkey, predeposit.amount);
    });

    it("allows to top up on predeposit", async () => {
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
  });

  context("happy path - positive proof flow", () => {
    it("can use PDG happy path with proveAndDeposit", async () => {
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

  context("positive proof flow - unknown validator", () => {
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
    });
  });

  context("negative proof flow", () => {
    it("should correctly handle compensation of disproven validator", async () => {
      await expect(pdg.connect(vaultOperator).topUpNodeOperatorBalance(vaultOperator, { value: ether("1") }))
        .to.emit(pdg, "BalanceToppedUp")
        .withArgs(vaultOperator, vaultOperator, ether("1"));

      const [operatorBondTotal, operatorBondLocked] = await pdg.nodeOperatorBalance(vaultOperator);
      expect(operatorBondTotal).to.equal(ether("1"));
      expect(operatorBondLocked).to.equal(0n);

      // Staking Vault is funded with enough ether to run validator
      await stakingVault.fund({ value: ether("32") });
      expect(await stakingVault.valuation()).to.equal(ether("32"));

      // Generate a validator
      const vaultNodeOperatorAddress = to02Type(await stakingVault.nodeOperator()); // vaultOperator is same

      const validatorIncorrect = generateValidator(vaultNodeOperatorAddress);

      const predepositData = generatePredeposit(validatorIncorrect);

      await pdg.predeposit(stakingVault, [predepositData]);

      // Validator is added to CL merkle tree
      await sszMerkleTree.addValidatorLeaf(validatorIncorrect);
      const validatorLeafIndex = firstValidatorLeafIndex + 1n;
      const validatorIndex = 1n;

      // Beacon Block is generated with new CL state
      const stateRoot = await sszMerkleTree.getMerkleRoot();
      const beaconBlockHeader = generateBeaconHeader(stateRoot);
      const beaconBlockMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);

      /// Beacon Block root is posted to EL
      const childBlockTimestamp = await setBeaconBlockRoot(beaconBlockMerkle.root);

      // NO collects validator proof
      const validatorMerkle = await sszMerkleTree.getValidatorPubkeyWCParentProof(validatorIncorrect);
      const stateProof = await sszMerkleTree.getMerkleProof(validatorLeafIndex);
      const concatenatedProof = [...validatorMerkle.proof, ...stateProof, ...beaconBlockMerkle.proof];

      const witness = {
        pubkey: validatorIncorrect.pubkey,
        validatorIndex,
        childBlockTimestamp,
        proof: concatenatedProof,
      };

      await expect(pdg.connect(vaultOperator).proveInvalidValidatorWC(witness, vaultNodeOperatorAddress))
        .to.emit(pdg, "ValidatorDisproven")
        .withArgs(
          validatorIncorrect.pubkey,
          vaultOperator.address,
          await stakingVault.getAddress(),
          vaultNodeOperatorAddress,
        );

      // Now the validator is in the DISPROVEN stage, we can proceed with compensation
      let validatorStatusTx = await pdg.validatorStatus(validatorIncorrect.pubkey);
      // ValidatorStatus.stage
      expect(validatorStatusTx[0]).to.equal(3n); // 3n is DISPROVEN
      // ValidatorStatus.stakingVault
      expect(validatorStatusTx[1]).to.equal(await stakingVault.getAddress());
      // ValidatorStatus.nodeOperator
      expect(validatorStatusTx[2]).to.equal(vaultOperator.address);

      // Call compensateDisprovenPredeposit and expect it to succeed
      const compensateDisprovenPredepositTx = pdg
        .connect(vaultOwner)
        .compensateDisprovenPredeposit(validatorIncorrect.pubkey, vaultOperator.address);

      await expect(compensateDisprovenPredepositTx)
        .to.emit(pdg, "BalanceCompensated")
        .withArgs(vaultOperator.address, vaultOperator.address, ether("0"), ether("0"))
        .to.emit(pdg, "ValidatorCompensated")
        .withArgs(
          validatorIncorrect.pubkey,
          vaultOperator.address,
          await stakingVault.getAddress(),
          vaultOperator.address,
        );

      await expect(compensateDisprovenPredepositTx).to.be.ok;

      // Check that the locked balance of the node operator has been reduced
      const nodeOperatorBalance = await pdg.nodeOperatorBalance(vaultOperator.address);
      expect(nodeOperatorBalance.locked).to.equal(0);

      validatorStatusTx = await pdg.validatorStatus(validatorIncorrect.pubkey);
      // ValidatorStatus.stage
      expect(validatorStatusTx[0]).to.equal(4n); // 4n is COMPENSATED
    });
  });

  context("pausing", () => {
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
