import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { before } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  LidoLocator,
  OperatorGrid__MockForPermissions,
  Permissions__Harness,
  Permissions__Harness__factory,
  PredepositGuarantee__MockPermissions,
  StakingVault,
  StakingVault__factory,
  UpgradeableBeacon,
  VaultFactory__MockPermissions,
  VaultHub__MockPermissions,
} from "typechain-types";

import { certainAddress, days, deployEIP7002WithdrawalRequestContract, ether, findEvents, getRandomSigners } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

type PermissionsConfigStruct = {
  defaultAdmin: HardhatEthersSigner;
  nodeOperator: HardhatEthersSigner;
  confirmExpiry: bigint;
  funder: HardhatEthersSigner;
  withdrawer: HardhatEthersSigner;
  minter: HardhatEthersSigner;
  burner: HardhatEthersSigner;
  rebalancer: HardhatEthersSigner;
  depositPauser: HardhatEthersSigner;
  depositResumer: HardhatEthersSigner;
  pdgCompensator: HardhatEthersSigner;
  unknownValidatorProver: HardhatEthersSigner;
  unguaranteedBeaconChainDepositor: HardhatEthersSigner;
  validatorExitRequester: HardhatEthersSigner;
  validatorWithdrawalTriggerer: HardhatEthersSigner;
  disconnecter: HardhatEthersSigner;
  tierChanger: HardhatEthersSigner;
};

