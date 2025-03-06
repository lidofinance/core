import { expect } from "chai";
import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { StakingRouter_Mock, ValidatorExitVerifier, ValidatorsExitBusOracle_Mock } from "typechain-types";
import { ILidoLocator } from "typechain-types/test/0.8.9/contracts/oracle/OracleReportSanityCheckerMocks.sol";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import { updateBeaconBlockRoot } from "./beaconBlockRoot";
import { encodeExitRequestsDataList, ExitRequest, findStakingRouterMockEvents } from "./veboExitRequestHelper";

describe("ValidatorExitVerifier.sol", () => {
  let originalState: string;

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  const FIRST_SUPPORTED_SLOT = 1;
  const PIVOT_SLOT = 2;
  const SLOTS_PER_EPOCH = 32;
  const SECONDS_PER_SLOT = 12;
  const GENESIS_TIME = 1606824000;
  const SHARD_COMMITTEE_PERIOD_IN_SECONDS = 8192;
  const LIDO_LOCATOR = "0x0000000000000000000000000000000000000001";

  describe("ValidatorExitVerifier Constructor", () => {
    const GI_FIRST_VALIDATOR_PREV = `0x${"1".repeat(64)}`;
    const GI_FIRST_VALIDATOR_CURR = `0x${"2".repeat(64)}`;
    const GI_HISTORICAL_SUMMARIES_PREV = `0x${"3".repeat(64)}`;
    const GI_HISTORICAL_SUMMARIES_CURR = `0x${"4".repeat(64)}`;

    let validatorExitVerifier: ValidatorExitVerifier;

    before(async () => {
      validatorExitVerifier = await ethers.deployContract("ValidatorExitVerifier", [
        LIDO_LOCATOR,
        GI_FIRST_VALIDATOR_PREV,
        GI_FIRST_VALIDATOR_CURR,
        GI_HISTORICAL_SUMMARIES_PREV,
        GI_HISTORICAL_SUMMARIES_CURR,
        FIRST_SUPPORTED_SLOT,
        PIVOT_SLOT,
        SLOTS_PER_EPOCH,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      ]);
    });

    it("sets all parameters correctly", async () => {
      expect(await validatorExitVerifier.LOCATOR()).to.equal(LIDO_LOCATOR);
      expect(await validatorExitVerifier.GI_FIRST_VALIDATOR_PREV()).to.equal(GI_FIRST_VALIDATOR_PREV);
      expect(await validatorExitVerifier.GI_FIRST_VALIDATOR_PREV()).to.equal(GI_FIRST_VALIDATOR_PREV);
      expect(await validatorExitVerifier.GI_FIRST_VALIDATOR_CURR()).to.equal(GI_FIRST_VALIDATOR_CURR);
      expect(await validatorExitVerifier.GI_HISTORICAL_SUMMARIES_PREV()).to.equal(GI_HISTORICAL_SUMMARIES_PREV);
      expect(await validatorExitVerifier.GI_HISTORICAL_SUMMARIES_CURR()).to.equal(GI_HISTORICAL_SUMMARIES_CURR);
      expect(await validatorExitVerifier.FIRST_SUPPORTED_SLOT()).to.equal(FIRST_SUPPORTED_SLOT);
      expect(await validatorExitVerifier.PIVOT_SLOT()).to.equal(PIVOT_SLOT);
      expect(await validatorExitVerifier.SLOTS_PER_EPOCH()).to.equal(SLOTS_PER_EPOCH);
      expect(await validatorExitVerifier.SECONDS_PER_SLOT()).to.equal(SECONDS_PER_SLOT);
      expect(await validatorExitVerifier.GENESIS_TIME()).to.equal(GENESIS_TIME);
      expect(await validatorExitVerifier.SHARD_COMMITTEE_PERIOD_IN_SECONDS()).to.equal(
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      );
    });

    it("reverts with 'InvalidPivotSlot' if firstSupportedSlot > pivotSlot", async () => {
      await expect(
        ethers.deployContract("ValidatorExitVerifier", [
          LIDO_LOCATOR,
          GI_FIRST_VALIDATOR_PREV,
          GI_FIRST_VALIDATOR_CURR,
          GI_HISTORICAL_SUMMARIES_PREV,
          GI_HISTORICAL_SUMMARIES_CURR,
          200_000, // firstSupportedSlot
          100_000, // pivotSlot < firstSupportedSlot
          SLOTS_PER_EPOCH,
          SECONDS_PER_SLOT,
          GENESIS_TIME,
          SHARD_COMMITTEE_PERIOD_IN_SECONDS,
        ]),
      ).to.be.revertedWithCustomError(validatorExitVerifier, "InvalidPivotSlot");
    });
  });

  describe("verifyActiveValidatorsAfterExitRequest method", () => {
    const GI_FIRST_VALIDATOR_INDEX = "0x0000000000000000000000000000000000000000000000000056000000000028";
    const GI_HISTORICAL_SUMMARIES_INDEX = "0x0000000000000000000000000000000000000000000000000000000000003b00";

    const VALIDATOR_PROOF = {
      validatorPubkey:
        "0x800000c8a5364c1d1e3c4cdb65a28fd21daff4e1fb426c0fb09808105467e4a490d8b3507e7efffbd71024129f1a6b8d",
      validatorIndex: 773833,
      blockRoot: "0xa7f100995b35584c670fe25aa97ae23a8305f5eba8eee3532dedfcc8cf934dca",
      beaconBlockHeader: {
        slot: 10080800,
        proposerIndex: "1337",
        parentRoot: "0x03aa03b69bedd0e423ba545d38e216c4bf2f423e6f5a308477501b9a31ff8d8f",
        stateRoot: "0x508ee9ba052583d9cae510e7333d9776514d42cd10b853395dc24c275a95bc1d",
        bodyRoot: "0x8db50db3356352a01197abd32a52f97c2bb9b48bdbfb045ea4a7f67c9b84be0b",
      },
      witness: {
        withdrawalCredentials: "0x0100000000000000000000007cd73ab82e3a8e74a3fdfd6a41fed60536b8e501",
        effectiveBalance: 32000000000n,
        activationEligibilityEpoch: 207905n,
        activationEpoch: 217838n,
        exitEpoch: 18446744073709551615n,
        withdrawableEpoch: 18446744073709551615n,
        slashed: false,
        validatorProof: [
          "0xcb6bfee06d1227e0f2d9cca5bd508b7fc1069379141f44b0d683eb5aec483005",
          "0x1c8852d46a4244090d9b25822086fb3616072c2ae7b8a89d04b4db9953ed922d",
          "0x671048760e5cadb005cf8ed6a11fd398b882cb2610c8ab25c0cd8f1bb2a663dc",
          "0x5fa5cf691165e3159b86e357c2a4e82c867014e7ec2570e38d3cc3bb694b35e2",
          "0xe5ef1dd73ffa166b176139a24d4d8b53361df9dc26f5ac51c0bf642d9b5dbf25",
          "0xdb356970833ed8b780d20530aa5e0a8bd5ebd2c751c4e9ddc25e0097c629e750",
          "0xceb46d7f9478540174155825a82db4b38201d4d4c047dbefb7546eaea942a6de",
          "0x89c916b9678fbcde3d7d07c26de94fd62c2ae51800b392a83b6f346126c40c6d",
          "0x1da07003bdc86171360808803bbeb41919e25118c7e8aefb9a21f46d5f19e72b",
          "0xad57317afc56b03b6e198ed270b64db4a8f25f132dbf6b56d287c97c6b525db9",
          "0x40f9f5e8fe27eadfcf3c3af2ff0e02ccdce8b536cd4faf5b8ed0a36d40247663",
          "0x05b761f89ed65cf91ac63aad3c8c50bb2aa0c277639d0fd784b6e0b2ccf05395",
          "0x3fd79435deff850fae1bdef0d77a3ffe93b092172e225837cf4ef141fa5689cb",
          "0x044709022ba087a75f6ea66b7a3a1e23fe3712fd351c401f03b578ba8aa0a603",
          "0xe45e266fed3b13b3c8a81fa3064b5af5e25f9b274da2da4032358766d23a9eac",
          "0x046d692534483df5307eb2d69c5a1f8b27068ad1dda96423f854fc88e19571a8",
          "0x7f9ef0a29605f457a735757148c16f88bda95ee0eaaf7e5351fa6ea3aa3cf305",
          "0x1a1965b540ad413b822af6f49160553bd0fd6f9adefcdf5ef862262af43ddd54",
          "0x56206a2520034ea75dab955bc85a305b4681191255111c2c8d27ac23173e5647",
          "0x5ee416708837b80e3f2b625cbd130839d8efdbe88bcbb0076ffdd8cd2229c103",
          "0xb0019865e6408ce0d5a36a6188d7c1e3272976c6a1ccbc58e6c35cca19a8fb6c",
          "0x8a8d7fe3af8caa085a7639a832001457dfb9128a8061142ad0335629ff23ff9c",
          "0xfeb3c337d7a51a6fbf00b9e34c52e1c9195c969bd4e7a0bfd51d5c5bed9c1167",
          "0xe71f0aa83cc32edfbefa9f4d3e0174ca85182eec9f3a09f6a6c0df6377a510d7",
          "0x31206fa80a50bb6abe29085058f16212212a60eec8f049fecb92d8c8e0a84bc0",
          "0x21352bfecbeddde993839f614c3dac0a3ee37543f9b412b16199dc158e23b544",
          "0x619e312724bb6d7c3153ed9de791d764a366b389af13c58bf8a8d90481a46765",
          "0x7cdd2986268250628d0c10e385c58c6191e6fbe05191bcc04f133f2cea72c1c4",
          "0x848930bd7ba8cac54661072113fb278869e07bb8587f91392933374d017bcbe1",
          "0x8869ff2c22b28cc10510d9853292803328be4fb0e80495e8bb8d271f5b889636",
          "0xb5fe28e79f1b850f8658246ce9b6a1e7b49fc06db7143e8fe0b4f2b0c5523a5c",
          "0x985e929f70af28d0bdd1a90a808f977f597c7c778c489e98d3bd8910d31ac0f7",
          "0xc6f67e02e6e4e1bdefb994c6098953f34636ba2b6ca20a4721d2b26a886722ff",
          "0x1c9a7e5ff1cf48b4ad1582d3f4e4a1004f3b20d8c5a2b71387a4254ad933ebc5",
          "0x2f075ae229646b6f6aed19a5e372cf295081401eb893ff599b3f9acc0c0d3e7d",
          "0x328921deb59612076801e8cd61592107b5c67c79b846595cc6320c395b46362c",
          "0xbfb909fdb236ad2411b4e4883810a074b840464689986c3f8a8091827e17c327",
          "0x55d8fb3687ba3ba49f342c77f5a1f89bec83d811446e1a467139213d640b6a74",
          "0xf7210d4f8e7e1039790e7bf4efa207555a10a6db1dd4b95da313aaa88b88fe76",
          "0xad21b516cbc645ffe34ab5de1c8aef8cd4e7f8d2b51e8e1456adc7563cda206f",
          "0x455d180000000000000000000000000000000000000000000000000000000000",
          "0x87ed190000000000000000000000000000000000000000000000000000000000",
          "0xb95e35337be0ebfa1ae00f659346dfce7bb59865d4bde0299df3e548c24e00aa",
          "0x001b9a4b331100497e69174269986fcd37e62145bf51123cb67fb3108c2422fd",
          "0x339028e1baffbe94bcf2d5e671de99ff958e0c8afd8c1844370dc1af2fa00315",
          "0xa48b01f6407ef8dc6b77f5df0fa4fef5b1b9795c7e99c13fa8aad0eac6036676",
        ],
      },
    };

    let validatorExitVerifier: ValidatorExitVerifier;

    let locator: ILidoLocator;
    let locatorAddr: string;

    let vebo: ValidatorsExitBusOracle_Mock;
    let veboAddr: string;

    let stakingRouter: StakingRouter_Mock;
    let stakingRouterAddr: string;

    before(async () => {
      vebo = await ethers.deployContract("ValidatorsExitBusOracle_Mock");
      veboAddr = await vebo.getAddress();

      stakingRouter = await ethers.deployContract("StakingRouter_Mock");
      stakingRouterAddr = await stakingRouter.getAddress();

      locator = await deployLidoLocator({ validatorsExitBusOracle: veboAddr, stakingRouter: stakingRouterAddr });
      locatorAddr = await locator.getAddress();

      validatorExitVerifier = await ethers.deployContract("ValidatorExitVerifier", [
        locatorAddr,
        GI_FIRST_VALIDATOR_INDEX,
        GI_FIRST_VALIDATOR_INDEX,
        GI_HISTORICAL_SUMMARIES_INDEX,
        GI_HISTORICAL_SUMMARIES_INDEX,
        FIRST_SUPPORTED_SLOT,
        PIVOT_SLOT,
        SLOTS_PER_EPOCH,
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        SHARD_COMMITTEE_PERIOD_IN_SECONDS,
      ]);
    });

    it("accepts a valid proof and does not revert", async () => {
      const intervalInSecondsBetweenProvableBlockAndExitRequest = 1000;
      const blockRootTimestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);
      const veboExitRequestTimestamp = blockRootTimestamp - intervalInSecondsBetweenProvableBlockAndExitRequest;

      const moduleId = 1;
      const nodeOpId = 2;
      const exitRequests: ExitRequest[] = [
        {
          moduleId,
          nodeOpId,
          valIndex: VALIDATOR_PROOF.validatorIndex,
          valPubkey: VALIDATOR_PROOF.validatorPubkey,
        },
      ];
      const encodedExitRequests = encodeExitRequestsDataList(exitRequests);
      const encodedExitRequestsHash = keccak256(encodedExitRequests);
      await vebo.setExitRequestsStatus(encodedExitRequestsHash, {
        totalItemsCount: 1n,
        deliveredItemsCount: 1n,
        reportDataFormat: 1n,
        contractVersion: 1n,
        deliveryHistory: [{ blockNumber: 1n, blockTimestamp: veboExitRequestTimestamp, lastDeliveredKeyIndex: 1n }],
      });

      const tx = await validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
        encodedExitRequests,
        {
          rootsTimestamp: blockRootTimestamp,
          header: VALIDATOR_PROOF.beaconBlockHeader,
        },
        [
          {
            exitRequestIndex: 0n,
            ...VALIDATOR_PROOF.witness,
          },
        ],
      );

      const receipt = await tx.wait();
      const events = findStakingRouterMockEvents(receipt!, "UnexitedValidatorReported");
      expect(events.length).to.equal(1);

      const event = events[0];
      expect(event.args[0]).to.equal(moduleId);
      expect(event.args[1]).to.equal(nodeOpId);
      expect(event.args[2]).to.equal(VALIDATOR_PROOF.validatorPubkey);
      expect(event.args[3]).to.equal(intervalInSecondsBetweenProvableBlockAndExitRequest);
    });

    // it("reverts with 'UnsupportedSlot' when slot < FIRST_SUPPORTED_SLOT", async () => {
    //   // Use a slot smaller than FIRST_SUPPORTED_SLOT
    //   const invalidHeader = {
    //     ...VALIDATOR_PROOF.beaconBlockHeader,
    //     slot: 0,
    //   };
    //   const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

    //   await expect(
    //     validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
    //       exitRequests,
    //       {
    //         rootsTimestamp: timestamp,
    //         header: invalidHeader,
    //       },
    //       validatorWitnesses,
    //     ),
    //   ).to.be.revertedWithCustomError(validatorExitVerifier, "UnsupportedSlot");
    // });

    // it("reverts with 'RootNotFound' if the staticcall to the block roots contract fails/returns empty", async () => {
    //   const badTimestamp = 999_999_999;
    //   await expect(
    //     validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
    //       exitRequests,
    //       {
    //         rootsTimestamp: badTimestamp,
    //         header: VALIDATOR_PROOF.beaconBlockHeader,
    //       },
    //       validatorWitnesses,
    //     ),
    //   ).to.be.revertedWithCustomError(validatorExitVerifier, "RootNotFound");
    // });

    // it("reverts with 'InvalidBlockHeader' if the block root from contract doesn't match the header root", async () => {
    //   const bogusBlockRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
    //   const mismatchTimestamp = await updateBeaconBlockRoot(bogusBlockRoot);

    //   await expect(
    //     validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
    //       exitRequests,
    //       {
    //         rootsTimestamp: mismatchTimestamp,
    //         header: VALIDATOR_PROOF.beaconBlockHeader,
    //       },
    //       validatorWitnesses,
    //     ),
    //   ).to.be.revertedWithCustomError(validatorExitVerifier, "InvalidBlockHeader");
    // });

    // it("reverts if the validator proof is incorrect", async () => {
    //   const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

    //   // Mutate one proof entry to break it
    //   const badWitness = {
    //     ...validatorWitnesses[0],
    //     validatorProof: [
    //       ...validatorWitnesses[0].validatorProof.slice(0, -1),
    //       "0xbadbadbad0000000000000000000000000000000000000000000000000000000", // corrupt last entry
    //     ],
    //   };

    //   await expect(
    //     validatorExitVerifier.verifyActiveValidatorsAfterExitRequest(
    //       exitRequests,
    //       {
    //         rootsTimestamp: timestamp,
    //         header: VALIDATOR_PROOF.beaconBlockHeader,
    //       },
    //       [badWitness],
    //     ),
    //   ).to.be.reverted;
    // });
  });

  // describe("verifyHistoricalActiveValidatorsAfterExitRequest method", () => {
  //   // Define constants and mock data similar to the validatorExitVerifier tests
  //   // ...existing code...

  //   let validatorExitVerifier: ValidatorExitVerifier;

  //   before(async () => {
  //     validatorExitVerifier = await ethers.deployContract("ValidatorExitVerifier", [
  //       "0x0000000000000000000000000000000000000001", // lidoLocator
  //       GI_FIRST_VALIDATOR_PREV,
  //       GI_FIRST_VALIDATOR_CURR,
  //       GI_HISTORICAL_SUMMARIES_PREV,
  //       GI_HISTORICAL_SUMMARIES_CURR,
  //       FIRST_SUPPORTED_SLOT,
  //       PIVOT_SLOT,
  //       SLOTS_PER_EPOCH,
  //       SECONDS_PER_SLOT,
  //       GENESIS_TIME,
  //       SHARD_COMMITTEE_PERIOD_IN_SECONDS,
  //     ]);
  //   });

  //   it("accepts a valid proof and does not revert", async () => {
  //     const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

  //     await expect(
  //       validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
  //         exitRequests,
  //         {
  //           rootsTimestamp: timestamp,
  //           header: VALIDATOR_PROOF.beaconBlockHeader,
  //         },
  //         oldBlock,
  //         validatorWitnesses,
  //       ),
  //     ).not.to.be.reverted;
  //   });

  //   it("reverts with 'UnsupportedSlot' if beaconBlock slot < FIRST_SUPPORTED_SLOT", async () => {
  //     const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);
  //     const invalidHeader = {
  //       ...VALIDATOR_PROOF.beaconBlockHeader,
  //       slot: 0,
  //     };

  //     await expect(
  //       validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
  //         exitRequests,
  //         {
  //           rootsTimestamp: timestamp,
  //           header: invalidHeader,
  //         },
  //         oldBlock,
  //         validatorWitnesses,
  //       ),
  //     ).to.be.revertedWithCustomError(validatorExitVerifier, "UnsupportedSlot");
  //   });

  //   it("reverts with 'UnsupportedSlot' if oldBlock slot < FIRST_SUPPORTED_SLOT", async () => {
  //     const oldBlock = {
  //       ...oldBlock,
  //       header: {
  //         ...oldBlock.header,
  //         slot: 0,
  //       },
  //     };
  //     const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

  //     await expect(
  //       validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
  //         exitRequests,
  //         {
  //           rootsTimestamp: timestamp,
  //           header: VALIDATOR_PROOF.beaconBlockHeader,
  //         },
  //         oldBlock,
  //         validatorWitnesses,
  //       ),
  //     ).to.be.revertedWithCustomError(validatorExitVerifier, "UnsupportedSlot");
  //   });

  //   it("reverts with 'RootNotFound' if block root contract call fails", async () => {
  //     const badTimestamp = 999_999_999;

  //     await expect(
  //       validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
  //         exitRequests,
  //         {
  //           rootsTimestamp: badTimestamp,
  //           header: VALIDATOR_PROOF.beaconBlockHeader,
  //         },
  //         oldBlock,
  //         validatorWitnesses,
  //       ),
  //     ).to.be.revertedWithCustomError(validatorExitVerifier, "RootNotFound");
  //   });

  //   it("reverts with 'InvalidBlockHeader' if returned root doesn't match the new block header root", async () => {
  //     // Deploy a mismatch root in the mock
  //     const bogusBlockRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
  //     const mismatchTimestamp = await updateBeaconBlockRoot(bogusBlockRoot);

  //     await expect(
  //       validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
  //         exitRequests,
  //         {
  //           rootsTimestamp: mismatchTimestamp,
  //           header: VALIDATOR_PROOF.beaconBlockHeader,
  //         },
  //         oldBlock,
  //         validatorWitnesses,
  //       ),
  //     ).to.be.revertedWithCustomError(validatorExitVerifier, "InvalidBlockHeader");
  //   });

  //   it("reverts with 'InvalidGIndex' if oldBlock.rootGIndex is not under the historicalSummaries root", async () => {
  //     // Provide an obviously wrong rootGIndex that won't match the parent's
  //     const invalidRootGIndex = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

  //     const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

  //     await expect(
  //       validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
  //         exitRequests,
  //         {
  //           rootsTimestamp: timestamp,
  //           header: VALIDATOR_PROOF.beaconBlockHeader,
  //         },
  //         {
  //           ...oldBlock,
  //           rootGIndex: invalidRootGIndex,
  //         },
  //         validatorWitnesses,
  //       ),
  //     ).to.be.revertedWithCustomError(validatorExitVerifier, "InvalidGIndex");
  //   });

  //   it("reverts if the oldBlock proof is corrupted", async () => {
  //     const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);
  //     // Mutate one proof entry to break the historical block proof
  //     const badOldBlock = {
  //       ...oldBlock,
  //       proof: [...oldBlock.proof.slice(0, -1), "0xbadbadbad0000000000000000000000000000000000000000000000000000000"],
  //     };

  //     await expect(
  //       validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
  //         exitRequests,
  //         {
  //           rootsTimestamp: timestamp,
  //           header: VALIDATOR_PROOF.beaconBlockHeader,
  //         },
  //         badOldBlock,
  //         validatorWitnesses,
  //       ),
  //     ).to.be.reverted;
  //   });

  //   it("reverts if the validatorProof in the witness is corrupted", async () => {
  //     const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);
  //     // Mutate the validator proof
  //     const badWitness = {
  //       ...validatorWitnesses[0],
  //       validatorProof: [
  //         ...validatorWitnesses[0].validatorProof.slice(0, -1),
  //         "0xbadbadbad0000000000000000000000000000000000000000000000000000000",
  //       ],
  //     };

  //     await expect(
  //       validatorExitVerifier.verifyHistoricalActiveValidatorsAfterExitRequest(
  //         exitRequests,
  //         {
  //           rootsTimestamp: timestamp,
  //           header: VALIDATOR_PROOF.beaconBlockHeader,
  //         },
  //         oldBlock,
  //         [badWitness],
  //       ),
  //     ).to.be.reverted;
  //   });
  // });
});
