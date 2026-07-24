import { id } from "ethers";
import { encodeCallScript, type ProposalCall, type VoteItem } from "scripts/utils/omnibus";
import { txWaitAndLog, upgCtx } from "scripts/utils/upgrade";

import {
  IAccessControl__factory,
  IForwarder__factory,
  IOracleReportSanityCheckerUpgrade__factory,
  IOssifiableProxy__factory,
  LidoLocator,
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
const STAKING_MODULE_UNVETTING_ROLE = id("STAKING_MODULE_UNVETTING_ROLE");

// Curated module (curated-onchain-v2) id in the StakingRouter

export async function main() {
  const state = readNetworkState();
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await getSignerOrImpersonate(holderAddress, ether("100"));

  const { tm, voting, dg } = await upgCtx(state);
  const agent = getAddress(Sk.appAgent, state);

  // proxies
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const stakingRouterAddress = getAddress(Sk.stakingRouter, state);

  // new implementations
  const newLocatorImpl = state[Sk.lidoLocator].implementation.address;

  // new non-proxy contracts (state entries were overwritten by the deploy script)
  const newOracleReportSanityChecker = getAddress(Sk.oracleReportSanityChecker, state);
  const newDepositSecurityModule = getAddress(Sk.depositSecurityModule, state);

  // get the currently active (old) DSM
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const oldDepositSecurityModule = await locator.depositSecurityModule();
  if (oldDepositSecurityModule === newDepositSecurityModule) {
    throw new Error("Old and new DepositSecurityModule addresses are the same — locator already upgraded?");
  }

  const voteDescription = process.env.VOTE_DESCRIPTION || "SRv3/CMv2 hoodi DSM/OSC upgrade (update2)";

  log("Creating new vote:", voteDescription);

  const proxyIface = IOssifiableProxy__factory.createInterface();
  const accessControlIface = IAccessControl__factory.createInterface();
  const oracleReportSanityCheckerIface = IOracleReportSanityCheckerUpgrade__factory.createInterface();

  /// @dev DG proposal items, executed by the Agent via forward
  const dgItems: VoteItem[] = [
    {
      description: "Upgrade LidoLocator implementation",
      call: { to: locatorAddress, data: proxyIface.encodeFunctionData("proxy__upgradeTo", [newLocatorImpl]) },
    },
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
