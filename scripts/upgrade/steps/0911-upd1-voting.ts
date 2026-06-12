import { id } from "ethers";
import { encodeCallScript, type ProposalCall, type VoteItem } from "scripts/utils/omnibus";
import { readUpgradeParameters, txWaitAndLog, upgCtx } from "scripts/utils/upgrade";

import {
  ConsolidationBus,
  ConsolidationBus__factory,
  IAccessControl__factory,
  IAragonACL__factory,
  IAragonKernel__factory,
  IForwarder__factory,
  IOracleReportSanityCheckerUpgrade__factory,
  IOssifiableProxy__factory,
  Lido__factory,
  LidoLocator,
  StakingRouter,
  StakingRouter__factory,
  TopUpGateway,
  TopUpGateway__factory,
} from "typechain-types";

import {
  ether,
  findEventsWithInterfaces,
  getAddress,
  getSignerOrImpersonate,
  loadContract,
  log,
  logConfirmReview,
  readNetworkState,
  Sk,
  updateObjectInState,
} from "lib";

const PROPOSAL_METADATA = process.env.PROPOSAL_METADATA || "proposal-metadata";

// Aragon Kernel APP_BASES_NAMESPACE
const KERNEL_APP_BASES_NAMESPACE = id("base");
const APP_MANAGER_ROLE = id("APP_MANAGER_ROLE");
const STAKING_MODULE_UNVETTING_ROLE = id("STAKING_MODULE_UNVETTING_ROLE");
const PAUSE_ROLE = id("PAUSE_ROLE");
const RESUME_ROLE = id("RESUME_ROLE");
const MANAGE_ROLE = id("MANAGE_ROLE"); // ConsolidationBus
const MANAGE_LIMITS_ROLE = id("MANAGE_LIMITS_ROLE"); // TopUpGateway

// Curated module (curated-onchain-v2) id in the StakingRouter
const CURATED_MODULE_ID = 5;

