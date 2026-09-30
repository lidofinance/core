// Deployment acceptance only: read real RPC state, without Hardhat fixtures or impersonation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Contract, JsonRpcProvider, ZeroHash, id } = require("ethers");

async function main() {
  const state = JSON.parse(fs.readFileSync(process.env.NETWORK_STATE_FILE || "deployed-local-devnet.json"));
  const provider = new JsonRpcProvider(process.env.RPC_URL);
  const checks = [];
  async function check(name, fn) {
    try {
      await fn();
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({ name, passed: false, error: error.message });
    }
  }
  const agent = state["app:aragon-agent"].proxy.address;
  const deployer = state.deployer;
  const access = (address) =>
    new Contract(
      address,
      ["function hasRole(bytes32,address) view returns (bool)", "function isPaused() view returns (bool)"],
      provider,
    );
  await check("all external packages were deployed", async () => {
    for (const address of [
      state.circuitBreaker?.address,
      state.delegationFactory?.address,
      state["sm:CSM"]?.proxy?.address,
      state["sm:CM"]?.proxy?.address,
    ]) {
      assert.ok(address, "external package address is missing");
      assert.notEqual(await provider.getCode(address), "0x");
    }
  });
  await check("all recorded contract implementations and proxies have bytecode", async () => {
    const addresses = new Set();
    function collect(value, external = false) {
      if (!value || typeof value !== "object") return;
      if (value.address && (external || value.contract)) addresses.add(value.address.toLowerCase());
      for (const child of Object.values(value)) collect(child, external);
    }
    collect(state);
    collect(state["sm:CSM"]?.contracts, true);
    collect(state["sm:CM"]?.contracts, true);
    assert.ok(addresses.size >= 84);
    for (const address of addresses) assert.notEqual(await provider.getCode(address), "0x", address);
  });
  await check("four staking modules are registered in order", async () => {
    const router = new Contract(
      state.stakingRouter.proxy.address,
      ["function getStakingModuleIds() view returns (uint256[])"],
      provider,
    );
    assert.deepEqual(Array.from(await router.getStakingModuleIds()), [1n, 2n, 3n, 4n]);
  });
  await check("external modules are resumed with DAO admin and circuit breaker wiring", async () => {
    const breaker = new Contract(
      state.circuitBreaker.address,
      ["function getPauser(address) view returns (address)"],
      provider,
    );
    for (const key of ["sm:CSM", "sm:CM"]) {
      const module = state[key];
      assert.ok(module?.deployArtifact);
      assert.equal(await access(module.proxy.address).isPaused(), false);
      for (const field of [
        key === "sm:CSM" ? "CSModule" : "CuratedModule",
        "Accounting",
        "FeeOracle",
        "Verifier",
        "Ejector",
      ]) {
        const address = module.deployArtifact[field];
        assert.equal(await access(address).hasRole(ZeroHash, agent), true, `${key} ${field} agent admin`);
        assert.equal(await access(address).hasRole(ZeroHash, deployer), false, `${key} ${field} deployer admin`);
        assert.equal(await access(address).hasRole(id("PAUSE_ROLE"), state.circuitBreaker.address), true);
        assert.equal((await breaker.getPauser(address)).toLowerCase(), agent.toLowerCase());
      }
      const consensus = new Contract(
        module.deployArtifact.HashConsensus,
        ["function getFrameConfig() view returns (uint256,uint256,uint256)"],
        provider,
      );
      const head = await provider.getBlock("latest");
      const currentEpoch = BigInt(
        Math.floor((head.timestamp - state.chainSpec.genesisTime) / (12 * state.chainSpec.slotsPerEpoch)),
      );
      assert.ok((await consensus.getFrameConfig())[0] <= currentEpoch, `${key} consensus epoch is active`);
    }
  });
  await check("core admin roles are handed to DAO and revoked from deployer", async () => {
    const keys = [
      "burner",
      "hashConsensusForAccountingOracle",
      "hashConsensusForValidatorsExitBusOracle",
      "stakingRouter",
      "accountingOracle",
      "validatorsExitBusOracle",
      "withdrawalQueueERC721",
      "oracleDaemonConfig",
      "oracleReportSanityChecker",
      "triggerableWithdrawalsGateway",
      "consolidationGateway",
      "consolidationBus",
      "consolidationMigrator",
      "topUpGateway",
      "vaultHub",
      "predepositGuarantee",
      "operatorGrid",
      "lazyOracle",
    ];
    for (const key of keys) {
      const entry = state[key];
      const contract = access(entry.proxy?.address || entry.address);
      assert.equal(await contract.hasRole(ZeroHash, agent), true, `${key} agent admin`);
      assert.equal(await contract.hasRole(ZeroHash, deployer), false, `${key} deployer admin`);
    }
    for (const key of [
      "lidoLocator",
      "stakingRouter",
      "accountingOracle",
      "validatorsExitBusOracle",
      "withdrawalQueueERC721",
      "accounting",
      "vaultHub",
      "predepositGuarantee",
      "operatorGrid",
      "lazyOracle",
      "burner",
    ]) {
      const proxy = new Contract(
        state[key].proxy.address,
        ["function proxy__getAdmin() view returns (address)"],
        provider,
      );
      assert.equal((await proxy.proxy__getAdmin()).toLowerCase(), agent.toLowerCase(), key);
    }
  });
  await check("privileged setup was executed through a real DAO vote", async () => {
    const voting = new Contract(
      state["app:aragon-voting"].proxy.address,
      [
        "function votesLength() view returns (uint256)",
        "function getVote(uint256) view returns (bool open,bool executed,uint64,uint64,uint64,uint64,uint256,uint256,uint256,bytes,uint8)",
      ],
      provider,
    );
    const count = await voting.votesLength();
    assert.ok(count > 0n);
    for (let i = 0n; i < count; i++) assert.equal((await voting.getVote(i)).executed, true);
  });
  provider.destroy();
  const result = { passed: checks.every((check) => check.passed), checks };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
