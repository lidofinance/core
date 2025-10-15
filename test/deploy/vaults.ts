import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LazyOracle__MockForVaultHub,
  OperatorGrid__MockForVaultHub,
  PredepositGuarantee__HarnessForFactory,
  StakingVault__MockForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";
import { TierParamsStruct } from "typechain-types/contracts/0.8.25/vaults/OperatorGrid";

import { certainAddress, ether, findEvents, GENESIS_FORK_VERSION, impersonate, TOTAL_BASIS_POINTS } from "lib";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const CONNECT_DEPOSIT = ether("1");

const TIER_PARAMS: TierParamsStruct = {
  shareLimit: ether("10"),
  reserveRatioBP: 10_00n,
  forcedRebalanceThresholdBP: 8_00n,
  infraFeeBP: 5_00n,
  liquidityFeeBP: 4_00n,
  reservationFeeBP: 1_00n,
};

interface ReportParams {
  vault: StakingVault__MockForVaultHub;
  reportTimestamp?: bigint;
  totalValue?: bigint;
  inOutDelta?: bigint;
  liabilityShares?: bigint;
  maxLiabilityShares?: bigint;
  cumulativeLidoFees?: bigint;
  slashingReserve?: bigint;
}

interface VaultsConfig {
  deployer: HardhatEthersSigner;
  admin: HardhatEthersSigner;
}

async function createMockStakingVault(
  factory: VaultFactory__MockForVaultHub,
  owner: HardhatEthersSigner,
  operator: HardhatEthersSigner,
  predepositGuarantee: PredepositGuarantee__HarnessForFactory,
): Promise<StakingVault__MockForVaultHub> {
  const vaultCreationTx = (await factory
    .createVault(owner, operator, predepositGuarantee)
    .then((tx) => tx.wait())) as ContractTransactionReceipt;

  const events = findEvents(vaultCreationTx, "VaultCreated");
  const vaultCreatedEvent = events[0];

  return ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault);
}

async function createMockStakingVaultAndConnect(
  factory: VaultFactory__MockForVaultHub,
  deployer: HardhatEthersSigner,
  owner: HardhatEthersSigner,
  operator: HardhatEthersSigner,
  predepositGuarantee: PredepositGuarantee__HarnessForFactory,
  operatorGridMock: OperatorGrid__MockForVaultHub,
  vaultHub: VaultHub,
  tierParams?: Partial<TierParamsStruct>,
) {
  const vault = await createMockStakingVault(factory, owner, operator, predepositGuarantee);
  await vault.connect(owner).fund({ value: CONNECT_DEPOSIT });

  await operatorGridMock.changeVaultTierParams(vault, { ...TIER_PARAMS, ...tierParams });
  await vault.connect(owner).transferOwnership(vaultHub);
  await vaultHub.connect(owner).connectVault(vault);

  return vault;
}

export async function reportVault(
  lazyOracle: LazyOracle__MockForVaultHub,
  vaultHub: VaultHub,
  {
    vault,
    totalValue,
    inOutDelta,
    cumulativeLidoFees,
    liabilityShares,
    maxLiabilityShares,
    slashingReserve,
  }: ReportParams,
) {
  await lazyOracle.refreshReportTimestamp();
  const timestamp = await lazyOracle.latestReportTimestamp();
  const record = await vaultHub.vaultRecord(vault);
  const vaultTotalValue = await vaultHub.totalValue(vault);

  const activeIndex = record.inOutDelta[0].refSlot >= record.inOutDelta[1].refSlot ? 0 : 1;

  await lazyOracle.mock__report(
    vaultHub,
    vault,
    timestamp,
    totalValue ?? vaultTotalValue,
    inOutDelta ?? record.inOutDelta[activeIndex].value,
    cumulativeLidoFees ?? record.cumulativeLidoFees,
    liabilityShares ?? record.liabilityShares,
    maxLiabilityShares ?? record.maxLiabilityShares,
    slashingReserve ?? 0n,
  );
}

export async function deployVaults({ deployer, admin }: VaultsConfig) {
  const whale = await impersonate(certainAddress("lido-vaults-whale"), ether("1000000000.0"));

  const predepositGuarantee = await ethers.deployContract("PredepositGuarantee__HarnessForFactory", [
    GENESIS_FORK_VERSION,
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    0,
  ]);

  const { lido, acl } = await deployLidoDao({
    rootAccount: deployer,
    initialized: true,
    locatorConfig: { predepositGuarantee },
  });

  const locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), deployer);

  await acl.createPermission(admin, lido, await lido.RESUME_ROLE(), deployer);
  await acl.createPermission(admin, lido, await lido.STAKING_CONTROL_ROLE(), deployer);

  await lido.connect(admin).resume();
  await lido.connect(admin).setMaxExternalRatioBP(TOTAL_BASIS_POINTS);

  await lido.connect(whale).submit(deployer, { value: ether("1000.0") });

  const depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");

  // OperatorGrid
  const operatorGridMock = await ethers.deployContract("OperatorGrid__MockForVaultHub", [], { from: deployer });
  const operatorGrid = await ethers.getContractAt("OperatorGrid", operatorGridMock, deployer);
  await operatorGridMock.initialize(ether("1"));

  // LazyOracle
  const lazyOracle = await ethers.deployContract("LazyOracle__MockForVaultHub");

  await updateLidoLocatorImplementation(await locator.getAddress(), { operatorGrid, lazyOracle });

  // HashConsensus
  const hashConsensus = await ethers.deployContract("HashConsensus__MockForVaultHub");

  const vaultHubImpl = await ethers.deployContract("VaultHub", [
    locator,
    await locator.lido(),
    hashConsensus,
    VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP,
  ]);

  const vaultHubProxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

  const vaultHubAdmin = await ethers.getContractAt("VaultHub", vaultHubProxy);
  await vaultHubAdmin.initialize(deployer);

  const vaultHub = await ethers.getContractAt("VaultHub", vaultHubProxy, admin);
  await vaultHubAdmin.grantRole(await vaultHub.PAUSE_ROLE(), admin);
  await vaultHubAdmin.grantRole(await vaultHub.RESUME_ROLE(), admin);
  await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), admin);
  await vaultHubAdmin.grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), admin);

  const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [depositContract]);
  const beacon = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImpl, deployer]);

  const vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [beacon]);

  await updateLidoLocatorImplementation(await locator.getAddress(), {
    vaultHub,
    predepositGuarantee,
    operatorGrid,
    vaultFactory,
  });

  return {
    lido,
    vaultHub,
    lazyOracle,
    createMockStakingVault: (owner: HardhatEthersSigner, operator: HardhatEthersSigner) =>
      createMockStakingVault(vaultFactory, owner, operator, predepositGuarantee),
    createMockStakingVaultAndConnect: (owner: HardhatEthersSigner, operator: HardhatEthersSigner) =>
      createMockStakingVaultAndConnect(
        vaultFactory,
        deployer,
        owner,
        operator,
        predepositGuarantee,
        operatorGridMock,
        vaultHub,
      ),
    reportVault: (report: ReportParams) => reportVault(lazyOracle, vaultHub, report),
  };
}
