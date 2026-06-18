import { ethers } from "hardhat";

import { deployBehindOssifiableProxy, deployImplementation, loadContract, makeTx, readNetworkState, Sk } from "lib";
import { impersonate } from "lib/account";

// Minimal ABI for the legacy on-chain TokenRateNotifier (address[] observers). The current source
// has been refactored to `Observer[]` (returning a tuple from `observers(uint256)`), which doesn't
// match the deployed bytecode on mainnet — we can't reuse the typechain-typed contract here.
const LEGACY_NOTIFIER_ABI = [
  "function observersLength() external view returns (uint256)",
  "function observers(uint256) external view returns (address)",
] as const;

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState();

  const agentAddress = state[Sk.appAgent].proxy.address;
  const accountingAddress = state[Sk.accounting].proxy.address;
  const locatorProxyAddress = state[Sk.lidoLocator].proxy.address;
  const locatorConfig = state[Sk.lidoLocator].implementation.constructorArgs[0];
  const oldNotifierAddress = state[Sk.tokenRebaseNotifier].address;

  const agent = await impersonate(agentAddress, ethers.parseEther("1"));

  //
  // 1. Snapshot observers from the old notifier before redeploying anything.
  //
  const legacyNotifier = new ethers.Contract(oldNotifierAddress, LEGACY_NOTIFIER_ABI, ethers.provider);
  const oldObserversLength: bigint = await legacyNotifier.observersLength();
  const oldObservers: string[] = [];
  for (let i = 0n; i < oldObserversLength; i++) {
    oldObservers.push(await legacyNotifier.observers(i));
  }

  //
  // 2. Deploy new TokenRateNotifier behind OssifiableProxy with atomic initialize.
  //
  const notifierFactory = await ethers.getContractFactory("TokenRateNotifier");
  const initData = notifierFactory.interface.encodeFunctionData("initialize", [agentAddress]);

  const newNotifierProxy = await deployBehindOssifiableProxy(
    Sk.tokenRebaseNotifierNest,
    "TokenRateNotifier",
    agentAddress,
    deployer,
    [accountingAddress],
    null,
    true,
    undefined,
    initData,
  );

  //
  // 3. Migrate observers (BEFORE flipping the locator pointer, so the new notifier is fully
  //    populated by the time it becomes the canonical receiver). addObserver auto-detects the
  //    kind via ERC165 — pre-existing observers implement only `ITokenRatePusher`, so they get
  //    registered as Legacy.
  //
  const newNotifier = await loadContract("TokenRateNotifier", newNotifierProxy.address, agent);
  for (const observerAddr of oldObservers) {
    await makeTx(newNotifier, "addObserver", [observerAddr], { from: agentAddress });
  }

  //
  // 4. Deploy new LidoLocator implementation with overridden postTokenRebaseReceiver.
  //
  //    NOTE (test-only): on a vanilla mainnet fork (pre-V3) the locator's current Config struct
  //    does not yet contain `consolidationGateway` / `topUpGateway` — they are added by V3 and
  //    deployed during the V3 upgrade itself. We fill them with non-zero placeholders so the new
  //    `LidoLocator` constructor passes its `_assertNonZero` checks. None of these getters are
  //    exercised by NEST integration tests — only `postTokenRebaseReceiver` matters here.
  //    REMOVE this fallback once V3 is on mainnet and these addresses appear in the state file.
  const TEST_ONLY_PLACEHOLDER = "0x000000000000000000000000000000000000dEaD";
  const newLocatorConfig = {
    ...locatorConfig,
    postTokenRebaseReceiver: newNotifierProxy.address,
    consolidationGateway: locatorConfig.consolidationGateway ?? TEST_ONLY_PLACEHOLDER,
    topUpGateway: locatorConfig.topUpGateway ?? TEST_ONLY_PLACEHOLDER,
  };
  const newLocatorImpl = await deployImplementation(Sk.lidoLocator, "LidoLocator", deployer, [newLocatorConfig]);

  //
  // 5. Flip the LidoLocator proxy to the new impl.
  //
  const locatorProxy = await loadContract("OssifiableProxy", locatorProxyAddress, agent);
  await makeTx(locatorProxy, "proxy__upgradeTo", [newLocatorImpl.address], { from: agentAddress });
}