export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await getSignerOrImpersonate(holderAddress, ether("100"));

  const { tm, voting, dg } = await upgCtx(state);
  const agent = getAddress(Sk.appAgent, state);
  const kernel = getAddress(Sk.aragonKernel, state);
  const acl = getAddress(Sk.aragonAcl, state);

  // proxies
  const lido = getAddress(Sk.appLido, state);
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const accountingAddress = getAddress(Sk.accounting, state);
  const accountingOracleAddress = getAddress(Sk.accountingOracle, state);
  const validatorsExitBusOracleAddress = getAddress(Sk.validatorsExitBusOracle, state);
  const consolidationBusAddress = getAddress(Sk.consolidationBus, state);
  const consolidationMigratorAddress = getAddress(Sk.consolidationMigrator, state);
  const stakingRouterAddress = getAddress(Sk.stakingRouter, state);
  const topUpGatewayAddress = getAddress(Sk.topUpGateway, state);

  // new implementations
  const lidoAppId = state[Sk.appLido].aragonApp.id;
  const newLidoImpl = state[Sk.appLido].implementation.address;
  const newLocatorImpl = state[Sk.lidoLocator].implementation.address;
  const newAccountingImpl = state[Sk.accounting].implementation.address;
  const newAccountingOracleImpl = state[Sk.accountingOracle].implementation.address;
  const newValidatorsExitBusOracleImpl = state[Sk.validatorsExitBusOracle].implementation.address;
  const newConsolidationBusImpl = state[Sk.consolidationBus].implementation.address;
  const newConsolidationMigratorImpl = state[Sk.consolidationMigrator].implementation.address;
  const newStakingRouterImpl = state[Sk.stakingRouter].implementation.address;
  const newTopUpGatewayImpl = state[Sk.topUpGateway].implementation.address;

  // new non-proxy contracts (state entries were overwritten by the deploy script)
  const newOracleReportSanityChecker = getAddress(Sk.oracleReportSanityChecker, state);
  const newDepositSecurityModule = getAddress(Sk.depositSecurityModule, state);

  const resealManager = getAddress(Sk.resealManager, state);
  const circuitBreaker = getAddress(Sk.circuitBreaker, state);

  // get the currently active (old) DSM
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const oldDepositSecurityModule = await locator.depositSecurityModule();
  if (oldDepositSecurityModule === newDepositSecurityModule) {
    throw new Error("Old and new DepositSecurityModule addresses are the same — locator already upgraded?");
  }

  const depositsReserveTarget = parameters.lido.depositsReserveTarget;
  const maxTopUpPerBlockGwei = parameters.stakingRouter.maxTopUpPerBlockGwei;
  const consolidationBusBatchSize = parameters.consolidationBus.initialBatchSize;
  const topUpGatewayMinBlockDistance = parameters.topUpGateway.minBlockDistance;
  const curatedModuleParams = parameters.curatedModule;

  // setBatchSize/setMinBlockDistance are role-gated and only DEFAULT_ADMIN_ROLE was granted on initialize,
  // so grant/revoke the manage role around the call unless the Agent already holds it
  const consolidationBusContract = await loadContract<ConsolidationBus>("ConsolidationBus", consolidationBusAddress);
  const agentHasConsolidationBusManageRole = await consolidationBusContract.hasRole(MANAGE_ROLE, agent);
  const topUpGatewayContract = await loadContract<TopUpGateway>("TopUpGateway", topUpGatewayAddress);
  const agentHasTopUpGatewayManageLimitsRole = await topUpGatewayContract.hasRole(MANAGE_LIMITS_ROLE, agent);

  // sanity check: module id 5 must be the curated module from the parameters file
  const stakingRouterContract = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  const curatedModuleInfo = await stakingRouterContract.getStakingModule(CURATED_MODULE_ID);
  if (curatedModuleInfo.stakingModuleAddress.toLowerCase() !== curatedModuleParams.module.toLowerCase()) {
    throw new Error(
      `StakingRouter module #${CURATED_MODULE_ID} address ${curatedModuleInfo.stakingModuleAddress} ` +
        `does not match curatedModule.module ${curatedModuleParams.module} from the parameters file`,
    );
  }

  const voteDescription = process.env.VOTE_DESCRIPTION || "SRv3/CMv2 hoodi interim update";

  log("Creating new vote:", voteDescription);

  const proxyIface = IOssifiableProxy__factory.createInterface();
  const aclIface = IAragonACL__factory.createInterface();
  const kernelIface = IAragonKernel__factory.createInterface();
  const accessControlIface = IAccessControl__factory.createInterface();
  const lidoIface = Lido__factory.createInterface();
  const stakingRouterIface = StakingRouter__factory.createInterface();
  const consolidationBusIface = ConsolidationBus__factory.createInterface();
  const topUpGatewayIface = TopUpGateway__factory.createInterface();
  const oracleReportSanityCheckerIface = IOracleReportSanityCheckerUpgrade__factory.createInterface();

  /// @dev DG proposal items, executed by the Agent via forward
  const dgItems: VoteItem[] = [
    {
      description: "Upgrade LidoLocator implementation",
      call: { to: locatorAddress, data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newLocatorImpl]) },
    },
    {
      description: "Grant Aragon APP_MANAGER_ROLE to the AGENT",
      call: { to: acl, data: aclIface.encodeFunctionData("grantPermission", [agent, kernel, APP_MANAGER_ROLE]) },
    },
    {
      description: "Set Lido implementation in Kernel",
      call: {
        to: kernel,
        data: kernelIface.encodeFunctionData("setApp", [KERNEL_APP_BASES_NAMESPACE, lidoAppId, newLidoImpl]),
      },
    },
    {
      description: "Revoke Aragon APP_MANAGER_ROLE from the AGENT",
      call: { to: acl, data: aclIface.encodeFunctionData("revokePermission", [agent, kernel, APP_MANAGER_ROLE]) },
    },
    {
      description: `Set Lido deposits reserve target to ${depositsReserveTarget}`,
      call: { to: lido, data: lidoIface.encodeFunctionData("setDepositsReserveTarget", [depositsReserveTarget]) },
    },
    {
      description: "Upgrade Accounting implementation",
      call: { to: accountingAddress, data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newAccountingImpl]) },
    },
    {
      description: "Upgrade AccountingOracle implementation",
      call: {
        to: accountingOracleAddress,
        data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newAccountingOracleImpl]),
      },
    },
    {
      description: "Upgrade ValidatorsExitBusOracle implementation",
      call: {
        to: validatorsExitBusOracleAddress,
        data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newValidatorsExitBusOracleImpl]),
      },
    },
    {
      description: "Upgrade ConsolidationBus implementation",
      call: {
        to: consolidationBusAddress,
        data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newConsolidationBusImpl]),
      },
    },
    ...(agentHasConsolidationBusManageRole
      ? []
      : [
          {
            description: "Grant ConsolidationBus MANAGE_ROLE to the AGENT",
            call: {
              to: consolidationBusAddress,
              data: accessControlIface.encodeFunctionData("grantRole", [MANAGE_ROLE, agent]),
            },
          },
        ]),
    {
      description: `Set ConsolidationBus batchSize to ${consolidationBusBatchSize}`,
      call: {
        to: consolidationBusAddress,
        data: consolidationBusIface.encodeFunctionData("setBatchSize", [consolidationBusBatchSize]),
      },
    },
    ...(agentHasConsolidationBusManageRole
      ? []
      : [
          {
            description: "Revoke ConsolidationBus MANAGE_ROLE from the AGENT",
            call: {
              to: consolidationBusAddress,
              data: accessControlIface.encodeFunctionData("revokeRole", [MANAGE_ROLE, agent]),
            },
          },
        ]),
    {
      description: "Upgrade ConsolidationMigrator implementation",
      call: {
        to: consolidationMigratorAddress,
        data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newConsolidationMigratorImpl]),
      },
    },
    {
      description: "Upgrade StakingRouter implementation",
      call: {
        to: stakingRouterAddress,
        data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newStakingRouterImpl]),
      },
    },
    {
      description: `Set StakingRouter maxTopUpPerBlockGwei to ${maxTopUpPerBlockGwei}`,
      call: {
        to: stakingRouterAddress,
        data: stakingRouterIface.encodeFunctionData("setMaxTopUpPerBlockGwei", [maxTopUpPerBlockGwei]),
      },
    },
    {
      description: `Update StakingRouter module #${CURATED_MODULE_ID} (${curatedModuleParams.moduleName}) parameters`,
      call: {
        to: stakingRouterAddress,
        data: stakingRouterIface.encodeFunctionData("updateStakingModule", [
          CURATED_MODULE_ID,
          curatedModuleParams.stakeShareLimit,
          curatedModuleParams.priorityExitShareThreshold,
          curatedModuleParams.stakingModuleFee,
          curatedModuleParams.treasuryFee,
          curatedModuleParams.maxDepositsPerBlock,
          curatedModuleParams.minDepositBlockDistance,
        ]),
      },
    },
    {
      description: "Upgrade TopUpGateway implementation",
      call: { to: topUpGatewayAddress, data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newTopUpGatewayImpl]) },
    },
    {
      description: "Grant TopUpGateway PAUSE_ROLE to CircuitBreaker",
      call: {
        to: topUpGatewayAddress,
        data: accessControlIface.encodeFunctionData("grantRole", [PAUSE_ROLE, circuitBreaker]),
      },
    },
    {
      description: "Grant TopUpGateway PAUSE_ROLE to ResealManager",
      call: {
        to: topUpGatewayAddress,
        data: accessControlIface.encodeFunctionData("grantRole", [PAUSE_ROLE, resealManager]),
      },
    },
    {
      description: "Grant TopUpGateway RESUME_ROLE to ResealManager",
      call: {
        to: topUpGatewayAddress,
        data: accessControlIface.encodeFunctionData("grantRole", [RESUME_ROLE, resealManager]),
      },
    },
    ...(agentHasTopUpGatewayManageLimitsRole
      ? []
      : [
          {
            description: "Grant TopUpGateway MANAGE_LIMITS_ROLE to the AGENT",
            call: {
              to: topUpGatewayAddress,
              data: accessControlIface.encodeFunctionData("grantRole", [MANAGE_LIMITS_ROLE, agent]),
            },
          },
        ]),
    {
      description: `Set TopUpGateway minBlockDistance to ${topUpGatewayMinBlockDistance}`,
      call: {
        to: topUpGatewayAddress,
        data: topUpGatewayIface.encodeFunctionData("setMinBlockDistance", [topUpGatewayMinBlockDistance]),
      },
    },
    ...(agentHasTopUpGatewayManageLimitsRole
      ? []
      : [
          {
            description: "Revoke TopUpGateway MANAGE_LIMITS_ROLE from the AGENT",
            call: {
              to: topUpGatewayAddress,
              data: accessControlIface.encodeFunctionData("revokeRole", [MANAGE_LIMITS_ROLE, agent]),
            },
          },
        ]),
    {
      description: "Revoke STAKING_MODULE_UNVETTING_ROLE from old DSM",
      call: {
        to: stakingRouterAddress,
        data: accessControlIface.encodeFunctionData("revokeRole", [
          STAKING_MODULE_UNVETTING_ROLE,
          oldDepositSecurityModule,
        ]),
      },
    },
    {
      description: "Grant STAKING_MODULE_UNVETTING_ROLE to new DSM",
      call: {
        to: stakingRouterAddress,
        data: accessControlIface.encodeFunctionData("grantRole", [
          STAKING_MODULE_UNVETTING_ROLE,
          newDepositSecurityModule,
        ]),
      },
    },
    {
      description: "Run OracleReportSanityChecker migration",
      call: {
        to: newOracleReportSanityChecker,
        data: oracleReportSanityCheckerIface.encodeFunctionData("migrateBaselineSnapshot"),
      },
    },
  ];

  log("DG proposal items:");
  log(dgItems.map(({ description }, idx) => `${idx + 1}. ${description}`));

  /// @dev pack all DG items into a single Agent.forward call (same as UpgradeVoteScript._wrapItemsForwardPacked)
  const agentScript = encodeCallScript(dgItems.map(({ call }) => ({ to: call.to, data: call.data })));
  const proposalCalls: ProposalCall[] = [
    {
      target: agent,
      value: 0n,
      payload: IForwarder__factory.createInterface().encodeFunctionData("forward", [agentScript]),
    },
  ];
  const voteItems: VoteItem[] = [
    {
      description: "Submit a Dual Governance proposal to upgrade implementations (audit fix 1)",
      call: {
        to: dg.address,
        data: dg.interface.encodeFunctionData("submitProposal", [proposalCalls, PROPOSAL_METADATA]),
      },
    },
  ];

  log("items:");
  log(voteItems.map(({ description }) => description));
  const evmScript = encodeCallScript(voteItems.map(({ call }) => ({ to: call.to, data: call.data })));
  const evmScriptNewVote = encodeCallScript([
    {
      to: voting.address,
      data: voting.interface.encodeFunctionData("newVote(bytes,string,bool,bool)", [
        evmScript,
        voteDescription,
        false,
        false,
      ]),
    },
  ]);

  await logConfirmReview();
  log("Forwarding evmScript via TokenManager to create a new vote...");
  const tx = await tm.connect(holder).forward(evmScriptNewVote);
  const receipt = await txWaitAndLog(tx);
  const voteId = findEventsWithInterfaces(receipt, "StartVote", [voting.interface])[0].args.voteId;
  log.success("New vote created. voteId:", voteId);

  // save voteId in deployed state
  updateObjectInState(Sk.upgradeVoteScript, {
    voteState: {
      voteId,
      voteDescription,
    },
  });
  return voteId;
}
