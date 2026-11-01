import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LazyOracle__MockForVaultHub,
  Lido,
  LidoLocator,
  StakingVault__MockForVaultHub,
  VaultHub,
  VaultOwnerACL__MockForVaultViewer,
  VaultViewer,
} from "typechain-types";

import { ether } from "lib";

import { deployVaults } from "test/deploy/vaults";
import { Snapshot } from "test/suite";

describe("VaultViewer.sol", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let lido: Lido;
  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let lazyOracle: LazyOracle__MockForVaultHub;
  let vaultViewer: VaultViewer;

  let createMockStakingVaultAndConnect: (
    owner: HardhatEthersSigner,
    operator: HardhatEthersSigner,
  ) => Promise<StakingVault__MockForVaultHub>;

  let reportVaultHelper: (report: { vault: StakingVault__MockForVaultHub; totalValue?: bigint }) => Promise<void>;

  let originalState: string;

  before(async () => {
    [deployer, user, operator, stranger] = await ethers.getSigners();

    const vaultsSetup = await deployVaults({ deployer, admin: user });
    lido = vaultsSetup.lido;
    vaultHub = vaultsSetup.vaultHub;
    lazyOracle = vaultsSetup.lazyOracle;
    createMockStakingVaultAndConnect = vaultsSetup.createMockStakingVaultAndConnect;
    reportVaultHelper = vaultsSetup.reportVault;

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), deployer);

    vaultViewer = await ethers.deployContract("VaultViewer", [await locator.getAddress()]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  describe("constructor", () => {
    it("reverts if locator is zero address", async () => {
      await expect(ethers.deployContract("VaultViewer", [ZeroAddress])).to.be.revertedWithCustomError(
        vaultViewer,
        "ZeroArgument",
      );
    });

    it("resolves protocol contracts from the locator", async () => {
      expect(await vaultViewer.LIDO_LOCATOR()).to.equal(await locator.getAddress());
      expect(await vaultViewer.VAULT_HUB()).to.equal(await vaultHub.getAddress());
      expect(await vaultViewer.LAZY_ORACLE()).to.equal(await lazyOracle.getAddress());
    });
  });

  describe("vaultsCount", () => {
    it("mirrors VaultHub.vaultsCount", async () => {
      expect(await vaultViewer.vaultsCount()).to.equal(0n);

      await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);

      expect(await vaultViewer.vaultsCount()).to.equal(2n);
    });
  });

  describe("vaultAddressesBatch", () => {
    it("reverts on zero limit", async () => {
      await expect(vaultViewer.vaultAddressesBatch(0, 0)).to.be.revertedWithCustomError(vaultViewer, "ZeroArgument");
    });

    it("returns empty array when no vaults exist", async () => {
      expect(await vaultViewer.vaultAddressesBatch(0, 10)).to.have.length(0);
    });

    it("respects offset and limit", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      const vault2 = await createMockStakingVaultAndConnect(user, operator);
      const vault3 = await createMockStakingVaultAndConnect(user, operator);

      const batch = await vaultViewer.vaultAddressesBatch(1, 2);
      expect(batch).to.deep.equal([await vault2.getAddress(), await vault3.getAddress()]);
    });

    it("returns partial batch when offset + limit exceeds vault count", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      const vault2 = await createMockStakingVaultAndConnect(user, operator);

      const batch = await vaultViewer.vaultAddressesBatch(1, 10);
      expect(batch).to.deep.equal([await vault2.getAddress()]);
    });

    it("returns empty array when offset exceeds vault count", async () => {
      await createMockStakingVaultAndConnect(user, operator);

      expect(await vaultViewer.vaultAddressesBatch(100, 10)).to.have.length(0);
    });

    it("does not overflow on max limit", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      const vault2 = await createMockStakingVaultAndConnect(user, operator);

      const batch = await vaultViewer.vaultAddressesBatch(1, MaxUint256);
      expect(batch).to.deep.equal([await vault2.getAddress()]);
    });
  });

  describe("vaultData", () => {
    it("returns aggregated data for a connected vault", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);
      await reportVaultHelper({ vault, totalValue: ether("100") });
      await lazyOracle.mock__setIsVaultQuarantined(await vault.getAddress(), true);

      const data = await vaultViewer.vaultData(await vault.getAddress());

      expect(data.vaultAddress).to.equal(await vault.getAddress());
      expect(data.connection.owner).to.equal(user.address);
      expect(data.connection.vaultIndex).to.equal(1n);
      expect(data.record.report.totalValue).to.equal(ether("100"));
      expect(data.totalValue).to.equal(await vaultHub.totalValue(vault));
      expect(data.liabilityStETH).to.equal(0n);
      // owner is an EOA, so dashboard fee getters are not available
      expect(data.nodeOperatorFeeRate).to.equal(0n);
      expect(data.accruedFee).to.equal(0n);
      expect(data.isReportFresh).to.equal(await vaultHub.isReportFresh(vault));
      expect(data.quarantineInfo.isActive).to.equal(true);
    });
  });

  describe("vaultsDataBatch", () => {
    it("reverts on zero limit", async () => {
      await expect(vaultViewer.vaultsDataBatch(0, 0)).to.be.revertedWithCustomError(vaultViewer, "ZeroArgument");
    });

    it("returns empty array when no vaults exist", async () => {
      expect(await vaultViewer.vaultsDataBatch(0, 10)).to.have.length(0);
    });

    it("returns data for vaults in the window", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      const vault2 = await createMockStakingVaultAndConnect(user, operator);
      const vault3 = await createMockStakingVaultAndConnect(user, operator);
      await reportVaultHelper({ vault: vault2, totalValue: ether("200") });

      const batch = await vaultViewer.vaultsDataBatch(1, 10);

      expect(batch).to.have.length(2);
      expect(batch[0].vaultAddress).to.equal(await vault2.getAddress());
      expect(batch[0].record.report.totalValue).to.equal(ether("200"));
      expect(batch[1].vaultAddress).to.equal(await vault3.getAddress());
    });

    it("does not overflow on max limit", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);

      expect(await vaultViewer.vaultsDataBatch(1, MaxUint256)).to.have.length(1);
    });
  });

  describe("isVaultOwner", () => {
    it("returns true for the connection owner", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      expect(await vaultViewer.isVaultOwner(vault, user)).to.equal(true);
    });

    it("returns false for a stranger", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      expect(await vaultViewer.isVaultOwner(vault, stranger)).to.equal(false);
    });

    it("returns false for zero address on a vault that is not connected", async () => {
      expect(await vaultViewer.isVaultOwner(stranger, ZeroAddress)).to.equal(false);
    });
  });

  describe("hasRole", () => {
    it("returns false when the owner is an EOA", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      expect(await vaultViewer.hasRole(vault, user, await vaultViewer.DEFAULT_ADMIN_ROLE())).to.equal(false);
    });

    it("returns false for a vault that is not connected", async () => {
      expect(await vaultViewer.hasRole(stranger, user, await vaultViewer.DEFAULT_ADMIN_ROLE())).to.equal(false);
    });
  });

  describe("vaultsByOwnerBatch", () => {
    it("reverts on zero limit", async () => {
      await expect(vaultViewer.vaultsByOwnerBatch(user, 0, 0)).to.be.revertedWithCustomError(
        vaultViewer,
        "ZeroArgument",
      );
    });

    it("returns only vaults owned by the given address", async () => {
      const vault1 = await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(stranger, operator);
      const vault3 = await createMockStakingVaultAndConnect(user, operator);

      const batch = await vaultViewer.vaultsByOwnerBatch(user, 0, 10);
      expect(batch).to.deep.equal([await vault1.getAddress(), await vault3.getAddress()]);
    });

    it("scans only the requested window", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      const vault2 = await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);

      const batch = await vaultViewer.vaultsByOwnerBatch(user, 1, 1);
      expect(batch).to.deep.equal([await vault2.getAddress()]);
    });

    it("returns empty array when offset exceeds vault count", async () => {
      await createMockStakingVaultAndConnect(user, operator);

      expect(await vaultViewer.vaultsByOwnerBatch(user, 100, 10)).to.have.length(0);
    });

    it("does not overflow on max limit", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      const vault2 = await createMockStakingVaultAndConnect(user, operator);

      const batch = await vaultViewer.vaultsByOwnerBatch(user, 1, MaxUint256);
      expect(batch).to.deep.equal([await vault2.getAddress()]);
    });
  });

  describe("vaultsByRoleBatch", () => {
    it("returns empty array when owners are EOAs", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);

      const batch = await vaultViewer.vaultsByRoleBatch(await vaultViewer.DEFAULT_ADMIN_ROLE(), user, 0, 10);
      expect(batch).to.have.length(0);
    });

    it("does not overflow on max limit", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);

      const batch = await vaultViewer.vaultsByRoleBatch(await vaultViewer.DEFAULT_ADMIN_ROLE(), user, 1, MaxUint256);
      expect(batch).to.have.length(0);
    });
  });

  describe("roleMembers", () => {
    it("returns vault, owner and node operator with empty members for an EOA owner", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);
      const roles = [await vaultViewer.DEFAULT_ADMIN_ROLE(), ethers.id("SOME_ROLE")];

      const members = await vaultViewer.roleMembers(vault, roles);

      expect(members.vault).to.equal(await vault.getAddress());
      expect(members.owner).to.equal(user.address);
      expect(members.nodeOperator).to.equal(operator.address);
      expect(members.members).to.deep.equal([[], []]);
    });

    it("returns empty members when the owner contract has no ACL and answers with empty data", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);
      const ownerMock = await ethers.deployContract("VaultOwner__MockForVaultViewer");
      await vaultHub.connect(user).transferVaultOwnership(vault, ownerMock);
      const roles = [await vaultViewer.DEFAULT_ADMIN_ROLE()];

      const members = await vaultViewer.roleMembers(vault, roles);

      expect(members.owner).to.equal(await ownerMock.getAddress());
      expect(members.members).to.deep.equal([[]]);
      expect(await vaultViewer.hasRole(vault, user, roles[0])).to.equal(false);
    });
  });

  describe("ACL owner", () => {
    const FEE_RATE = 500n;
    const ACCRUED_FEE = ether("1");
    const CUSTOM_ROLE = ethers.id("CUSTOM_ROLE");

    let vault: StakingVault__MockForVaultHub;
    let owner: VaultOwnerACL__MockForVaultViewer;
    let adminRole: string;

    beforeEach(async () => {
      vault = await createMockStakingVaultAndConnect(user, operator);
      owner = await ethers.deployContract("VaultOwnerACL__MockForVaultViewer", [user, FEE_RATE, ACCRUED_FEE]);
      await vaultHub.connect(user).transferVaultOwnership(vault, owner);
      await owner.connect(user).grantRole(CUSTOM_ROLE, stranger);
      adminRole = await vaultViewer.DEFAULT_ADMIN_ROLE();
    });

    it("hasRole matches the owner ACL", async () => {
      expect(await vaultViewer.hasRole(vault, user, adminRole)).to.equal(true);
      expect(await vaultViewer.hasRole(vault, stranger, adminRole)).to.equal(false);
      expect(await vaultViewer.hasRole(vault, stranger, CUSTOM_ROLE)).to.equal(true);
      expect(await vaultViewer.hasRole(vault, user, CUSTOM_ROLE)).to.equal(false);
    });

    it("isVaultOwner treats the owner admin as the vault owner", async () => {
      expect(await vaultViewer.isVaultOwner(vault, owner)).to.equal(true);
      expect(await vaultViewer.isVaultOwner(vault, user)).to.equal(true);
      expect(await vaultViewer.isVaultOwner(vault, stranger)).to.equal(false);
    });

    it("vaultsByOwnerBatch and vaultsByRoleBatch find the vault through the ACL", async () => {
      await createMockStakingVaultAndConnect(stranger, operator);

      expect(await vaultViewer.vaultsByOwnerBatch(user, 0, 10)).to.deep.equal([await vault.getAddress()]);
      expect(await vaultViewer.vaultsByRoleBatch(adminRole, user, 0, 10)).to.deep.equal([await vault.getAddress()]);
      expect(await vaultViewer.vaultsByRoleBatch(CUSTOM_ROLE, stranger, 0, 10)).to.deep.equal([
        await vault.getAddress(),
      ]);
      expect(await vaultViewer.vaultsByRoleBatch(CUSTOM_ROLE, user, 0, 10)).to.have.length(0);
    });

    it("roleMembers returns the members of each role", async () => {
      const members = await vaultViewer.roleMembers(vault, [adminRole, CUSTOM_ROLE, ethers.id("EMPTY_ROLE")]);

      expect(members.owner).to.equal(await owner.getAddress());
      expect(members.nodeOperator).to.equal(operator.address);
      expect(members.members).to.deep.equal([[user.address], [stranger.address], []]);
    });

    it("vaultData reads the node operator fee getters from the owner", async () => {
      const data = await vaultViewer.vaultData(vault);

      expect(data.nodeOperatorFeeRate).to.equal(FEE_RATE);
      expect(data.accruedFee).to.equal(ACCRUED_FEE);
    });
  });

  describe("malformed owner responses", () => {
    const abi = ethers.AbiCoder.defaultAbiCoder();

    async function connectWithFallbackOwner(response: string) {
      const vault = await createMockStakingVaultAndConnect(user, operator);
      const owner = await ethers.deployContract("VaultOwner__MockForVaultViewer");
      await owner.mock__setResponse(response);
      await vaultHub.connect(user).transferVaultOwnership(vault, owner);
      return vault;
    }

    it("decodes a well-formed address[] returned by a fallback", async () => {
      const vault = await connectWithFallbackOwner(abi.encode(["address[]"], [[stranger.address]]));

      const members = await vaultViewer.roleMembers(vault, [ethers.id("ROLE")]);
      expect(members.members).to.deep.equal([[stranger.address]]);
    });

    it("returns empty members on a bad offset", async () => {
      const vault = await connectWithFallbackOwner(abi.encode(["uint256", "uint256"], [64, 1]));

      const members = await vaultViewer.roleMembers(vault, [ethers.id("ROLE")]);
      expect(members.members).to.deep.equal([[]]);
    });

    it("returns empty members on a length larger than the payload", async () => {
      const vault = await connectWithFallbackOwner(abi.encode(["uint256", "uint256"], [32, MaxUint256]));

      const members = await vaultViewer.roleMembers(vault, [ethers.id("ROLE")]);
      expect(members.members).to.deep.equal([[]]);
    });

    it("returns empty members on a dirty address word", async () => {
      const vault = await connectWithFallbackOwner(abi.encode(["uint256", "uint256", "uint256"], [32, 1, MaxUint256]));

      const members = await vaultViewer.roleMembers(vault, [ethers.id("ROLE")]);
      expect(members.members).to.deep.equal([[]]);
    });

    it("hasRole is false unless the response is exactly true", async () => {
      const vault = await connectWithFallbackOwner(abi.encode(["uint256"], [2]));

      expect(await vaultViewer.hasRole(vault, user, ethers.id("ROLE"))).to.equal(false);
    });
  });

  describe("roleMembersBatch", () => {
    it("returns one entry per requested vault", async () => {
      const vault1 = await createMockStakingVaultAndConnect(user, operator);
      const vault2 = await createMockStakingVaultAndConnect(stranger, operator);
      const roles = [await vaultViewer.DEFAULT_ADMIN_ROLE()];

      const result = await vaultViewer.roleMembersBatch([vault1, vault2], roles);

      expect(result).to.have.length(2);
      expect(result[0].owner).to.equal(user.address);
      expect(result[1].owner).to.equal(stranger.address);
    });
  });
});
