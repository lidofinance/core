import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AbiCoder,
  BaseContract,
  concat,
  ContractTransactionResponse,
  dataLength,
  getBytes,
  hexlify,
  Interface,
  keccak256,
  toBeHex,
  TransactionReceipt,
  TransactionRequest,
  zeroPadValue,
} from "ethers";
import { artifacts, ethers } from "hardhat";

import { SecretKey } from "@chainsafe/blst";
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
import { DeploymentState, getAddress, Sk } from "lib/state-file";

import { DEPLOYER, deployScratch } from "./deploy";
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

export class Protocol {
  readonly state: DeploymentState;
  readonly account: string;
  readonly provider;
  readonly receipts: { method: string; hash: string; blockNumber: number; gasUsed: string; status: number }[] = [];
  readonly captures: {
    label: string;
    slot: string;
    stateRoot: string;
    blockRoot: string;
    childTimestamp: number;
    validatorCount: number;
  }[] = [];
  pdg!: PredepositGuarantee;
  topUp!: TopUpGateway;
  consolidation!: ConsolidationGateway;
  exitVerifier!: ValidatorExitDelayVerifier;
  veb!: ValidatorsExitBus;
  lido!: Lido;
  nor!: NodeOperatorsRegistry;
  router!: StakingRouter;
  voting!: Voting;
  tokenManager!: TokenManager;
  withdrawalVault!: WithdrawalVault;
  deposit!: DepositContract;
  genesis!: Record<string, string>;
  spec!: Record<string, string>;
  wc!: string;

