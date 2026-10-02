import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AbiCoder,
  concat,
  ContractTransactionReceipt,
  ContractTransactionResponse,
  dataLength,
  getBytes,
  hexlify,
  Interface,
  keccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";
import { ethers } from "hardhat";

import { SecretKey } from "@chainsafe/blst";
import type { Node } from "@chainsafe/persistent-merkle-tree";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ConsolidationGateway,
  DepositContract,
  Lido,
  NodeOperatorsRegistry,
  PredepositGuarantee,
  StakingRouter,
  TokenManager,
  TopUpGateway,
  ValidatorExitDelayVerifier,
  ValidatorsExitBus,
  Voting,
  WithdrawalVault,
} from "typechain-types";

import { Panda } from "lib/panda";
import { getAddress, Sk } from "lib/state-file";

import { deployScratch } from "./deploy";
import {
  BeaconHeader,
  BeaconState,
  BeaconValidator,
  concatIndex,
  DepositData,
  DepositMessage,
  ForkData,
  Header,
  hex,
  proof,
  SigningData,
  State,
  validatorWitness,
} from "./ssz";

type Call = { to: string; data: string };
type ValidatorRecord = { index: string; status: string; balance: string; validator: BeaconValidator };
type BeaconResponse<T> = { data: T; version?: string; execution_optimistic?: boolean };
type HeaderResponse = BeaconResponse<{ canonical: boolean; root: string; header: { message: BeaconHeader } }>;
type ExecutionBlock = { number: string; hash: string; timestamp: string; parentBeaconBlockRoot: string };
type BeaconBlock = {
  message: {
    body: {
      signed_execution_payload_bid: { message: { parent_block_hash: string } };
      parent_execution_requests: {
        consolidations: { source_address: string; source_pubkey: string; target_pubkey: string }[];
      };
    };
  };
};
type Deployment = Awaited<ReturnType<typeof deployScratch>>;
const BEACON_ROOTS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02";
export const damaged = (value: string): string => {
  const bytes = getBytes(value);
  bytes[0] ^= 1;
  return hexlify(bytes);
};
const headerInput = (h: BeaconHeader) => ({
  slot: h.slot,
  proposerIndex: h.proposer_index,
  parentRoot: h.parent_root,
  stateRoot: h.state_root,
  bodyRoot: h.body_root,
});
const script = (calls: Call[]): string =>
  concat(["0x00000001", ...calls.flatMap((c) => [c.to, toBeHex(dataLength(c.data), 4), c.data])]);

export interface PandaProtocolContracts {
  predepositGuarantee: PredepositGuarantee;
  topUpGateway: TopUpGateway;
  consolidationGateway: ConsolidationGateway;
  validatorExitDelayVerifier: ValidatorExitDelayVerifier;
  validatorsExitBusOracle: ValidatorsExitBus;
  lido: Lido;
  nor: NodeOperatorsRegistry;
  stakingRouter: StakingRouter;
  voting: Voting;
  tokenManager: TokenManager;
  withdrawalVault: WithdrawalVault;
  depositContract: DepositContract;
}

export interface ModuleFixture {
  moduleId: bigint;
  operatorId: number;
  keyIndex: number;
}

export interface AnchoredState {
  label: string;
  tree: Node;
  state: BeaconState;
  header: BeaconHeader;
  root: string;
  timestamp: number;
  beacon: { header: ReturnType<typeof headerInput>; rootsTimestamp: number };
  witness(index: number): ReturnType<typeof validatorWitness>;
}

type FieldCoordinate = { a: string; b: string };
export interface DepositFixture {
  secret: SecretKey;
  pubkey: string;
  signature: string;
  amount: bigint;
  withdrawalCredentials: string;
  deposit: { pubkey: string; signature: string; amount: bigint; depositDataRoot: string };
  y: { pubkeyY: FieldCoordinate; signatureY: { c0_a: string; c0_b: string; c1_a: string; c1_b: string } };
}

export interface ExitRequestBatch {
  data: string;
  dataFormat: number;
  deliveryTimestamp: bigint;
  module: ModuleFixture;
  validators: BeaconValidator[];
}

