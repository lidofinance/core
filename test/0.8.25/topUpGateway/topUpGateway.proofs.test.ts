import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { TopUpGateway } from "typechain-types";

import { addressToWC, randomValidatorPubkey, setBeaconBlockRoot } from "lib/pdg";
import { ProtocolContext } from "lib/protocol";
import { buildTopUpData, prepareTopUpWitnesses } from "lib/protocol/helpers";
import { proxify } from "lib/proxy";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

const GENESIS_TIME = 1606824023n;
const SECONDS_PER_SLOT = 12n;
const MAX_ROOT_AGE = 300n;
const MODULE_ID = 1n;

// The gateway and the witness helper each pick the proof layout by comparing the proven slot to the
// configured fork slot. The sentinels pin the two layouts; the finite fork slot (far in the past
// relative to the chain time) makes the comparison itself load-bearing.
for (const { name, gloasSlot } of [
  { name: "fork not scheduled (pre-Gloas layout)", gloasSlot: (1n << 64n) - 1n },
  { name: "fork at a past slot (Gloas layout)", gloasSlot: 1000n },
  { name: "fork at genesis (Gloas layout)", gloasSlot: 0n },
]) {
  describe(`TopUpGateway root freshness with the ${name}`, () => {
    let snapshot: string;
    let admin: HardhatEthersSigner;
    let gateway: TopUpGateway;
    let ctx: ProtocolContext;

    beforeEach(async () => {
      snapshot = await Snapshot.take();
      [admin] = await ethers.getSigners();
      const stakingRouter = await ethers.deployContract("StakingRouter__MockForTopUpGateway");
      const locator = await deployLidoLocator({ stakingRouter: await stakingRouter.getAddress() });
      const impl = await ethers.deployContract("TopUpGateway", [
        await locator.getAddress(),
        gloasSlot,
        32,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
      ]);
      [gateway] = await proxify<TopUpGateway>({ impl, admin });
      await gateway.initialize(admin.address, 6, 1, MAX_ROOT_AGE, 2046n * 10n ** 9n, 10n ** 9n);
      await gateway.grantRole(await gateway.TOP_UP_ROLE(), admin.address);
      await stakingRouter.setWithdrawalCredentials(MODULE_ID, addressToWC(admin.address, 2));

      // Only the address and network timing providers are stubbed; validator verification uses the production gateway.
      ctx = {
        contracts: {
          topUpGateway: gateway,
          withdrawalVault: { getAddress: async () => admin.address },
          hashConsensus: {
            getChainConfig: async () => ({ genesisTime: GENESIS_TIME, secondsPerSlot: SECONDS_PER_SLOT }),
          },
        },
      } as unknown as ProtocolContext;
    });

    afterEach(async () => {
      await Snapshot.restore(snapshot);
    });

    const prepareData = async (validatorsCount = 1) => {
      const validators = Array.from({ length: validatorsCount }, () => ({
        pubkey: randomValidatorPubkey(),
        effectiveBalanceGwei: 32n * 10n ** 9n,
      }));
      const bundle = await prepareTopUpWitnesses(ctx, validators);
      return buildTopUpData(
        MODULE_ID,
        { keyIndices: validators.map((_, i) => BigInt(i)), operatorIds: validators.map(() => 1n) },
        bundle,
      );
    };

    it("accepts fresh, authenticated validator snapshots after a previous top-up", async () => {
      await gateway.topUp(await prepareData());
      const lastTopUpTimestamp = await gateway.getLastTopUpTimestamp();
      // Six validators span three progressive-list chunks under Gloas, starting at the natural index zero.
      const data = await prepareData(6);
      expect(data.validatorIndices).to.deep.equal([0n, 1n, 2n, 3n, 4n, 5n]);
      const rootTimestamp = GENESIS_TIME + BigInt(data.beaconRootData.slot) * SECONDS_PER_SLOT;
      expect(rootTimestamp).to.be.gt(lastTopUpTimestamp);
      await expect(gateway.topUp(data)).to.emit(gateway, "LastTopUpChanged");
    });

    it("rejects a stale authenticated state even if the same root is stored at a recent lookup timestamp", async () => {
      const data = await prepareData();
      const root = await ethers.provider.call({
        to: await gateway.BEACON_ROOTS(),
        data: ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [data.beaconRootData.childBlockTimestamp]),
      });
      await time.increase(MAX_ROOT_AGE + 1n);
      data.beaconRootData.childBlockTimestamp = await setBeaconBlockRoot(root);
      await expect(gateway.topUp(data)).to.be.revertedWithCustomError(gateway, "RootIsTooOld");
    });

    it("does not allow a forged newer slot to bypass freshness checks", async () => {
      const data = await prepareData();
      await gateway.topUp(data);
      const lastTopUpTimestamp = await gateway.getLastTopUpTimestamp();
      data.beaconRootData.slot = Number((lastTopUpTimestamp - GENESIS_TIME) / SECONDS_PER_SLOT + 1n);
      await time.increase(2n * SECONDS_PER_SLOT);
      await expect(gateway.topUp(data)).to.be.revertedWithCustomError(gateway, "InvalidSlot");
    });
  });
}
