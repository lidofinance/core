import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  OracleReportSanityChecker,
  StakingModule__MockForKeyVerification,
  StakingRouter__MockForValidatorsExitBus,
  ValidatorsExitBus__Harness,
} from "typechain-types";

import { deployVEBO, encodeWithdrawalRequests, makeMockPubkey, WithdrawalRequest } from "test/deploy";
import { Snapshot } from "test/suite";

// Module IDs used in tests
const LEGACY_MODULE_ID = 1; // Module with 0x01 withdrawal credentials (32 ETH)
const MAXEB_MODULE_ID_1 = 3; // Module with 0x02 withdrawal credentials (2048 ETH)
const MAXEB_MODULE_ID_2 = 5; // Another module with 0x02 withdrawal credentials
const MAXEB_MODULE_ID_3 = 7; // Another module with 0x02 withdrawal credentials

// FWR weights from OracleReportSanityChecker set by the fixture
const LEGACY_MODULE_MAX_BALANCE_ETH = 32n; // 32 ETH
const MAXEB_MODULE_MAX_BALANCE_ETH = 2048n; // 2048 ETH

const GWEI_PER_ETH = 10n ** 9n;

describe("ValidatorsExitBusOracle.sol:balanceCalculation", () => {
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let sanityChecker: OracleReportSanityChecker;
  let stakingRouter: StakingRouter__MockForValidatorsExitBus;
  let mockModule: StakingModule__MockForKeyVerification;

  let originalState: string;

  // Runs the parser without sending a transaction and returns its results
  const process = async (requests: WithdrawalRequest[]) => {
    const [intents, totalExitBalanceEth] = await oracle.processWithdrawalRequests.staticCall(
      encodeWithdrawalRequests(requests),
    );
    return { intents, totalExitBalanceEth };
  };

  const fwr = (moduleId: number, nodeOpId: number, keyIndex: number) => ({ moduleId, nodeOpId, keyIndex, amount: 0n });
  const pwr = (moduleId: number, nodeOpId: number, keyIndex: number, amount: bigint) => ({
    moduleId,
    nodeOpId,
    keyIndex,
    amount,
  });

  before(async () => {
    [admin] = await ethers.getSigners();

    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    sanityChecker = deployed.oracleReportSanityChecker;
    stakingRouter = deployed.stakingRouter;
    mockModule = deployed.mockModules.module1;

    // 0x02 modules accept partial withdrawals
    for (const moduleId of [MAXEB_MODULE_ID_1, MAXEB_MODULE_ID_2, MAXEB_MODULE_ID_3]) {
      await stakingRouter.setStakingModulePartialWithdrawalsAllowed(moduleId, true);
    }
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  describe("processWithdrawalRequests", () => {
    describe("FWR weight", () => {
      it("should calculate balance for single legacy validator (32 ETH)", async () => {
        const { totalExitBalanceEth } = await process([fwr(LEGACY_MODULE_ID, 1, 10)]);
        expect(totalExitBalanceEth).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH);
      });

      it("should calculate balance for single MaxEB validator (2048 ETH)", async () => {
        const { totalExitBalanceEth } = await process([fwr(MAXEB_MODULE_ID_1, 1, 10)]);
        expect(totalExitBalanceEth).to.equal(MAXEB_MODULE_MAX_BALANCE_ETH);
      });

      it("should calculate balance for multiple legacy validators", async () => {
        const { totalExitBalanceEth } = await process([
          fwr(LEGACY_MODULE_ID, 1, 10),
          fwr(LEGACY_MODULE_ID, 1, 11),
          fwr(LEGACY_MODULE_ID, 1, 12),
        ]);
        expect(totalExitBalanceEth).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH * 3n);
      });

      it("should calculate balance for multiple MaxEB validators", async () => {
        const { totalExitBalanceEth } = await process([
          fwr(MAXEB_MODULE_ID_1, 1, 10),
          fwr(MAXEB_MODULE_ID_2, 2, 20),
          fwr(MAXEB_MODULE_ID_3, 3, 30),
        ]);
        expect(totalExitBalanceEth).to.equal(MAXEB_MODULE_MAX_BALANCE_ETH * 3n);
      });

      it("should calculate balance for mixed module types", async () => {
        const { totalExitBalanceEth } = await process([
          fwr(LEGACY_MODULE_ID, 1, 10),
          fwr(MAXEB_MODULE_ID_1, 2, 20),
          fwr(LEGACY_MODULE_ID, 1, 11),
          fwr(MAXEB_MODULE_ID_2, 3, 30),
        ]);
        expect(totalExitBalanceEth).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH * 2n + MAXEB_MODULE_MAX_BALANCE_ETH * 2n);
      });

      it("should return no intents and zero balance for empty data", async () => {
        const { intents, totalExitBalanceEth } = await process([]);
        expect(intents.length).to.equal(0);
        expect(totalExitBalanceEth).to.equal(0n);
      });

      it("should revert when module id is zero", async () => {
        await expect(process([fwr(0, 1, 10)])).to.be.revertedWithCustomError(oracle, "InvalidModuleId");
      });

      it("should not depend on keyIndex", async () => {
        const { totalExitBalanceEth: total1 } = await process([
          fwr(LEGACY_MODULE_ID, 1, 1),
          fwr(LEGACY_MODULE_ID, 1, 2),
        ]);
        const { totalExitBalanceEth: total2 } = await process([
          fwr(LEGACY_MODULE_ID, 1, 100),
          fwr(LEGACY_MODULE_ID, 1, 200),
        ]);

        expect(total1).to.equal(total2);
        expect(total1).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH * 2n);
      });
    });

    describe("PWR weight", () => {
      it("should weigh a PWR at its amount", async () => {
        const { totalExitBalanceEth } = await process([pwr(MAXEB_MODULE_ID_1, 1, 10, 16n * GWEI_PER_ETH)]);
        expect(totalExitBalanceEth).to.equal(16n);
      });

      it("should round a 1 gwei PWR up to 1 ETH", async () => {
        const { totalExitBalanceEth } = await process([pwr(MAXEB_MODULE_ID_1, 1, 10, 1n)]);
        expect(totalExitBalanceEth).to.equal(1n);
      });

      it("should round a PWR amount up to whole ETH", async () => {
        const { totalExitBalanceEth } = await process([pwr(MAXEB_MODULE_ID_1, 1, 10, 16n * GWEI_PER_ETH + 1n)]);
        expect(totalExitBalanceEth).to.equal(17n);
      });

      it("should sum PWR amounts in gwei and round once per report", async () => {
        const halfEth = GWEI_PER_ETH / 2n;
        const { totalExitBalanceEth } = await process([
          pwr(MAXEB_MODULE_ID_1, 1, 10, halfEth),
          pwr(MAXEB_MODULE_ID_1, 1, 11, halfEth),
        ]);
        expect(totalExitBalanceEth).to.equal(1n);
      });

      it("should sum PWR and FWR weights in a mixed report", async () => {
        const { totalExitBalanceEth } = await process([
          fwr(LEGACY_MODULE_ID, 1, 10),
          fwr(MAXEB_MODULE_ID_1, 2, 20),
          pwr(MAXEB_MODULE_ID_2, 3, 30, 10n * GWEI_PER_ETH + GWEI_PER_ETH / 2n),
        ]);
        expect(totalExitBalanceEth).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH + MAXEB_MODULE_MAX_BALANCE_ETH + 11n);
      });

      it("should not apply the module weight to a PWR", async () => {
        const { totalExitBalanceEth } = await process([pwr(MAXEB_MODULE_ID_1, 1, 10, GWEI_PER_ETH)]);
        expect(totalExitBalanceEth).to.equal(1n);
      });
    });

    describe("Intents and decoding", () => {
      it("should return intents in report order with pubkeys from the modules", async () => {
        const requests = [
          pwr(MAXEB_MODULE_ID_1, 4, 40, 3n * GWEI_PER_ETH),
          fwr(LEGACY_MODULE_ID, 1, 10),
          fwr(MAXEB_MODULE_ID_2, 2, 20),
        ];
        const { intents } = await process(requests);

        expect(intents.length).to.equal(requests.length);
        intents.forEach((intent, i) => {
          expect(intent.amount).to.equal(requests[i].amount);
          expect(intent.pubkey).to.equal(makeMockPubkey(requests[i].nodeOpId, requests[i].keyIndex));
        });
      });

      it("should decode max values of every field without overlapping", async () => {
        const MAX_MODULE_ID = 2 ** 24 - 1;
        const MAX_NODE_OP_ID = 2n ** 40n - 1n;
        const MAX_KEY_INDEX = 2n ** 64n - 1n;

        await stakingRouter.setStakingModuleWithdrawalCredentialsType(MAX_MODULE_ID, 0x02);
        await stakingRouter.setStakingModuleAddress(MAX_MODULE_ID, await mockModule.getAddress());

        const request = { moduleId: MAX_MODULE_ID, nodeOpId: MAX_NODE_OP_ID, keyIndex: MAX_KEY_INDEX, amount: 0n };
        const pubkey = makeMockPubkey(MAX_NODE_OP_ID, MAX_KEY_INDEX);

        const { intents } = await process([request]);
        expect(intents[0].pubkey).to.equal(pubkey);
        expect(intents[0].amount).to.equal(0n);

        await expect(oracle.processWithdrawalRequests(encodeWithdrawalRequests([request])))
          .to.emit(oracle, "WithdrawalRequested")
          .withArgs(MAX_MODULE_ID, MAX_NODE_OP_ID, pubkey, 0n);
      });
    });

    describe("Configuration", () => {
      it("should handle large number of validators", async () => {
        const requests = Array.from({ length: 100 }, (_, i) => fwr(LEGACY_MODULE_ID, 1, i));
        const { totalExitBalanceEth } = await process(requests);
        expect(totalExitBalanceEth).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH * 100n);
      });

      it("should handle module with 0x02 withdrawal credentials (MaxEB)", async () => {
        await stakingRouter.setStakingModuleWithdrawalCredentialsType(999, 0x02);
        await stakingRouter.setStakingModuleAddress(999, await mockModule.getAddress());

        const { totalExitBalanceEth } = await process([fwr(999, 1, 10)]);
        expect(totalExitBalanceEth).to.equal(MAXEB_MODULE_MAX_BALANCE_ETH);
      });

      it("should handle module with 0x01 withdrawal credentials (Legacy)", async () => {
        await stakingRouter.setStakingModuleWithdrawalCredentialsType(888, 0x01);
        await stakingRouter.setStakingModuleAddress(888, await mockModule.getAddress());

        const { totalExitBalanceEth } = await process([fwr(888, 1, 10)]);
        expect(totalExitBalanceEth).to.equal(LEGACY_MODULE_MAX_BALANCE_ETH);
      });

      it("uses MaxEB weights from sanity checker and applies governance updates", async () => {
        await sanityChecker.grantRole(await sanityChecker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE(), admin.address);
        await sanityChecker.setMaxEffectiveBalanceWeightWCType01(40n);
        await sanityChecker.setMaxEffectiveBalanceWeightWCType02(4_096n);

        expect(await oracle.MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_01()).to.equal(40n);
        expect(await oracle.MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_02()).to.equal(4_096n);

        // the weights apply to FWRs only: a 1 ETH PWR still weighs 1 ETH
        const { totalExitBalanceEth } = await process([
          fwr(LEGACY_MODULE_ID, 1, 10),
          fwr(MAXEB_MODULE_ID_1, 2, 20),
          pwr(MAXEB_MODULE_ID_2, 3, 30, GWEI_PER_ETH),
        ]);
        expect(totalExitBalanceEth).to.equal(40n + 4_096n + 1n);
      });

      it("reverts for unconfigured modules", async () => {
        // Module 777 is not configured in the router
        await expect(process([fwr(777, 1, 10)])).to.be.revertedWithCustomError(
          stakingRouter,
          "StakingModuleUnregistered",
        );
      });
    });
  });
});