export interface PandaProtocolContext {
  panda: Panda;
  deployment: Deployment;
  signer: HardhatEthersSigner;
  contracts: PandaProtocolContracts;
  modules: { curated: ModuleFixture; compounding: ModuleFixture };
  genesis: Record<string, string>;
  spec: Record<string, string>;
  withdrawalCredentials: string;
  evidence: {
    receipts: { method: string; hash: string; blockNumber: number; gasUsed: string; status: number }[];
    captures: {
      label: string;
      slot: string;
      stateRoot: string;
      blockRoot: string;
      childTimestamp: number;
      validatorCount: number;
      executionHash: string;
      executionNumber: string;
    }[];
  };
}

/** Connect the scratch deployment and enable verifier calls through a real DAO vote. */
export async function getPandaProtocolContext(
  panda: Panda,
  deployment: Deployment,
  signer: HardhatEthersSigner,
): Promise<PandaProtocolContext> {
  const address = (key: Sk) => getAddress(key, deployment.state);
  const genesis = (await panda.beacon<BeaconResponse<Record<string, string>>>("/eth/v1/beacon/genesis")).data;
  const spec = (await panda.beacon<BeaconResponse<Record<string, string>>>("/eth/v1/config/spec")).data;
  const contracts: PandaProtocolContracts = {
    predepositGuarantee: await ethers.getContractAt("PredepositGuarantee", address(Sk.predepositGuarantee), signer),
    topUpGateway: await ethers.getContractAt("TopUpGateway", address(Sk.topUpGateway), signer),
    consolidationGateway: await ethers.getContractAt("ConsolidationGateway", address(Sk.consolidationGateway), signer),
    validatorExitDelayVerifier: await ethers.getContractAt(
      "ValidatorExitDelayVerifier",
      address(Sk.validatorExitDelayVerifier),
      signer,
    ),
    validatorsExitBusOracle: await ethers.getContractAt(
      "ValidatorsExitBus",
      address(Sk.validatorsExitBusOracle),
      signer,
    ),
    lido: await ethers.getContractAt("Lido", address(Sk.appLido), signer),
    nor: await ethers.getContractAt("NodeOperatorsRegistry", address(Sk.appNodeOperatorsRegistry), signer),
    stakingRouter: await ethers.getContractAt("StakingRouter", address(Sk.stakingRouter), signer),
    voting: await ethers.getContractAt("Voting", address(Sk.appVoting), signer),
    tokenManager: await ethers.getContractAt("TokenManager", address(Sk.appTokenManager), signer),
    withdrawalVault: await ethers.getContractAt("WithdrawalVault", address(Sk.withdrawalVault), signer),
    depositContract: await ethers.getContractAt("DepositContract", spec.DEPOSIT_CONTRACT_ADDRESS, signer),
  };
  const modules = await contracts.stakingRouter.getStakingModules();
  const moduleFixture = (contractAddress: string): ModuleFixture => {
    const module = modules.find(
      (candidate) => candidate.stakingModuleAddress.toLowerCase() === contractAddress.toLowerCase(),
    );
    assert.ok(module, `Scratch staking module ${contractAddress} must be registered`);
    // These are routing inputs for verifier tests, not a claim that the CL key was registered in the module.
    return { moduleId: module.id, operatorId: 0, keyIndex: 0 };
  };
  const ctx: PandaProtocolContext = {
    panda,
    deployment,
    signer,
    contracts,
    modules: {
      curated: moduleFixture(address(Sk.appNodeOperatorsRegistry)),
      compounding: moduleFixture(address(Sk.sm_CM)),
    },
    genesis,
    spec,
    withdrawalCredentials: concat(["0x02", "0x" + "00".repeat(11), await contracts.withdrawalVault.getAddress()]),
    evidence: { receipts: [], captures: [] },
  };
  await enableVerifierCalls(ctx);
  return ctx;
}

