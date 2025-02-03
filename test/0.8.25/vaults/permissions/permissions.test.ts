import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForStakingVault,
  Permissions__Harness,
  Permissions__Harness__factory,
  StakingVault,
  StakingVault__factory,
  UpgradeableBeacon,
  VaultFactory__MockPermissions,
  VaultHub__MockPermissions,
} from "typechain-types";
import { PermissionsConfigStruct } from "typechain-types/test/0.8.25/vaults/permissions/contracts/VaultFactory__MockPermissions";

import { days, findEvents } from "lib";

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
  let exitRequester: HardhatEthersSigner;
  let disconnecter: HardhatEthersSigner;

  let depositContract: DepositContract__MockForStakingVault;
  let permissionsImpl: Permissions__Harness;
  let stakingVaultImpl: StakingVault;
  let vaultHub: VaultHub__MockPermissions;
  let beacon: UpgradeableBeacon;
  let vaultFactory: VaultFactory__MockPermissions;
  let stakingVault: StakingVault;
  let permissions: Permissions__Harness;

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
      exitRequester,
      disconnecter,
    ] = await ethers.getSigners();

    // 1. Deploy DepositContract
    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");

    // 2. Deploy VaultHub
    vaultHub = await ethers.deployContract("VaultHub__MockPermissions");

    // 3. Deploy StakingVault implementation
    stakingVaultImpl = await ethers.deployContract("StakingVault", [vaultHub, depositContract]);
    expect(await stakingVaultImpl.vaultHub()).to.equal(vaultHub);
    expect(await stakingVaultImpl.depositContract()).to.equal(depositContract);

    // 4. Deploy Beacon and use StakingVault implementation as initial implementation
    beacon = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImpl, deployer]);

    // 5. Deploy Permissions implementation
    permissionsImpl = await ethers.deployContract("Permissions__Harness");

    // 6. Deploy VaultFactory and use Beacon and Permissions implementations
    vaultFactory = await ethers.deployContract("VaultFactory__MockPermissions", [beacon, permissionsImpl]);

    // 7. Create StakingVault and Permissions proxies using VaultFactory
    const vaultCreationTx = await vaultFactory.connect(deployer).createVaultWithPermissions(
      {
        defaultAdmin,
        nodeOperator,
        confirmLifetime: days(7n),
        funder,
        withdrawer,
        minter,
        burner,
        rebalancer,
        depositPauser,
        depositResumer,
        exitRequester,
        disconnecter,
      } as PermissionsConfigStruct,
      "0x",
    );
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

  context("initial permissions", () => {
    it("should have the correct roles", async () => {
      await checkSoleMember(defaultAdmin, await permissions.DEFAULT_ADMIN_ROLE());
      await checkSoleMember(funder, await permissions.FUND_ROLE());
      await checkSoleMember(withdrawer, await permissions.WITHDRAW_ROLE());
      await checkSoleMember(minter, await permissions.MINT_ROLE());
      await checkSoleMember(burner, await permissions.BURN_ROLE());
      await checkSoleMember(rebalancer, await permissions.REBALANCE_ROLE());
    });
  });

  async function checkSoleMember(account: HardhatEthersSigner, role: string) {
    expect(await permissions.getRoleMemberCount(role)).to.equal(1);
    expect(await permissions.getRoleMember(role, 0)).to.equal(account);
  }
});
