import { expect } from "chai";
import { ethers } from "hardhat";

import { CLProofVerifier } from "typechain-types";

import { Snapshot } from "test/suite";

import { updateBeaconBlockRoot } from "./beaconBlockRoot";

describe("CLProofVerifier.sol", () => {
  let originalState: string;

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  describe("CLProofVerifier Constructor", () => {
    const GI_FIRST_VALIDATOR_PREV = `0x${"1".repeat(64)}`;
    const GI_FIRST_VALIDATOR_CURR = `0x${"2".repeat(64)}`;
    const GI_HISTORICAL_SUMMARIES_PREV = `0x${"3".repeat(64)}`;
    const GI_HISTORICAL_SUMMARIES_CURR = `0x${"4".repeat(64)}`;
    const FIRST_SUPPORTED_SLOT = 1;
    const PIVOT_SLOT = 2;

    let clProofVerifier: CLProofVerifier;

    before(async () => {
      clProofVerifier = await ethers.deployContract("CLProofVerifier", [
        GI_FIRST_VALIDATOR_PREV,
        GI_FIRST_VALIDATOR_CURR,
        GI_HISTORICAL_SUMMARIES_PREV,
        GI_HISTORICAL_SUMMARIES_CURR,
        FIRST_SUPPORTED_SLOT,
        PIVOT_SLOT,
      ]);
    });

    it("sets all parameters correctly correctly", async () => {
      expect(await clProofVerifier.GI_FIRST_VALIDATOR_PREV()).to.equal(GI_FIRST_VALIDATOR_PREV);
      expect(await clProofVerifier.GI_FIRST_VALIDATOR_CURR()).to.equal(GI_FIRST_VALIDATOR_CURR);
      expect(await clProofVerifier.GI_HISTORICAL_SUMMARIES_PREV()).to.equal(GI_HISTORICAL_SUMMARIES_PREV);
      expect(await clProofVerifier.GI_HISTORICAL_SUMMARIES_CURR()).to.equal(GI_HISTORICAL_SUMMARIES_CURR);
      expect(await clProofVerifier.FIRST_SUPPORTED_SLOT()).to.equal(FIRST_SUPPORTED_SLOT);
      expect(await clProofVerifier.PIVOT_SLOT()).to.equal(PIVOT_SLOT);
    });

    it("reverts with 'InvalidPivotSlot' if firstSupportedSlot > pivotSlot", async () => {
      await expect(
        ethers.deployContract("CLProofVerifier", [
          GI_FIRST_VALIDATOR_PREV,
          GI_FIRST_VALIDATOR_CURR,
          GI_HISTORICAL_SUMMARIES_PREV,
          GI_HISTORICAL_SUMMARIES_CURR,
          200_000, // firstSupportedSlot
          100_000, // pivotSlot < firstSupportedSlot
        ]),
      ).to.be.revertedWithCustomError(clProofVerifier, "InvalidPivotSlot");
    });
  });

  describe("verifyValidatorProof method", () => {
    const GI_FIRST_VALIDATOR_INDEX = "0x0000000000000000000000000000000000000000000000000056000000000028";
    const GI_HISTORICAL_SUMMARIES_INDEX = "0x0000000000000000000000000000000000000000000000000000000000003b00";

    const VALIDATOR_PROOF = {
      blockRoot: "0x56073a5bf24e8a3ea2033ad10a5039a7a7a6884086b67053c90d38f104ae89cf",

      beaconBlockHeader: {
        slot: 1743359,
        proposerIndex: 1337,
        parentRoot: "0x5db6dfb2b5e735bafb437a76b9e525e958d2aef589649e862bfbc02964edf5ab",
        stateRoot: "0x21205c716572ae05692c0f8a4c64fd84e504cbb1a16fa0371701adbab756dd72",
        bodyRoot: "0x459390eed4479eb49b71efadcc3b540bbc60073f196e0409588d6cc9eafbe5fa",
      },
      witness: {
        validatorIndex: 1551477n,
        validator: {
          pubkey: "0xa5b3dfbe60eb74b9224ec56bb253e18cf032c999818f10bc51fc13a9c5584eb66624796a400c2047ac248146f58a2d3d",
          withdrawalCredentials: "0x010000000000000000000000c93c3e1c11037f5bd50f21cfc1a02aba5427b2f3",
          effectiveBalance: 0n,
          activationEligibilityEpoch: 21860n,
          activationEpoch: 21866n,
          exitEpoch: 41672n,
          withdrawableEpoch: 41928n,
          slashed: true,
        },
        validatorProof: [
          "0x3efdddf56d4e2f27814f3c7a33242b208eba5496d4375ae1354189cb45022265",
          "0xa80637a489bc503b27c5b8667d7147ed1c52f945d52aae090d1911941ba3bc0a",
          "0x55437fead4a169949a4686ee6d0d7777d0006000439d01e8f1ff86ed3b944555",
          "0x1ded2cca8f4b1667158ee2db6c5bc13488283921d0bc19ee870e9e96182e8ab9",
          "0x6e8978026de507444dff6c59d0159f56ac57bc0d838b0060c81547de5e4c57b8",
          "0x3a01de7f6c7c3840419cf3fcf7910d791e0d7ef471288331d5fe56398b7f1b3f",
          "0x1bfe62a72cfbcef5a057464913e141d625ecf04eaa34c3c85e047a32a7b28ec8",
          "0x31129869b19b584b2032d8b3fa901ec86ca3213983620a2e085b14506a53b9b6",
          "0xb010816d1a36de59273332db53d2c20eb91a07b8c5327790a1d2c6cdbe9cdeba",
          "0x9acaa36e34da8ba19c54d7b9f6d9e5740febc1b30b61cb19d0891e79c2642243",
          "0x43c6392e38689b6666857ed9dba67b486421dce3824878abd891107ff2b62757",
          "0xe38fab163d8350d6ffd316794bfb000d97a72c85eccc4062e80308e94a9939d8",
          "0x96428f8477bf31469220152f22fb9c321e74aa08774dd5b4de6d11e8fc23d272",
          "0x384a25acafbec9f1c547eb89766051cf16cb4fd4d49a7ddadf7bd32e01ef4489",
          "0x4c82fe5eca765bbd31dae8cb40b2229526d89c64205a5d5048551dfd9f0215c6",
          "0x552980838151f3db4e1e3e69689b481f784f947a147ec9b2df4f6d9d1eaf1147",
          "0xa527b49b664e1311993cb4d5d77c8e3ef9bbe06b142e76f1035a5768b1443c79",
          "0x889f02af50613a82f8e1ed3f654bf1f829c58e4cd1d67bf608793cfe80ec6165",
          "0xbc676437f6c3c377e4aac6eb1a73c19e6a35db70a44604d791172912b23e2b8e",
          "0x06a06bbdd7f1700337393726ed1ca6e63a5a591607dcacf1766119753ec81292",
          "0xef1b63eac20336d5cd32028b1963f7c80869ae34ba13ece0965c51540abc1709",
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
          "0xcb2c1a0000000000000000000000000000000000000000000000000000000000",
          "0xbc36040000000000000000000000000000000000000000000000000000000000",
          "0x0ed6189bc73badc7cf2cd2f0e54551a3b1d2192ee26bbb58d670d069b31b148e",
          "0x80eb44447d4f078e878a8b5fd2e3d3833a368e1d12239503e9f7b4605a0d782a",
          "0xbb2952772995323016b98233c26e96e5c54955fda62e643cb56981da6aab7365",
          "0xda5ca7afba0d19d345e85d2825fc3078eefdd76ead776b108fe0eac9aa96e5e6",
        ],
      },
    };

    let clProofVerifier: CLProofVerifier;

    before(async () => {
      clProofVerifier = await ethers.deployContract("CLProofVerifier", [
        GI_FIRST_VALIDATOR_INDEX, // GI_FIRST_VALIDATOR_PREV
        GI_FIRST_VALIDATOR_INDEX, // GI_FIRST_VALIDATOR_CURR
        GI_HISTORICAL_SUMMARIES_INDEX, // GI_HISTORICAL_SUMMARIES_PREV
        GI_HISTORICAL_SUMMARIES_INDEX, // GI_HISTORICAL_SUMMARIES_CURR
        100_500, // FIRST_SUPPORTED_SLOT
        100_501, // PIVOT_SLOT
      ]);
    });

    it("accepts a valid proof and does not revert", async () => {
      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

      await expect(
        clProofVerifier.verifyValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).not.to.be.reverted;
    });

    it("reverts with 'UnsupportedSlot' when slot < FIRST_SUPPORTED_SLOT", async () => {
      // Use a slot smaller than 100_500
      const invalidHeader = {
        ...VALIDATOR_PROOF.beaconBlockHeader,
        slot: 99_999,
      };
      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

      await expect(
        clProofVerifier.verifyValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: invalidHeader,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.revertedWithCustomError(clProofVerifier, "UnsupportedSlot");
    });

    it("reverts with 'RootNotFound' if the staticcall to the block roots contract fails/returns empty", async () => {
      const badTimestamp = 999_999_999;
      await expect(
        clProofVerifier.verifyValidatorProof(
          {
            rootsTimestamp: badTimestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.revertedWithCustomError(clProofVerifier, "RootNotFound");
    });

    it("reverts with 'InvalidBlockHeader' if the block root from contract doesn't match the header root", async () => {
      const bogusBlockRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
      const mismatchTimestamp = await updateBeaconBlockRoot(bogusBlockRoot);

      await expect(
        clProofVerifier.verifyValidatorProof(
          {
            rootsTimestamp: mismatchTimestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.revertedWithCustomError(clProofVerifier, "InvalidBlockHeader");
    });

    it("reverts if the validator proof is incorrect", async () => {
      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

      // Mutate one proof entry to break it
      const badWitness = {
        ...VALIDATOR_PROOF.witness,
        validatorProof: [
          ...VALIDATOR_PROOF.witness.validatorProof.slice(0, -1),
          "0xbadbadbad0000000000000000000000000000000000000000000000000000000", // corrupt last entry
        ],
      };

      await expect(
        clProofVerifier.verifyValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          badWitness,
        ),
      ).to.be.reverted;
    });
  });

  describe("verifyHistoricalValidatorProof method", () => {
    const GI_FIRST_VALIDATOR_INDEX = "0x0000000000000000000000000000000000000000000000000056000000000028";
    const GI_HISTORICAL_SUMMARIES_INDEX = "0x0000000000000000000000000000000000000000000000000000000000003b00";

    const VALIDATOR_PROOF = {
      blockRoot: "0x657c451abdfbae5c4a18c699a87ecdb76e00d7ef9af9c7fcf3d7c4a700dad12d",
      beaconBlockHeader: {
        slot: 6073654,
        proposerIndex: 31415,
        parentRoot: "0x24265b525422ca972dfb33372a20a8ce241e4726d6920028b409841664fba54c",
        stateRoot: "0x5d5c80b9b03018142083eac6da1433da370037d0c4f9ba6dfa586c689ce270dc",
        bodyRoot: "0xe14a6474295a5cafbd30acec9347e21ba4c03fe96c5add4b96b468b4b1e69154",
      },
      oldBlock: {
        beaconBlockHeader: {
          slot: 1743359,
          proposerIndex: 1337,
          parentRoot: "0x5db6dfb2b5e735bafb437a76b9e525e958d2aef589649e862bfbc02964edf5ab",
          stateRoot: "0x7872be65d584621635a0192bd4424a5b30a24e1a9096f1aac5e8e6f046bf49bd",
          bodyRoot: "0xe14a6474295a5cafbd30acec9347e21ba4c03fe96c5add4b96b468b4b1e69154",
        },
        rootGIndex: "0x000000000000000000000000000000000000000000000000000000ec00000000",
        proof: [
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0xf5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b",
          "0xdb56114e00fdd4c1f85c892bf35ac9a89289aaecb1ebd0a96cde606a748b5d71",
          "0xc78009fdf07fc56a11f122370658a353aaa542ed63e44c4bc15ff4cd105ab33c",
          "0x536d98837f2dd165a55d5eeae91485954472d56f246df256bf3cae19352a123c",
          "0x9efde052aa15429fae05bad4d0b1d7c64da64d03d7a1854a588c2cb8430c0d30",
          "0xd88ddfeed400a8755596b21942c1497e114c302e6118290f91e6772976041fa1",
          "0x87eb0ddba57e35f6d286673802a4af5975e22506c7cf4c64bb6be5ee11527f2c",
          "0x26846476fd5fc54a5d43385167c95144f2643f533cc85bb9d16b782f8d7db193",
          "0x506d86582d252405b840018792cad2bf1259f1ef5aa5f887e13cb2f0094f51e1",
          "0xffff0ad7e659772f9534c195c815efc4014ef1e1daed4404c06385d11192e92b",
          "0x6cf04127db05441cd833107a52be852868890e4317e6a02ab47683aa75964220",
          "0xb7d05f875f140027ef5118a2247bbb84ce8f2f0f1123623085daf7960c329f5f",
          "0xdf6af5f5bbdb6be9ef8aa618e4bf8073960867171e29676f8b284dea6a08a85e",
          "0xb58d900f5e182e3c50ef74969ea16c7726c549757cc23523c369587da7293784",
          "0xd49a7502ffcfb0340b1d7885688500ca308161a7f96b62df9d083b71fcc8f2bb",
          "0x8fe6b1689256c0d385f42f5bbe2027a22c1996e110ba97c171d3e5948de92beb",
          "0x8d0d63c39ebade8509e0ae3c9c3876fb5fa112be18f905ecacfecb92057603ab",
          "0x95eec8b2e541cad4e91de38385f2e046619f54496c2382cb6cacd5b98c26f5a4",
          "0xf893e908917775b62bff23294dbbe3a1cd8e6cc1c35b4801887b646a6f81f17f",
          "0xcddba7b592e3133393c16194fac7431abf2f5485ed711db282183c819e08ebaa",
          "0x8a8d7fe3af8caa085a7639a832001457dfb9128a8061142ad0335629ff23ff9c",
          "0xfeb3c337d7a51a6fbf00b9e34c52e1c9195c969bd4e7a0bfd51d5c5bed9c1167",
          "0xe71f0aa83cc32edfbefa9f4d3e0174ca85182eec9f3a09f6a6c0df6377a510d7",
          "0x0100000000000000000000000000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x2658397f87f190d84814e4595b3ec8eb0110ab5be675d59434d5a3dfd5ef760d",
          "0xdb56114e00fdd4c1f85c892bf35ac9a89289aaecb1ebd0a96cde606a748b5d71",
          "0xe537052d30df4f0436cd5a3c5debd331c770d9df46da47e0e3db74906186fa09",
          "0x4616e1d9312a92eb228e8cd5483fa1fca64d99781d62129bc53718d194b98c45",
        ],
      },
      witness: {
        validatorIndex: 673610,
        validator: {
          pubkey: "0xa6e2ebcef8e8aa149ee3a0d4cfafdfb0e592914038c38d81b174cab83ba3f9c3dcf4d10776cd8c25e7729204db5f145f",
          withdrawalCredentials: "0x010000000000000000000000b3e29c46ee1745724417c0c51eb2351a1c01cf36",
          effectiveBalance: 32000000000,
          activationEligibilityEpoch: 21860,
          activationEpoch: 21866,
          exitEpoch: 41672,
          withdrawableEpoch: 41928,
          slashed: false,
        },
        validatorProof: [
          "0x9a38ebbd300b757b903b0508c0319a24a2085e6ea32477b0ccf0fcfdaae57ffa",
          "0x9a80eeb8748d92854d659b31862663afd95a7d0b5c58784e390b96cc5cf8a050",
          "0x894ecc352a325a00ef1b4607bdfe20c811f894ebba68b428294c60d701f56adf",
          "0xfb5ac36fdbd1aa8d349bc3ab269835ecace76787882f276e1188923a7e97aa15",
          "0x5ec5527e0e52856e679ffa5a3055cba1ceafcddf295eb0c62e6972d4388e7472",
          "0x7da3ff199f7e66789fc0acedda61e3b9ba4d444770e8c962736bba32e121c9da",
          "0x47540c45db936f74c0c0ad745588b465fa26eca7d6d6d44782dd3da7b28bc1e9",
          "0x86ed60c17e59e0fadb5287b21f735dad27d1a4c8f8fe0b0e178c9b0b9db4e629",
          "0xcf048e4d5f1099beef7cec38a8e7b7390592c9d6d295a4d53520e6b94989c80a",
          "0xc9f5d836a2d0b701948097bc0ba77f48b3f4c7d19d6af14fb61ae75033f6529f",
          "0x7cf412a36fdcd86ecc6c4af72f8e1b02c766cafca07d6589f95136231bce32c3",
          "0x264c4483d374885d55c21f1902f86f9fd85c3c4381522e1e4a3a61e6a3fd700c",
          "0xce5d7735c68dae371b4d72732cdb5ea1349f099d20f234193a27229dda008945",
          "0x593fb43e4d9b4e42766a9caca516a924daaad074145562fe207711b419e617e2",
          "0x12d47e17c665da9a0c9cda0fd030924285138901f4f9834c566b9c015a0a1344",
          "0x72f9ff98530f077ee309ed7e2b1d6cc0403521ac0ee52aadee3ad4d6599d24b5",
          "0xc8d966c9cc238f1c1f47f381f8395cf071ab7bd2107735040df853eb9ce644c7",
          "0xda8d7b1ca5594f8b0bd8b61722c230a9a5b3832e71c7f0747fd7db63e5ed9adb",
          "0xce27e7bd7b49d82e19110527914bdf8c6206ea517ca6acd1694810c03a1abee1",
          "0x3adb047395ba4b2d70ccc75bceffc288d7eb3fcb4bf7e2e15ed0c604d794ba4b",
          "0x275e385218e4241e9714c0e5da831c375c82630d4723be82544acaa4f598ee4d",
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
          "0xcb2c1a0000000000000000000000000000000000000000000000000000000000",
          "0xbc36040000000000000000000000000000000000000000000000000000000000",
          "0x0ed6189bc73badc7cf2cd2f0e54551a3b1d2192ee26bbb58d670d069b31b148e",
          "0x80eb44447d4f078e878a8b5fd2e3d3833a368e1d12239503e9f7b4605a0d782a",
          "0xbb2952772995323016b98233c26e96e5c54955fda62e643cb56981da6aab7365",
          "0x2b790b51060aad6c32c0e5a8e95e4ea6b0c2c0171bd54ceae9ce10a7ef144fa2",
        ],
      },
    };

    let clProofVerifier: CLProofVerifier;

    before(async () => {
      clProofVerifier = await ethers.deployContract("CLProofVerifier", [
        GI_FIRST_VALIDATOR_INDEX, // GI_FIRST_VALIDATOR_PREV
        GI_FIRST_VALIDATOR_INDEX, // GI_FIRST_VALIDATOR_CURR
        GI_HISTORICAL_SUMMARIES_INDEX, // GI_HISTORICAL_SUMMARIES_PREV
        GI_HISTORICAL_SUMMARIES_INDEX, // GI_HISTORICAL_SUMMARIES_CURR
        100_500, // FIRST_SUPPORTED_SLOT
        100_501, // PIVOT_SLOT
      ]);
    });

    it("accepts a valid proof and does not revert", async () => {
      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

      await expect(
        clProofVerifier.verifyHistoricalValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          {
            header: VALIDATOR_PROOF.oldBlock.beaconBlockHeader,
            rootGIndex: VALIDATOR_PROOF.oldBlock.rootGIndex,
            proof: VALIDATOR_PROOF.oldBlock.proof,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).not.to.be.reverted;
    });

    it("reverts with 'UnsupportedSlot' if beaconBlock slot < FIRST_SUPPORTED_SLOT", async () => {
      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);
      const invalidHeader = {
        ...VALIDATOR_PROOF.beaconBlockHeader,
        slot: 50_000,
      };

      await expect(
        clProofVerifier.verifyHistoricalValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: invalidHeader,
          },
          {
            header: VALIDATOR_PROOF.oldBlock.beaconBlockHeader,
            rootGIndex: VALIDATOR_PROOF.oldBlock.rootGIndex,
            proof: VALIDATOR_PROOF.oldBlock.proof,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.revertedWithCustomError(clProofVerifier, "UnsupportedSlot");
    });

    it("reverts with 'UnsupportedSlot' if oldBlock slot < FIRST_SUPPORTED_SLOT", async () => {
      const oldBlock = {
        ...VALIDATOR_PROOF.oldBlock,
        beaconBlockHeader: {
          ...VALIDATOR_PROOF.oldBlock.beaconBlockHeader,
          slot: 99_999,
        },
      };
      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

      await expect(
        clProofVerifier.verifyHistoricalValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          {
            header: oldBlock.beaconBlockHeader,
            rootGIndex: oldBlock.rootGIndex,
            proof: oldBlock.proof,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.revertedWithCustomError(clProofVerifier, "UnsupportedSlot");
    });

    it("reverts with 'RootNotFound' if block root contract call fails", async () => {
      const badTimestamp = 999_999_999;

      await expect(
        clProofVerifier.verifyHistoricalValidatorProof(
          {
            rootsTimestamp: badTimestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          {
            header: VALIDATOR_PROOF.oldBlock.beaconBlockHeader,
            rootGIndex: VALIDATOR_PROOF.oldBlock.rootGIndex,
            proof: VALIDATOR_PROOF.oldBlock.proof,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.revertedWithCustomError(clProofVerifier, "RootNotFound");
    });

    it("reverts with 'InvalidBlockHeader' if returned root doesn't match the new block header root", async () => {
      // Deploy a mismatch root in the mock
      const bogusBlockRoot = "0xbadbadbad0000000000000000000000000000000000000000000000000000000";
      const mismatchTimestamp = await updateBeaconBlockRoot(bogusBlockRoot);

      await expect(
        clProofVerifier.verifyHistoricalValidatorProof(
          {
            rootsTimestamp: mismatchTimestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          {
            header: VALIDATOR_PROOF.oldBlock.beaconBlockHeader,
            rootGIndex: VALIDATOR_PROOF.oldBlock.rootGIndex,
            proof: VALIDATOR_PROOF.oldBlock.proof,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.revertedWithCustomError(clProofVerifier, "InvalidBlockHeader");
    });

    it("reverts with 'InvalidGIndex' if oldBlock.rootGIndex is not under the historicalSummaries root", async () => {
      // Provide an obviously wrong rootGIndex that won't match the parent's
      const invalidRootGIndex = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);

      await expect(
        clProofVerifier.verifyHistoricalValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          {
            header: VALIDATOR_PROOF.oldBlock.beaconBlockHeader,
            rootGIndex: invalidRootGIndex,
            proof: VALIDATOR_PROOF.oldBlock.proof,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.revertedWithCustomError(clProofVerifier, "InvalidGIndex");
    });

    it("reverts if the oldBlock proof is corrupted", async () => {
      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);
      // Mutate one proof entry to break the historical block proof
      const badOldBlock = {
        ...VALIDATOR_PROOF.oldBlock,
        proof: [
          ...VALIDATOR_PROOF.oldBlock.proof.slice(0, -1),
          "0xbadbadbad0000000000000000000000000000000000000000000000000000000",
        ],
      };

      await expect(
        clProofVerifier.verifyHistoricalValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          {
            header: badOldBlock.beaconBlockHeader,
            rootGIndex: badOldBlock.rootGIndex,
            proof: badOldBlock.proof,
          },
          VALIDATOR_PROOF.witness,
        ),
      ).to.be.reverted;
    });

    it("reverts if the validatorProof in the witness is corrupted", async () => {
      const timestamp = await updateBeaconBlockRoot(VALIDATOR_PROOF.blockRoot);
      // Mutate the validator proof
      const badWitness = {
        ...VALIDATOR_PROOF.witness,
        validatorProof: [
          ...VALIDATOR_PROOF.witness.validatorProof.slice(0, -1),
          "0xbadbadbad0000000000000000000000000000000000000000000000000000000",
        ],
      };

      await expect(
        clProofVerifier.verifyHistoricalValidatorProof(
          {
            rootsTimestamp: timestamp,
            header: VALIDATOR_PROOF.beaconBlockHeader,
          },
          {
            header: VALIDATOR_PROOF.oldBlock.beaconBlockHeader,
            rootGIndex: VALIDATOR_PROOF.oldBlock.rootGIndex,
            proof: VALIDATOR_PROOF.oldBlock.proof,
          },
          badWitness,
        ),
      ).to.be.reverted;
    });
  });
});