/** Preserve the typed contract call and save its actual mined receipt. */
export async function recordTransaction(
  ctx: PandaProtocolContext,
  pending: Promise<ContractTransactionResponse>,
): Promise<ContractTransactionReceipt> {
  const tx = await pending;
  const receipt = await tx.wait(1, 120_000);
  assert.ok(receipt);
  const contract = Object.values(ctx.contracts).find(
    (candidate) => String(candidate.target).toLowerCase() === tx.to?.toLowerCase(),
  );
  const method = contract?.interface.parseTransaction(tx)?.name ?? tx.data.slice(0, 10);
  assert.equal(receipt.status, 1, `${method} receipt`);
  ctx.evidence.receipts.push({
    method,
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: String(receipt.gasUsed),
    status: receipt.status!,
  });
  return receipt;
}

async function executeVote(ctx: PandaProtocolContext, calls: Call[]) {
  const { tokenManager, voting } = ctx.contracts;
  const agent = ctx.deployment.state[Sk.appAgent].proxy.address;
  const abi = new Interface(["function execute(address,uint256,bytes)"]);
  const execution = script(
    calls.map((call) => ({ to: agent, data: abi.encodeFunctionData("execute", [call.to, 0, call.data]) })),
  );
  const receipt = await recordTransaction(
    ctx,
    tokenManager.forward(
      script([
        {
          to: String(voting.target),
          data: voting.interface.encodeFunctionData("newVote(bytes,string)", [execution, "Panda verifier fixture"]),
        },
      ]),
    ),
  );
  const event = receipt.logs
    .filter((log) => log.address.toLowerCase() === String(voting.target).toLowerCase())
    .map((log) => voting.interface.parseLog(log))
    .find((log) => log?.name === "StartVote");
  assert.ok(event, "Real DAO vote was created");
  const voteId = event.args.voteId;
  await recordTransaction(ctx, voting.vote(voteId, true, false));
  const voted = await voting.getVote(voteId);
  const target = voted.startDate + (await voting.voteTime());
  const now = BigInt((await ctx.panda.status()).el.timestamp);
  await ctx.panda.advanceSlots(Number((target - now + 11n) / 12n));
  assert.equal(await voting.canExecute(voteId), true);
  await recordTransaction(ctx, voting.executeVote(voteId));
  assert.equal((await voting.getVote(voteId)).executed, true);
}

async function enableVerifierCalls(ctx: PandaProtocolContext) {
  const { topUpGateway, consolidationGateway, validatorsExitBusOracle, lido } = ctx.contracts;
  const agent = ctx.deployment.state[Sk.appAgent].proxy.address;
  const calls: Call[] = [];
  const grants: [TopUpGateway | ConsolidationGateway | ValidatorsExitBus, string][] = [
    [topUpGateway, await topUpGateway.TOP_UP_ROLE()],
    [consolidationGateway, await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE()],
    [validatorsExitBusOracle, await validatorsExitBusOracle.SUBMIT_REPORT_HASH_ROLE()],
  ];
  for (const [contract, role] of grants) {
    calls.push({
      to: String(contract.target),
      data: contract.interface.encodeFunctionData("grantRole", [role, ctx.signer.address]),
    });
    if (await contract.isPaused()) {
      const resume = await contract.RESUME_ROLE();
      const already = await contract.hasRole(resume, agent);
      if (!already)
        calls.push({
          to: String(contract.target),
          data: contract.interface.encodeFunctionData("grantRole", [resume, agent]),
        });
      calls.push({ to: String(contract.target), data: contract.interface.encodeFunctionData("resume") });
      if (!already)
        calls.push({
          to: String(contract.target),
          data: contract.interface.encodeFunctionData("revokeRole", [resume, agent]),
        });
    }
  }
  if (await lido.isStopped())
    calls.push({ to: String(lido.target), data: lido.interface.encodeFunctionData("resume") });
  else if (await lido.isStakingPaused())
    calls.push({ to: String(lido.target), data: lido.interface.encodeFunctionData("resumeStaking") });
  await executeVote(ctx, calls);
  assert.equal(await lido.canDeposit(), true);
}