  constructor(
    readonly panda: Panda,
    readonly deployment: Deployment,
    readonly signer: HardhatEthersSigner,
  ) {
    this.state = deployment.state;
    this.provider = signer.provider;
    this.account = signer.address;
  }
  async contract<T extends BaseContract>(name: string, key: Sk): Promise<T> {
    const { abi } = await artifacts.readArtifact(name);
    return new ethers.Contract(getAddress(key, this.state), abi, this.signer) as unknown as T;
  }
  async initialize() {
    this.pdg = await this.contract("PredepositGuarantee", Sk.predepositGuarantee);
    this.topUp = await this.contract("TopUpGateway", Sk.topUpGateway);
    this.consolidation = await this.contract("ConsolidationGateway", Sk.consolidationGateway);
    this.exitVerifier = await this.contract("ValidatorExitDelayVerifier", Sk.validatorExitDelayVerifier);
    this.veb = await this.contract("ValidatorsExitBus", Sk.validatorsExitBusOracle);
    this.lido = await this.contract("Lido", Sk.appLido);
    this.nor = await this.contract("NodeOperatorsRegistry", Sk.appNodeOperatorsRegistry);
    this.router = await this.contract("StakingRouter", Sk.stakingRouter);
    this.voting = await this.contract("Voting", Sk.appVoting);
    this.tokenManager = await this.contract("TokenManager", Sk.appTokenManager);
    this.withdrawalVault = await this.contract("WithdrawalVault", Sk.withdrawalVault);
    this.genesis = (await this.panda.beacon<BeaconResponse<Record<string, string>>>("/eth/v1/beacon/genesis")).data;
    this.spec = (await this.panda.beacon<BeaconResponse<Record<string, string>>>("/eth/v1/config/spec")).data;
    this.wc = concat(["0x02", "0x" + "00".repeat(11), await this.withdrawalVault.getAddress()]);
    this.deposit = await ethers.getContractAt("DepositContract", this.spec.DEPOSIT_CONTRACT_ADDRESS, this.signer);
  }
  async send(contract: BaseContract, method: string, args: unknown[] = [], overrides: TransactionRequest = {}) {
    const tx: ContractTransactionResponse = await contract.getFunction(method)(...args, overrides);
    const receipt = await tx.wait(1, 120_000);
    assert.ok(receipt);
    assert.equal(receipt.status, 1, `${method} receipt`);
    this.receipts.push({
      method,
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: String(receipt.gasUsed),
      status: receipt.status!,
    });
    return receipt;
  }
  call(contract: BaseContract, method: string, args: unknown[] = []) {
    return { to: String(contract.target), data: contract.interface.encodeFunctionData(method, args) };
  }
  async vote(calls: Call[]) {
    const agent = this.state["app:aragon-agent"].proxy.address;
    const abi = new Interface(["function execute(address,uint256,bytes)"]);
    const execution = script(
      calls.map((c) => ({ to: agent, data: abi.encodeFunctionData("execute", [c.to, 0, c.data]) })),
    );
    const receipt = await this.send(this.tokenManager, "forward", [
      script([this.call(this.voting, "newVote(bytes,string)", [execution, "Panda verifier fixture"])]),
    ]);
    const event = receipt.logs
      .filter((l) => l.address.toLowerCase() === String(this.voting.target).toLowerCase())
      .map((l) => this.voting.interface.parseLog(l))
      .find((l) => l?.name === "StartVote");
    assert.ok(event, "Real DAO vote was created");
    const voteId = event.args.voteId;
    await this.send(this.voting, "vote", [voteId, true, false]);
    const voted = await this.voting.getVote(voteId);
    const target = voted.startDate + (await this.voting.voteTime());
    const now = BigInt((await this.panda.status()).el.timestamp);
    await this.panda.advanceSlots(Number((target - now + 11n) / 12n));
    assert.equal(await this.voting.canExecute(voteId), true);
    await this.send(this.voting, "executeVote", [voteId]);
    assert.equal((await this.voting.getVote(voteId)).executed, true);
  }
  async authorizeVerifierCalls() {
    const agent = this.state["app:aragon-agent"].proxy.address;
    const calls = [];
    const grants: [TopUpGateway | ConsolidationGateway | ValidatorsExitBus, string][] = [
      [this.topUp, await this.topUp.TOP_UP_ROLE()],
      [this.consolidation, await this.consolidation.ADD_CONSOLIDATION_REQUEST_ROLE()],
      [this.veb, await this.veb.SUBMIT_REPORT_HASH_ROLE()],
    ];
    for (const [contract, role] of grants) {
      calls.push(this.call(contract, "grantRole", [role, DEPLOYER]));
      if (await contract.isPaused()) {
        const resume = await contract.RESUME_ROLE();
        const already = await contract.hasRole(resume, agent);
        if (!already) calls.push(this.call(contract, "grantRole", [resume, agent]));
        calls.push(this.call(contract, "resume"));
        if (!already) calls.push(this.call(contract, "revokeRole", [resume, agent]));
      }
    }
    if (await this.lido.isStopped()) calls.push(this.call(this.lido, "resume"));
    else if (await this.lido.isStakingPaused()) calls.push(this.call(this.lido, "resumeStaking"));
    await this.vote(calls);
    assert.equal(await this.lido.canDeposit(), true);
  }
  async capture(label: string) {
    const response = await this.panda.beacon<HeaderResponse>("/eth/v1/beacon/headers/head");
    assert.equal(response.execution_optimistic, false);
    assert.equal(response.data.canonical, true);
    const header = response.data.header.message;
    const stateResponse = await this.panda.beacon<BeaconResponse<BeaconState>>(
      `/eth/v2/debug/beacon/states/${header.state_root}`,
    );
    assert.equal(stateResponse.version, "gloas");
    assert.equal(stateResponse.execution_optimistic, false);
    const state = stateResponse.data;
    assert.equal(state.slot, header.slot);
    const tree = State.node(state);
    assert.equal(hex(tree.root), header.state_root, "Independent SSZ state root must equal Lighthouse");
    assert.equal(hex(Header.node(header).root), response.data.root, "Independent header root must equal Lighthouse");
    await this.panda.advanceSlots(1);
    const child = await this.panda.rpc<ExecutionBlock>("eth_getBlockByNumber", ["latest", false]);
    assert.equal(child.parentBeaconBlockRoot, response.data.root, "EL child commits the actual CL parent");
    const timestamp = Number(BigInt(child.timestamp));
    const anchor = await this.provider.call({
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
    this.captures.push({
      label,
      slot: header.slot,
      stateRoot: header.state_root,
      blockRoot: anchor,
      childTimestamp: timestamp,
      validatorCount: state.validators.length,
    });
    await writeFile(
      path.join(this.panda.directory, `${label}.json`),
      JSON.stringify({ header: response, state: stateResponse }),
    );
    return result;
  }
  makeDeposit({ amount = 32n * 10n ** 18n, wrongDomain = false } = {}) {
    const secret = SecretKey.fromKeygen(randomBytes(32));
    const publicKey = secret.toPublicKey();
    const pubkey = hex(publicKey.toBytes());
    const message = { pubkey, withdrawal_credentials: this.wc, amount: String(amount / 10n ** 9n) };
    const fork = hex(
      ForkData.node({
        current_version: wrongDomain ? "0xffffffff" : this.genesis.genesis_fork_version,
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
      wc: this.wc,
      deposit: { pubkey, signature: data.signature, amount, depositDataRoot: hex(DepositData.node(data).root) },
      y: { pubkeyY: pkY, signatureY: { c0_a: c0.a, c0_b: c0.b, c1_a: c1.a, c1_b: c1.b } },
    };
  }
  async importValidator(fixture: ReturnType<Protocol["makeDeposit"]>) {
    const password = randomBytes(32).toString("hex");
    const salt = randomBytes(32),
      iv = randomBytes(16);
    const key = pbkdf2Sync(password, salt, 262144, 32, "sha256");
    const cipher = createCipheriv("aes-128-ctr", key.subarray(0, 16), iv);
    const ciphertext = Buffer.concat([cipher.update(fixture.secret.toBytes()), cipher.final()]);
    const checksum = createHash("sha256").update(key.subarray(16)).update(ciphertext).digest("hex");
    await this.panda.importValidator(
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
  depositValidator(fixture: ReturnType<Protocol["makeDeposit"]>) {
    return this.send(
      this.deposit,
      "deposit",
      [fixture.pubkey, fixture.wc, fixture.signature, fixture.deposit.depositDataRoot],
      { value: fixture.amount },
    );
  }
  async waitForValidator(pubkey: string, { active = false, maxSlots = 256 } = {}) {
    for (let slots = 0; slots <= maxSlots; slots += 32) {
      const data = (await this.panda.beacon<BeaconResponse<ValidatorRecord[]>>("/eth/v1/beacon/states/head/validators"))
        .data;
      const found = data.find((v) => v.validator.pubkey === pubkey);
      if (found && (!active || found.status === "active_ongoing")) return found;
      if (slots === maxSlots) break;
      await this.panda.advanceSlots(32);
    }
    assert.fail(`Validator ${pubkey} did not become ${active ? "active" : "visible"} within ${maxSlots} slots`);
  }
  topUpInput(capture: Awaited<ReturnType<Protocol["capture"]>>, index: number) {
    const witness = capture.witness(index);
    return {
      moduleId: 4,
      keyIndices: [0],
      operatorIds: [0],
      validatorIndices: [index],
      beaconRootData: witness.beacon,
      validatorWitness: [witness.validator],
      pendingBalanceGwei: [0],
    };
  }
  async submitExitRequests(capture: Awaited<ReturnType<Protocol["capture"]>>, indices: number[]) {
    const data = concat(
      indices.map((index) =>
        concat([toBeHex(1, 3), toBeHex(0, 5), toBeHex(index, 8), capture.state.validators[index].pubkey]),
      ),
    );
    const request = { data, dataFormat: 1 };
    const hash = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [data, 1]));
    await this.send(this.veb, "submitExitRequestsHash", [hash]);
    await this.send(this.veb, "submitExitRequestsData", [request]);
    return { ...request, delivered: await this.veb.getDeliveryTimestamp(hash) };
  }
  async finality() {
    const finality = (
      await this.panda.beacon<BeaconResponse<{ finalized: { epoch: string; root: string } }>>(
        "/eth/v1/beacon/states/head/finality_checkpoints",
      )
    ).data.finalized;
    assert.ok(BigInt(finality.epoch) > 0n);
    const checkpoint = await this.panda.beacon<BeaconResponse<BeaconBlock>>(`/eth/v2/beacon/blocks/${finality.root}`);
    assert.equal(checkpoint.execution_optimistic, false);
    const executionParent = checkpoint.data.message.body.signed_execution_payload_bid.message.parent_block_hash;
    const el = await this.panda.rpc<ExecutionBlock>("eth_getBlockByNumber", ["finalized", false]);
    assert.equal(el.hash, executionParent, "Gloas finalized execution is checkpoint execution parent");
    return { epoch: finality.epoch, root: finality.root, executionHash: el.hash };
  }
  async historical(capture: Awaited<ReturnType<Protocol["capture"]>>) {
    const oldSlot = Number(capture.header.slot),
      boundary = (Math.floor(oldSlot / 8192) + 1) * 8192;
    // Explicit time-jump scenario: the current bake skips empty slots. This tests
    // real historical transitions, not complete validator duty/economics coverage.
    await this.panda.advanceTo(Number(this.genesis.genesis_time) + boundary * 12 + 11.5);
    const recent = await this.capture("historical-anchor");
    const index = Math.floor(oldSlot / 8192);
    const roots = State.fields.block_roots.node(recent.state.block_roots);
    assert.equal(recent.state.block_roots[oldSlot % 8192], capture.root);
    assert.equal(hex(roots.root), recent.state.historical_summaries[index].block_summary_root);
    const summaryGI = concatIndex(State.index("historical_summaries"), (2n << 24n) + BigInt(index));
    const oldProof = [
      ...proof(roots, 8192n + BigInt(oldSlot % 8192)),
      ...proof(recent.tree, concatIndex(summaryGI, 2n)),
    ];
    return { recent, old: { header: headerInput(capture.header), proof: oldProof } };
  }
  async validator(index: number): Promise<ValidatorRecord> {
    return (await this.panda.beacon<BeaconResponse<ValidatorRecord>>(`/eth/v1/beacon/states/head/validators/${index}`))
      .data;
  }
  async waitForFinalizedBlock(number: number): Promise<void> {
    for (let slots = 0; slots <= 128; slots += 32) {
      const finalized = await this.panda.rpc<ExecutionBlock>("eth_getBlockByNumber", ["finalized", false]);
      if (Number(BigInt(finalized.number)) >= number) return;
      if (slots < 128) await this.panda.advanceSlots(32);
    }
    assert.fail(`EL block ${number} was not finalized within 128 slots`);
  }
  async expectConsolidationRequest(source: string, target: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.panda.advanceSlots(1);
      const block = await this.panda.beacon<BeaconResponse<BeaconBlock>>("/eth/v2/beacon/blocks/head");
      const found = block.data.message.body.parent_execution_requests.consolidations.find(
        (r) => r.source_pubkey === source && r.target_pubkey === target,
      );
      if (found) {
        assert.equal(found.source_address.toLowerCase(), String(this.withdrawalVault.target).toLowerCase());
        return;
      }
    }
    assert.fail("Consolidation request never reached CL parent_execution_requests");
  }
  async advancePastExitDeadline(delivered: bigint): Promise<void> {
    const earliest = BigInt(this.genesis.genesis_time) + (await this.exitVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS());
    const eligible = delivered > earliest ? delivered : earliest;
    const deadline = eligible + (await this.nor.exitDeadlineThreshold(0)) + 24n;
    await this.panda.advanceTo(Number(deadline) + 11.5);
  }
  expectExitDelayEvent(receipt: TransactionReceipt, pubkey: string): void {
    const events = receipt.logs
      .filter((l) => l.address.toLowerCase() === String(this.nor.target).toLowerCase())
      .map((l) => this.nor.interface.parseLog(l));
    assert.ok(
      events.some((e) => e?.name === "ValidatorExitStatusUpdated" && e.args[1] === pubkey),
      "Real registry exit-delay event",
    );
  }
}
