import { id } from "ethers";
import { encodeCallScript, type ProposalCall, type VoteItem } from "scripts/utils/omnibus";
import { readUpgradeParameters, txWaitAndLog, upgCtx } from "scripts/utils/upgrade";

import {
  IAccessControl__factory,
  IAragonACL__factory,
  IAragonKernel__factory,
  IForwarder__factory,
  IOssifiableProxy__factory,
  Lido__factory,
  LidoLocator,
  StakingRouter__factory,
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
  const accounting = getAddress(Sk.accounting, state);
  const consolidationBus = getAddress(Sk.consolidationBus, state);
  const stakingRouter = getAddress(Sk.stakingRouter, state);
  const topUpGateway = getAddress(Sk.topUpGateway, state);

  // new implementations
  const lidoAppId = state[Sk.appLido].aragonApp.id;
  const newLidoImpl = state[Sk.appLido].implementation.address;
  const newLocatorImpl = state[Sk.lidoLocator].implementation.address;
  const newAccountingImpl = state[Sk.accounting].implementation.address;
  const newConsolidationBusImpl = state[Sk.consolidationBus].implementation.address;
  const newStakingRouterImpl = state[Sk.stakingRouter].implementation.address;
  const newTopUpGatewayImpl = state[Sk.topUpGateway].implementation.address;

  // new non-proxy contracts (state entries were overwritten by the deploy script)
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

  const voteDescription = process.env.VOTE_DESCRIPTION || "SRv3/CMv2 hoodi interim update";

  log("Creating new vote:", voteDescription);

  const proxyIface = IOssifiableProxy__factory.createInterface();
  const aclIface = IAragonACL__factory.createInterface();
  const kernelIface = IAragonKernel__factory.createInterface();
  const accessControlIface = IAccessControl__factory.createInterface();
  const lidoIface = Lido__factory.createInterface();
  const stakingRouterIface = StakingRouter__factory.createInterface();

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
      call: { to: accounting, data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newAccountingImpl]) },
    },
    {
      description: "Upgrade ConsolidationBus implementation",
      call: {
        to: consolidationBus,
        data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newConsolidationBusImpl]),
      },
    },
    {
      description: "Upgrade StakingRouter implementation",
      call: { to: stakingRouter, data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newStakingRouterImpl]) },
    },
    {
      description: `Set StakingRouter maxTopUpPerBlockGwei to ${maxTopUpPerBlockGwei}`,
      call: {
        to: stakingRouter,
        data: stakingRouterIface.encodeFunctionData("setMaxTopUpPerBlockGwei", [maxTopUpPerBlockGwei]),
      },
    },
    {
      description: "Upgrade TopUpGateway implementation",
      call: { to: topUpGateway, data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newTopUpGatewayImpl]) },
    },
    {
      description: "Grant TopUpGateway PAUSE_ROLE to CircuitBreaker",
      call: {
        to: topUpGateway,
        data: accessControlIface.encodeFunctionData("grantRole", [PAUSE_ROLE, circuitBreaker]),
      },
    },
    {
      description: "Grant TopUpGateway PAUSE_ROLE to ResealManager",
      call: {
        to: topUpGateway,
        data: accessControlIface.encodeFunctionData("grantRole", [PAUSE_ROLE, resealManager]),
      },
    },
    {
      description: "Grant TopUpGateway RESUME_ROLE to ResealManager",
      call: {
        to: topUpGateway,
        data: accessControlIface.encodeFunctionData("grantRole", [RESUME_ROLE, resealManager]),
      },
    },
    {
      description: "Revoke STAKING_MODULE_UNVETTING_ROLE from old DSM",
      call: {
        to: stakingRouter,
        data: accessControlIface.encodeFunctionData("revokeRole", [
          STAKING_MODULE_UNVETTING_ROLE,
          oldDepositSecurityModule,
        ]),
      },
    },
    {
      description: "Grant STAKING_MODULE_UNVETTING_ROLE to new DSM",
      call: {
        to: stakingRouter,
        data: accessControlIface.encodeFunctionData("grantRole", [
          STAKING_MODULE_UNVETTING_ROLE,
          newDepositSecurityModule,
        ]),
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