/** Advance one slot to anchor the current canonical CL head in the real EL EIP-4788 contract. */
export async function anchorHead(ctx: PandaProtocolContext, label: string): Promise<AnchoredState> {
  const response = await ctx.panda.beacon<HeaderResponse>("/eth/v1/beacon/headers/head");
  assert.equal(response.execution_optimistic, false);
  assert.equal(response.data.canonical, true);
  const header = response.data.header.message;
  const stateResponse = await ctx.panda.beacon<BeaconResponse<BeaconState>>(
    `/eth/v2/debug/beacon/states/${header.state_root}`,
  );
  assert.equal(stateResponse.version, "gloas");
  assert.equal(stateResponse.execution_optimistic, false);
  const state = stateResponse.data;
  assert.equal(state.slot, header.slot);
  const tree = State.node(state);
  assert.equal(hex(tree.root), header.state_root, "Independent SSZ state root must equal Lighthouse");
  assert.equal(hex(Header.node(header).root), response.data.root, "Independent header root must equal Lighthouse");
  const execution = await ctx.panda.assertExecution(response.data.root);
  assert.equal(execution.slot, header.slot, "Captured CL state and execution payload must belong to the same slot");
  await ctx.panda.advanceSlots(1);
  const child = await ctx.panda.rpc<ExecutionBlock>("eth_getBlockByNumber", ["latest", false]);
  assert.equal(child.parentBeaconBlockRoot, response.data.root, "EL child commits the actual CL parent");
  const timestamp = Number(BigInt(child.timestamp));
  const anchor = await ctx.signer.provider.call({
    to: BEACON_ROOTS,
    data: AbiCoder.defaultAbiCoder().encode(["uint64"], [timestamp]),
  });
  assert.equal(anchor, response.data.root, "EIP-4788 must contain the actual block root");
  const result = {
    label,
    tree,
    state,
    header,
    root: anchor,
    timestamp,
    beacon: { header: headerInput(header), rootsTimestamp: timestamp },
    witness: (index: number) => validatorWitness(tree, state, header, index, timestamp),
  };
  ctx.evidence.captures.push({
    label,
    slot: header.slot,
    stateRoot: header.state_root,
    blockRoot: anchor,
    childTimestamp: timestamp,
    validatorCount: state.validators.length,
    executionHash: execution.executionHash,
    executionNumber: execution.executionNumber,
  });
  await writeFile(
    path.join(ctx.panda.directory, `${label}.json`),
    JSON.stringify({ header: response, state: stateResponse, execution }),
  );
  return result;
}
export function buildDeposit(
  ctx: PandaProtocolContext,
  { amount = 32n * 10n ** 18n, wrongDomain = false } = {},
): DepositFixture {
  const secret = SecretKey.fromKeygen(randomBytes(32));
  const publicKey = secret.toPublicKey();
  const pubkey = hex(publicKey.toBytes());
  const message = { pubkey, withdrawal_credentials: ctx.withdrawalCredentials, amount: String(amount / 10n ** 9n) };
  const fork = hex(
    ForkData.node({
      current_version: wrongDomain ? "0xffffffff" : ctx.genesis.genesis_fork_version,
      genesis_validators_root: "0x" + "00".repeat(32),
    }).root,
  );
  const domain = concat(["0x03000000", getBytes(fork).slice(0, 28)]);
  const signed = SigningData.node({ object_root: hex(DepositMessage.node(message).root), domain }).root;
  const signature = secret.sign(signed);
  const fp = (value: Uint8Array) => ({
    a: zeroPadValue(hex(value.subarray(0, 16)), 32),
    b: hex(value.subarray(16, 48)),
  });
  const pkY = fp(publicKey.toBytes(false).subarray(48));
  const sigY = signature.toBytes(false).subarray(96),
    c1 = fp(sigY.subarray(0, 48)),
    c0 = fp(sigY.subarray(48));
  const data = { ...message, signature: hex(signature.toBytes()) };
  return {
    secret,
    pubkey,
    signature: data.signature,
    amount,
    withdrawalCredentials: ctx.withdrawalCredentials,
    deposit: { pubkey, signature: data.signature, amount, depositDataRoot: hex(DepositData.node(data).root) },
    y: { pubkeyY: pkY, signatureY: { c0_a: c0.a, c0_b: c0.b, c1_a: c1.a, c1_b: c1.b } },
  };
}
export async function importValidator(ctx: PandaProtocolContext, fixture: DepositFixture) {
  const password = randomBytes(32).toString("hex");
  const salt = randomBytes(32),
    iv = randomBytes(16);
  const key = pbkdf2Sync(password, salt, 262144, 32, "sha256");
  const cipher = createCipheriv("aes-128-ctr", key.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(fixture.secret.toBytes()), cipher.final()]);
  const checksum = createHash("sha256").update(key.subarray(16)).update(ciphertext).digest("hex");
  await ctx.panda.importValidator(
    JSON.stringify({
      version: 4,
      uuid: randomUUID(),
      pubkey: fixture.pubkey.slice(2),
      path: "",
      crypto: {
        kdf: {
          function: "pbkdf2",
          params: { dklen: 32, c: 262144, prf: "hmac-sha256", salt: salt.toString("hex") },
          message: "",
        },
        cipher: { function: "aes-128-ctr", params: { iv: iv.toString("hex") }, message: ciphertext.toString("hex") },
        checksum: { function: "sha256", params: {}, message: checksum },
      },
    }),
    password,
  );
}
export function depositValidator(ctx: PandaProtocolContext, fixture: DepositFixture) {
  return recordTransaction(
    ctx,
    ctx.contracts.depositContract.deposit(
      fixture.pubkey,
      fixture.withdrawalCredentials,
      fixture.signature,
      fixture.deposit.depositDataRoot,
      { value: fixture.amount },
    ),
  );
}
export async function advanceUntilValidator(
  ctx: PandaProtocolContext,
  pubkey: string,
  { active = false, maxSlots = 256 } = {},
): Promise<ValidatorRecord> {
  for (let slots = 0; slots <= maxSlots; slots += 32) {
    const data = (await ctx.panda.beacon<BeaconResponse<ValidatorRecord[]>>("/eth/v1/beacon/states/head/validators"))
      .data;
    const found = data.find((v) => v.validator.pubkey === pubkey);
    if (found && (!active || found.status === "active_ongoing")) return found;
    if (slots === maxSlots) break;
    await ctx.panda.advanceSlots(32);
  }
  assert.fail(`Validator ${pubkey} did not become ${active ? "active" : "visible"} within ${maxSlots} slots`);
}
export function buildTopUpInput(anchor: AnchoredState, index: number, module: ModuleFixture) {
  const witness = anchor.witness(index);
  return {
    moduleId: module.moduleId,
    keyIndices: [module.keyIndex],
    operatorIds: [module.operatorId],
    validatorIndices: [index],
    beaconRootData: witness.beacon,
    validatorWitness: [witness.validator],
    pendingBalanceGwei: [0],
  };
}