describe("Permissions", () => {
  let deployer: HardhatEthersSigner;
  let defaultAdmin: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let funder: HardhatEthersSigner;
  let withdrawer: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let burner: HardhatEthersSigner;
  let rebalancer: HardhatEthersSigner;
  let depositPauser: HardhatEthersSigner;
  let depositResumer: HardhatEthersSigner;
  let pdgCompensator: HardhatEthersSigner;
  let unknownValidatorProver: HardhatEthersSigner;
  let unguaranteedBeaconChainDepositor: HardhatEthersSigner;
  let validatorExitRequester: HardhatEthersSigner;
  let validatorWithdrawalTriggerer: HardhatEthersSigner;
  let disconnecter: HardhatEthersSigner;
  let tierChanger: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let lidoLocator: LidoLocator;
  let operatorGrid: OperatorGrid__MockForPermissions;
  let depositContract: DepositContract__MockForStakingVault;
  let permissionsImpl: Permissions__Harness;
  let stakingVaultImpl: StakingVault;
  let vaultHub: VaultHub__MockPermissions;
  let beacon: UpgradeableBeacon;
  let vaultFactory: VaultFactory__MockPermissions;
  let stakingVault: StakingVault;
  let permissions: Permissions__Harness;
  let pdg: PredepositGuarantee__MockPermissions;

  let originalState: string;

  before(async () => {
    [
      deployer,
      defaultAdmin,
      nodeOperator,
      funder,
      withdrawer,
      minter,
      burner,
      rebalancer,
      depositPauser,
      depositResumer,
      pdgCompensator,
      unknownValidatorProver,
      unguaranteedBeaconChainDepositor,
      validatorExitRequester,
      disconnecter,
      validatorWithdrawalTriggerer,
      tierChanger,
      stranger,
    ] = await getRandomSigners(30);

    // TODO
    await deployEIP7002WithdrawalRequestContract();

    pdg = await ethers.deployContract("PredepositGuarantee__MockPermissions");

    // 1. Deploy DepositContract
    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    operatorGrid = await ethers.deployContract("OperatorGrid__MockForPermissions");
    lidoLocator = await deployLidoLocator({ predepositGuarantee: pdg, operatorGrid });

    // 2. Deploy VaultHub
    vaultHub = await ethers.deployContract("VaultHub__MockPermissions", [lidoLocator]);

    // 3. Deploy StakingVault implementation
    stakingVaultImpl = await ethers.deployContract("StakingVault", [depositContract]);
    expect(await stakingVaultImpl.DEPOSIT_CONTRACT()).to.equal(depositContract);

    // 4. Deploy Beacon and use StakingVault implementation as initial implementation
    beacon = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImpl, deployer]);

    // 5. Deploy Permissions implementation
    permissionsImpl = await ethers.deployContract("Permissions__Harness", [vaultHub, lidoLocator]);

    // 6. Deploy VaultFactory and use Beacon and Permissions implementations

    vaultFactory = await ethers.deployContract("VaultFactory__MockPermissions", [beacon, permissionsImpl, pdg]);

    // 7. Create StakingVault and Permissions proxies using VaultFactory
    const vaultCreationTx = await vaultFactory.connect(deployer).createVaultWithPermissions({
      defaultAdmin,
      nodeOperator,
      confirmExpiry: days(7n),
      funder,
      withdrawer,
      minter,
      burner,
      rebalancer,
      depositPauser,
      depositResumer,
      pdgCompensator,
      unknownValidatorProver,
      unguaranteedBeaconChainDepositor,
      validatorExitRequester,
      validatorWithdrawalTriggerer,
      disconnecter,
      tierChanger,
    } as PermissionsConfigStruct);
    const vaultCreationReceipt = await vaultCreationTx.wait();
    if (!vaultCreationReceipt) throw new Error("Vault creation failed");

    // 8. Get StakingVault's proxy address from the event and wrap it in StakingVault interface
    const vaultCreatedEvents = findEvents(vaultCreationReceipt, "VaultCreated");
    if (vaultCreatedEvents.length != 1) throw new Error("There should be exactly one VaultCreated event");
    const vaultCreatedEvent = vaultCreatedEvents[0];

    stakingVault = StakingVault__factory.connect(vaultCreatedEvent.args.vault, defaultAdmin);

    // 9. Get Permissions' proxy address from the event and wrap it in Permissions interface
    const permissionsCreatedEvents = findEvents(vaultCreationReceipt, "PermissionsCreated");
    if (permissionsCreatedEvents.length != 1) throw new Error("There should be exactly one PermissionsCreated event");
    const permissionsCreatedEvent = permissionsCreatedEvents[0];

    permissions = Permissions__Harness__factory.connect(permissionsCreatedEvent.args.permissions, defaultAdmin);

    // 10. Check that StakingVault is initialized properly
    expect(await stakingVault.owner()).to.equal(permissions);
    expect(await stakingVault.nodeOperator()).to.equal(nodeOperator);

    // 11. Check events
    expect(vaultCreatedEvent.args.owner).to.equal(permissions);
    expect(permissionsCreatedEvent.args.admin).to.equal(defaultAdmin);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("initial state", () => {
    it("should have the correct roles", async () => {
      await checkSoleMember(defaultAdmin, await permissions.DEFAULT_ADMIN_ROLE());
      await checkSoleMember(funder, await permissions.FUND_ROLE());
      await checkSoleMember(withdrawer, await permissions.WITHDRAW_ROLE());
      await checkSoleMember(minter, await permissions.MINT_ROLE());
      await checkSoleMember(burner, await permissions.BURN_ROLE());
      await checkSoleMember(rebalancer, await permissions.REBALANCE_ROLE());
      await checkSoleMember(depositPauser, await permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE());
      await checkSoleMember(depositResumer, await permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE());
      await checkSoleMember(validatorExitRequester, await permissions.REQUEST_VALIDATOR_EXIT_ROLE());
      await checkSoleMember(validatorWithdrawalTriggerer, await permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE());
      await checkSoleMember(disconnecter, await permissions.VOLUNTARY_DISCONNECT_ROLE());
      await checkSoleMember(tierChanger, await permissions.VAULT_CONFIGURATION_ROLE());
    });
  });

  context("constructor()", () => {
    it("reverts if the vault hub is the zero address", async () => {
      await expect(
        ethers.deployContract("Permissions__Harness", [ZeroAddress, lidoLocator]),
      ).to.be.revertedWithCustomError(permissions, "ZeroAddress");
    });

    it("reverts if the lido locator is the zero address", async () => {
      await expect(
        ethers.deployContract("Permissions__Harness", [vaultHub, ZeroAddress]),
      ).to.be.revertedWithCustomError(permissions, "ZeroAddress");
    });
  });

  context("initialize()", () => {
    it("reverts if called twice", async () => {
      await expect(
        vaultFactory.connect(deployer).revertCreateVaultWithPermissionsWithDoubleInitialize({
          defaultAdmin,
          nodeOperator,
          confirmExpiry: days(7n),
          funder,
          withdrawer,
          minter,
          burner,
          rebalancer,
          depositPauser,
          depositResumer,
          pdgCompensator,
          unknownValidatorProver,
          unguaranteedBeaconChainDepositor,
          validatorExitRequester,
          validatorWithdrawalTriggerer,
          disconnecter,
          tierChanger,
        } as PermissionsConfigStruct),
      ).to.be.revertedWithCustomError(permissions, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const newImplementation = await ethers.deployContract("Permissions__Harness", [vaultHub, lidoLocator]);
      await expect(newImplementation.initialize(defaultAdmin, days(7n))).to.be.revertedWithCustomError(
        permissions,
        "AlreadyInitialized",
      );
    });

    it("reverts if zero address is passed as default admin", async () => {
      await expect(
        vaultFactory.connect(deployer).revertCreateVaultWithPermissionsWithZeroDefaultAdmin({
          defaultAdmin,
          nodeOperator,
          confirmExpiry: days(7n),
          funder,
          withdrawer,
          minter,
          burner,
          rebalancer,
          depositPauser,
          depositResumer,
          pdgCompensator,
          unknownValidatorProver,
          unguaranteedBeaconChainDepositor,
          validatorExitRequester,
          validatorWithdrawalTriggerer,
          disconnecter,
          tierChanger,
        } as PermissionsConfigStruct),
      ).to.be.revertedWithCustomError(permissions, "ZeroAddress");
    });
  });

  context("stakingVault()", () => {
    it("returns the correct staking vault", async () => {
      expect(await permissions.stakingVault()).to.equal(stakingVault);
    });
  });

  context("grantRoles()", () => {
    it("mass-grants roles", async () => {
      const [
        fundRole,
        withdrawRole,
        mintRole,
        burnRole,
        rebalanceRole,
        pauseDepositRole,
        resumeDepositRole,
        exitRequesterRole,
        disconnectRole,
      ] = await Promise.all([
        permissions.FUND_ROLE(),
        permissions.WITHDRAW_ROLE(),
        permissions.MINT_ROLE(),
        permissions.BURN_ROLE(),
        permissions.REBALANCE_ROLE(),
        permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
        permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
        permissions.REQUEST_VALIDATOR_EXIT_ROLE(),
        permissions.VOLUNTARY_DISCONNECT_ROLE(),
      ]);

      const [
        anotherMinter,
        anotherFunder,
        anotherWithdrawer,
        anotherBurner,
        anotherRebalancer,
        anotherDepositPauser,
        anotherDepositResumer,
        anotherExitRequester,
        anotherDisconnecter,
      ] = [
        certainAddress("another-minter"),
        certainAddress("another-funder"),
        certainAddress("another-withdrawer"),
        certainAddress("another-burner"),
        certainAddress("another-rebalancer"),
        certainAddress("another-deposit-pauser"),
        certainAddress("another-deposit-resumer"),
        certainAddress("another-exit-requester"),
        certainAddress("another-disconnecter"),
      ];

      const assignments = [
        { role: fundRole, account: anotherFunder },
        { role: withdrawRole, account: anotherWithdrawer },
        { role: mintRole, account: anotherMinter },
        { role: burnRole, account: anotherBurner },
        { role: rebalanceRole, account: anotherRebalancer },
        { role: pauseDepositRole, account: anotherDepositPauser },
        { role: resumeDepositRole, account: anotherDepositResumer },
        { role: exitRequesterRole, account: anotherExitRequester },
        { role: disconnectRole, account: anotherDisconnecter },
      ];

      await expect(permissions.connect(defaultAdmin).grantRoles(assignments))
        .to.emit(permissions, "RoleGranted")
        .withArgs(fundRole, anotherFunder, defaultAdmin)
        .and.to.emit(permissions, "RoleGranted")
        .withArgs(withdrawRole, anotherWithdrawer, defaultAdmin)
        .and.to.emit(permissions, "RoleGranted")
        .withArgs(mintRole, anotherMinter, defaultAdmin)
        .and.to.emit(permissions, "RoleGranted")
        .withArgs(burnRole, anotherBurner, defaultAdmin)
        .and.to.emit(permissions, "RoleGranted")
        .withArgs(rebalanceRole, anotherRebalancer, defaultAdmin)
        .and.to.emit(permissions, "RoleGranted")
        .withArgs(pauseDepositRole, anotherDepositPauser, defaultAdmin)
        .and.to.emit(permissions, "RoleGranted")
        .withArgs(resumeDepositRole, anotherDepositResumer, defaultAdmin)
        .and.to.emit(permissions, "RoleGranted")
        .withArgs(exitRequesterRole, anotherExitRequester, defaultAdmin)
        .and.to.emit(permissions, "RoleGranted")
        .withArgs(disconnectRole, anotherDisconnecter, defaultAdmin);

      for (const assignment of assignments) {
        expect(await permissions.hasRole(assignment.role, assignment.account)).to.be.true;
        expect(await permissions.getRoleMemberCount(assignment.role)).to.equal(2);
      }
    });

    it("emits only one RoleGranted event per unique role-account pair", async () => {
      const anotherMinter = certainAddress("another-minter");

      const tx = await permissions.connect(defaultAdmin).grantRoles([
        { role: await permissions.MINT_ROLE(), account: anotherMinter },
        { role: await permissions.MINT_ROLE(), account: anotherMinter },
      ]);

      const receipt = await tx.wait();
      if (!receipt) throw new Error("Transaction failed");

      const events = findEvents(receipt, "RoleGranted");
      expect(events.length).to.equal(1);
      expect(events[0].args.role).to.equal(await permissions.MINT_ROLE());
      expect(events[0].args.account).to.equal(anotherMinter);

      expect(await permissions.hasRole(await permissions.MINT_ROLE(), anotherMinter)).to.be.true;
    });

    it("reverts if there are no assignments", async () => {
      await expect(permissions.connect(defaultAdmin).grantRoles([])).to.be.revertedWithCustomError(
        permissions,
        "ZeroArgument",
      );
    });
  });

  context("revokeRoles()", () => {
    it("mass-revokes roles", async () => {
      const [
        fundRole,
        withdrawRole,
        mintRole,
        burnRole,
        rebalanceRole,
        pauseDepositRole,
        resumeDepositRole,
        exitRequesterRole,
        disconnectRole,
      ] = await Promise.all([
        permissions.FUND_ROLE(),
        permissions.WITHDRAW_ROLE(),
        permissions.MINT_ROLE(),
        permissions.BURN_ROLE(),
        permissions.REBALANCE_ROLE(),
        permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
        permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
        permissions.REQUEST_VALIDATOR_EXIT_ROLE(),
        permissions.VOLUNTARY_DISCONNECT_ROLE(),
      ]);

      const assignments = [
        { role: fundRole, account: funder },
        { role: withdrawRole, account: withdrawer },
        { role: mintRole, account: minter },
        { role: burnRole, account: burner },
        { role: rebalanceRole, account: rebalancer },
        { role: pauseDepositRole, account: depositPauser },
        { role: resumeDepositRole, account: depositResumer },
        { role: exitRequesterRole, account: validatorExitRequester },
        { role: disconnectRole, account: disconnecter },
      ];

      await expect(permissions.connect(defaultAdmin).revokeRoles(assignments))
        .to.emit(permissions, "RoleRevoked")
        .withArgs(fundRole, funder, defaultAdmin)
        .and.to.emit(permissions, "RoleRevoked")
        .withArgs(withdrawRole, withdrawer, defaultAdmin)
        .and.to.emit(permissions, "RoleRevoked")
        .withArgs(mintRole, minter, defaultAdmin)
        .and.to.emit(permissions, "RoleRevoked")
        .withArgs(burnRole, burner, defaultAdmin)
        .and.to.emit(permissions, "RoleRevoked")
        .withArgs(rebalanceRole, rebalancer, defaultAdmin)
        .and.to.emit(permissions, "RoleRevoked")
        .withArgs(pauseDepositRole, depositPauser, defaultAdmin)
        .and.to.emit(permissions, "RoleRevoked")
        .withArgs(resumeDepositRole, depositResumer, defaultAdmin)
        .and.to.emit(permissions, "RoleRevoked")
        .withArgs(exitRequesterRole, validatorExitRequester, defaultAdmin)
        .and.to.emit(permissions, "RoleRevoked")
        .withArgs(disconnectRole, disconnecter, defaultAdmin);

      for (const assignment of assignments) {
        expect(await permissions.hasRole(assignment.role, assignment.account)).to.be.false;
        expect(await permissions.getRoleMemberCount(assignment.role)).to.equal(0);
      }
    });

    it("emits only one RoleRevoked event per unique role-account pair", async () => {
      const tx = await permissions.connect(defaultAdmin).revokeRoles([
        { role: await permissions.MINT_ROLE(), account: minter },
        { role: await permissions.MINT_ROLE(), account: minter },
      ]);

      const receipt = await tx.wait();
      if (!receipt) throw new Error("Transaction failed");

      const events = findEvents(receipt, "RoleRevoked");
      expect(events.length).to.equal(1);
      expect(events[0].args.role).to.equal(await permissions.MINT_ROLE());
      expect(events[0].args.account).to.equal(minter);

      expect(await permissions.hasRole(await permissions.MINT_ROLE(), minter)).to.be.false;
    });

    it("reverts if there are no assignments", async () => {
      await expect(permissions.connect(defaultAdmin).revokeRoles([])).to.be.revertedWithCustomError(
        permissions,
        "ZeroArgument",
      );
    });
  });

  context("fund()", () => {
    it("funds the vault", async () => {
      const fundAmount = ether("1");
      await expect(permissions.connect(funder).fund(fundAmount, { value: fundAmount }))
        .to.emit(vaultHub, "Mock__Funded")
        .withArgs(stakingVault, fundAmount);
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.FUND_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.FUND_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).fund(ether("1"), { value: ether("1") }))
        .to.emit(vaultHub, "Mock__Funded")
        .withArgs(stakingVault, ether("1"));
    });

    it("reverts if the caller is not a member of the fund role", async () => {
      expect(await permissions.hasRole(await permissions.FUND_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).fund(ether("1"), { value: ether("1") }))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.FUND_ROLE());
    });
  });

  context("withdraw()", () => {
    it("withdraws the StakingVault", async () => {
      const fundAmount = ether("1");
      await permissions.connect(funder).fund(fundAmount, { value: fundAmount });

      const withdrawAmount = fundAmount;
      await expect(permissions.connect(withdrawer).withdraw(withdrawer, withdrawAmount))
        .to.emit(vaultHub, "Mock__Withdrawn")
        .withArgs(stakingVault, withdrawer, withdrawAmount);
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.WITHDRAW_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.WITHDRAW_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).withdraw(stranger, ether("1")))
        .to.emit(vaultHub, "Mock__Withdrawn")
        .withArgs(stakingVault, stranger, ether("1"));
    });

    it("reverts if the caller is not a member of the withdraw role", async () => {
      expect(await permissions.hasRole(await permissions.WITHDRAW_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).withdraw(stranger, ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.WITHDRAW_ROLE());
    });
  });

  context("mintShares()", () => {
    it("emits mock event on the mock vault hub", async () => {
      const mintAmount = ether("1");
      await expect(permissions.connect(minter).mintShares(minter, mintAmount))
        .to.emit(vaultHub, "Mock__SharesMinted")
        .withArgs(stakingVault, minter, mintAmount);
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.MINT_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.MINT_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).mintShares(stranger, ether("1")))
        .to.emit(vaultHub, "Mock__SharesMinted")
        .withArgs(stakingVault, stranger, ether("1"));
    });

    it("reverts if the caller is not a member of the mint role", async () => {
      expect(await permissions.hasRole(await permissions.MINT_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).mintShares(stranger, ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.MINT_ROLE());
    });
  });

  context("burnShares()", () => {
    it("emits mock event on the mock vault hub", async () => {
      const burnAmount = ether("1");
      await expect(permissions.connect(burner).burnShares(burnAmount))
        .to.emit(vaultHub, "Mock__SharesBurned")
        .withArgs(stakingVault, burnAmount);
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.BURN_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.BURN_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      const burnAmount = ether("1");
      await expect(permissions.connect(defaultAdmin).burnShares(burnAmount))
        .to.emit(vaultHub, "Mock__SharesBurned")
        .withArgs(stakingVault, burnAmount);
    });

    it("reverts if the caller is not a member of the burn role", async () => {
      expect(await permissions.hasRole(await permissions.BURN_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).burnShares(ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.BURN_ROLE());
    });
  });

  context("rebalanceVault()", () => {
    it("rebalances the StakingVault", async () => {
      const fundAmount = ether("1");
      await permissions.connect(funder).fund(fundAmount, { value: fundAmount });

      const rebalanceAmount = fundAmount; // assumption: 1:1 => share : ether
      await expect(permissions.connect(rebalancer).rebalanceVault(rebalanceAmount))
        .to.emit(vaultHub, "Mock__Rebalanced")
        .withArgs(stakingVault, rebalanceAmount);
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.REBALANCE_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.REBALANCE_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).rebalanceVault(ether("1")))
        .to.emit(vaultHub, "Mock__Rebalanced")
        .withArgs(stakingVault, ether("1"));
    });

    it("reverts if the caller is not a member of the rebalance role", async () => {
      expect(await permissions.hasRole(await permissions.REBALANCE_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).rebalanceVault(ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.REBALANCE_ROLE());
    });
  });

  context("pauseBeaconChainDeposits()", () => {
    it("pauses the BeaconChainDeposits", async () => {
      await expect(permissions.connect(depositPauser).pauseBeaconChainDeposits()).to.emit(
        vaultHub,
        "Mock__BeaconChainDepositsPaused",
      );
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).pauseBeaconChainDeposits()).to.emit(
        vaultHub,
        "Mock__BeaconChainDepositsPaused",
      );
    });

    it("reverts if the caller is not a member of the pause deposit role", async () => {
      expect(await permissions.hasRole(await permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).pauseBeaconChainDeposits())
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE());
    });
  });

  context("resumeBeaconChainDeposits()", () => {
    it("resumes the BeaconChainDeposits", async () => {
      await expect(permissions.connect(depositResumer).resumeBeaconChainDeposits()).to.emit(
        vaultHub,
        "Mock__BeaconChainDepositsResumed",
      );
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), defaultAdmin)).to.be
        .false;
      expect(await permissions.getRoleAdmin(await permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).resumeBeaconChainDeposits()).to.emit(
        vaultHub,
        "Mock__BeaconChainDepositsResumed",
      );
    });

    it("reverts if the caller is not a member of the resume deposit role", async () => {
      expect(await permissions.hasRole(await permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).resumeBeaconChainDeposits())
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE());
    });
  });

  context("requestValidatorExit()", () => {
    it("requests a validator exit", async () => {
      const pubkeys = "0x" + "beef".repeat(24);
      await expect(permissions.connect(validatorExitRequester).requestValidatorExit(pubkeys))
        .to.emit(vaultHub, "Mock__ValidatorExitRequested")
        .withArgs(stakingVault, pubkeys);
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.REQUEST_VALIDATOR_EXIT_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.REQUEST_VALIDATOR_EXIT_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).requestValidatorExit("0xabcdef"))
        .to.emit(vaultHub, "Mock__ValidatorExitRequested")
        .withArgs(stakingVault, "0xabcdef");
    });

    it("reverts if the caller is not a member of the request exit role", async () => {
      expect(await permissions.hasRole(await permissions.REQUEST_VALIDATOR_EXIT_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).requestValidatorExit("0xabcdef"))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.REQUEST_VALIDATOR_EXIT_ROLE());
    });
  });

  context("triggerValidatorWithdrawals()", () => {
    const pubkeys = "0x" + "beef".repeat(24);
    const withdrawalAmount = ether("1");

    it("emits mock event on the mock vault hub", async () => {
      await expect(
        permissions
          .connect(validatorWithdrawalTriggerer)
          .triggerValidatorWithdrawals(pubkeys, [withdrawalAmount], stranger, {
            value: 0n,
          }),
      )
        .to.emit(vaultHub, "Mock__ValidatorWithdrawalsTriggered")
        .withArgs(stakingVault, pubkeys, [withdrawalAmount], stranger);
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(), defaultAdmin)).to.be
        .false;
      expect(await permissions.getRoleAdmin(await permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).triggerValidatorWithdrawals(pubkeys, [withdrawalAmount], stranger))
        .to.emit(vaultHub, "Mock__ValidatorWithdrawalsTriggered")
        .withArgs(stakingVault, pubkeys, [withdrawalAmount], stranger);
    });

    it("reverts if the caller is not a member of the trigger withdrawal role", async () => {
      expect(await permissions.hasRole(await permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).triggerValidatorWithdrawals(pubkeys, [withdrawalAmount], stranger))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE());
    });
  });

  context("voluntaryDisconnect()", () => {
    it("voluntarily disconnects the StakingVault", async () => {
      await expect(permissions.connect(disconnecter).voluntaryDisconnect())
        .to.emit(vaultHub, "Mock__VoluntaryDisconnect")
        .withArgs(stakingVault);
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.VOLUNTARY_DISCONNECT_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.VOLUNTARY_DISCONNECT_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).voluntaryDisconnect())
        .to.emit(vaultHub, "Mock__VoluntaryDisconnect")
        .withArgs(stakingVault);
    });

    it("reverts if the caller is not a member of the disconnect role", async () => {
      expect(await permissions.hasRole(await permissions.VOLUNTARY_DISCONNECT_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).voluntaryDisconnect())
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.VOLUNTARY_DISCONNECT_ROLE());
    });
  });

  context("transferOwnership()", () => {
    it("transfers the ownership of the StakingVault", async () => {
      await expect(permissions.connect(defaultAdmin).transferOwnership(stranger))
        .to.emit(stakingVault, "OwnershipTransferStarted")
        .withArgs(permissions, stranger);

      await expect(stakingVault.connect(stranger).acceptOwnership())
        .to.emit(stakingVault, "OwnershipTransferred")
        .withArgs(permissions, stranger);
    });

    it("reverts if the caller is not a member of the default admin role", async () => {
      expect(await permissions.hasRole(await permissions.DEFAULT_ADMIN_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).transferOwnership(stranger))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.DEFAULT_ADMIN_ROLE());
    });
  });

  context("acceptOwnership()", () => {
    it("accepts the ownership of the StakingVault", async () => {
      await permissions.connect(defaultAdmin).transferOwnership(stranger);
      await stakingVault.connect(stranger).acceptOwnership();
      expect(await stakingVault.owner()).to.equal(stranger);
      await stakingVault.connect(stranger).transferOwnership(permissions);

      await expect(permissions.connect(defaultAdmin).acceptOwnership())
        .to.emit(stakingVault, "OwnershipTransferred")
        .withArgs(stranger, permissions);
    });

    it("reverts if the caller is not a member of the default admin role", async () => {
      expect(await permissions.hasRole(await permissions.DEFAULT_ADMIN_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).acceptOwnership())
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.DEFAULT_ADMIN_ROLE());
    });
  });

  context("requestTierChange()", () => {
    it("requests a tier change", async () => {
      await expect(permissions.connect(tierChanger).changeTier(1, ether("1")))
        .to.emit(operatorGrid, "Mock__TierChanged")
        .withArgs(stakingVault, 1, ether("1"));
    });

    it("can be called by the admin of the role", async () => {
      // does not have the explicit role but is the role admin
      expect(await permissions.hasRole(await permissions.VAULT_CONFIGURATION_ROLE(), defaultAdmin)).to.be.false;
      expect(await permissions.getRoleAdmin(await permissions.VAULT_CONFIGURATION_ROLE())).to.equal(
        await permissions.DEFAULT_ADMIN_ROLE(),
      );

      await expect(permissions.connect(defaultAdmin).changeTier(1, ether("1")))
        .to.emit(operatorGrid, "Mock__TierChanged")
        .withArgs(stakingVault, 1, ether("1"));
    });

    it("reverts if the caller is not a member of the request tier change role", async () => {
      expect(await permissions.hasRole(await permissions.VAULT_CONFIGURATION_ROLE(), stranger)).to.be.false;

      await expect(permissions.connect(stranger).changeTier(1, ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.VAULT_CONFIGURATION_ROLE());
    });
  });

  async function checkSoleMember(account: HardhatEthersSigner, role: string) {
    expect(await permissions.getRoleMemberCount(role)).to.equal(1);
    expect(await permissions.getRoleMember(role, 0)).to.equal(account);
  }
});