export async function submitExitRequests(
  ctx: PandaProtocolContext,
  anchor: AnchoredState,
  indices: number[],
  module: ModuleFixture,
): Promise<ExitRequestBatch> {
  const { validatorsExitBusOracle } = ctx.contracts;
  const data = concat(
    indices.map((index) =>
      concat([
        toBeHex(module.moduleId, 3),
        toBeHex(module.operatorId, 5),
        toBeHex(index, 8),
        anchor.state.validators[index].pubkey,
      ]),
    ),
  );
  const request = { data, dataFormat: 1 };
  const hash = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [data, 1]));
  await recordTransaction(ctx, validatorsExitBusOracle.submitExitRequestsHash(hash));
  await recordTransaction(ctx, validatorsExitBusOracle.submitExitRequestsData(request));
  return {
    ...request,
    deliveryTimestamp: await validatorsExitBusOracle.getDeliveryTimestamp(hash),
    module,
    validators: indices.map((index) => anchor.state.validators[index]),
  };
}
export async function readFinalizedCheckpoint(ctx: PandaProtocolContext) {
  const checkpoint = await ctx.panda.finalized();
  assert.ok(checkpoint, "CL must finalize a non-genesis checkpoint");
  return checkpoint;
}
export async function advanceToHistoricalSummary(ctx: PandaProtocolContext, capture: AnchoredState) {
  const oldSlot = Number(capture.header.slot),
    boundary = (Math.floor(oldSlot / 8192) + 1) * 8192;
  // Explicit time-jump scenario: the current bake skips empty slots. This tests
  // real historical transitions, not complete validator duty/economics coverage.
  await ctx.panda.advanceTo(Number(ctx.genesis.genesis_time) + boundary * 12 + 11.5, { mode: "fast" });
  const recent = await anchorHead(ctx, "historical-anchor");
  const index = Math.floor(oldSlot / 8192);
  const roots = State.fields.block_roots.node(recent.state.block_roots);
  assert.equal(recent.state.block_roots[oldSlot % 8192], capture.root);
  assert.equal(hex(roots.root), recent.state.historical_summaries[index].block_summary_root);
  const summaryGI = concatIndex(State.index("historical_summaries"), (2n << 24n) + BigInt(index));
  const oldProof = [...proof(roots, 8192n + BigInt(oldSlot % 8192)), ...proof(recent.tree, concatIndex(summaryGI, 2n))];
  return { recent, old: { header: headerInput(capture.header), proof: oldProof } };
}
export async function readValidator(ctx: PandaProtocolContext, index: number): Promise<ValidatorRecord> {
  return (await ctx.panda.beacon<BeaconResponse<ValidatorRecord>>(`/eth/v1/beacon/states/head/validators/${index}`))
    .data;
}
export async function advanceUntilFinalized(ctx: PandaProtocolContext, number: number): Promise<void> {
  for (let slots = 0; slots <= 128; slots += 32) {
    const finalized = await ctx.panda.finalized();
    if (finalized && BigInt(finalized.executionNumber) >= BigInt(number)) return;
    if (slots < 128) await ctx.panda.advanceSlots(32);
  }
  assert.fail(`EL block ${number} was not confirmed by CL finality within 128 slots`);
}
export async function advanceUntilConsolidationRequest(
  ctx: PandaProtocolContext,
  source: string,
  target: string,
): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await ctx.panda.advanceSlots(1);
    const block = await ctx.panda.beacon<BeaconResponse<BeaconBlock>>("/eth/v2/beacon/blocks/head");
    const found = block.data.message.body.parent_execution_requests.consolidations.find(
      (r) => r.source_pubkey === source && r.target_pubkey === target,
    );
    if (found) {
      assert.equal(found.source_address.toLowerCase(), String(ctx.contracts.withdrawalVault.target).toLowerCase());
      return;
    }
  }
  assert.fail("Consolidation request never reached CL parent_execution_requests");
}
export function exitEligibilityTimestamp(
  ctx: PandaProtocolContext,
  request: ExitRequestBatch,
  validator: BeaconValidator,
  committeePeriod: bigint,
): bigint {
  const activationTimestamp = BigInt(ctx.genesis.genesis_time) + BigInt(validator.activation_epoch) * 32n * 12n;
  const earliest = activationTimestamp + committeePeriod;
  return request.deliveryTimestamp > earliest ? request.deliveryTimestamp : earliest;
}

export async function advancePastExitDeadline(ctx: PandaProtocolContext, request: ExitRequestBatch): Promise<void> {
  const { validatorExitDelayVerifier, nor } = ctx.contracts;
  const committeePeriod = await validatorExitDelayVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS();
  const eligibility = request.validators.map((validator) =>
    exitEligibilityTimestamp(ctx, request, validator, committeePeriod),
  );
  const latestEligibility = eligibility.reduce((latest, timestamp) => (timestamp > latest ? timestamp : latest));
  const deadline = latestEligibility + (await nor.exitDeadlineThreshold(request.module.operatorId)) + 24n;
  await ctx.panda.advanceTo(Number(deadline) + 11.5, { mode: "fast" });
}
