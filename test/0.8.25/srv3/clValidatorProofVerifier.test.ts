import { expect } from "chai";
import { ethers } from "hardhat";

import { CLValidatorVerifier__Harness } from "typechain-types";

import { generateBeaconHeader, generateValidator, setBeaconBlockRoot } from "lib/pdg";
import { buildBeaconHeaderProof, buildValidatorStateProofs, ValidatorContainer } from "lib/top-ups";

const MAX_UINT64 = (1n << 64n) - 1n;

const STATIC_VALIDATOR = {
  blockRoot: "0xbe928e3a9fa76b916df79d78a8b67237f9b133269bb421f37490b7624abad452",
  beaconRootData: {
    childBlockTimestamp: 1769723675n,
    slot: 13574970n,
    proposerIndex: 1704508n,
  },
  validators: [
    {
      index: 12345,
      witness: {
        proofValidator: [
          "0x216b6e8fa6cc4f005b56c12afdf98fad45ece56133c8e460fa4141d4003776aa",
          "0xc9cd3df16c39ee2ab805653e93aa7c66dfa8b4313b42367e0e2c93b97c467a7c",
          "0xbccc857f25b04e4ffbfb3bb4a739f2ee21668f9ac5e6d6ffe243a83bd53773dd",
          "0x9428eb489f519010c69549cec7acc9e93ed5be99de26feda1434d36821ae325d",
          "0x286483026731535ec459bbe6299db5d838261f2da5cbafd85630bca4e8ebebb0",
          "0x8b6f3cb97fe65b7cdbda7ee19b403bc148a6f4c185b2e06aa24f26696edf9274",
          "0x2502294ada8a819553c36c45e10f6d37230b1bfe4a60c3b122e25ec7687e7b06",
          "0x71d33773e8b437e94c30b30980472ef59686fc07c79eb513dae455c2b3feeddb",
          "0x4fa851a66a442c140c6cb5d038ee03e9f2538780d455c57cb752eca56e874f2a",
          "0x9e4db5b11d21e0d57de169caa2a129555275cf59e612cefea0da82d9f2a9b56a",
          "0x7d95d434555b5cbfac0c34585b232314a53cc11a3f80cab5a3bd3c8824247e08",
          "0x94d35de0bc90861fef95220f1dc8bd90738f2057ac801454ca7a81ecdc2f5a0e",
          "0xf9161f3c69d468aae3ae78deae56e59e4a9722dae2dab2d8427e16ec401acafa",
          "0xfdfde41dd4fbee3943abf104c54689f1587e821f018ddee1ce6838d4f1fe3024",
          "0x6f4a3562c9b16e8e63d5b956a3305b37efb4e716777867bbf22825e9185b67b4",
          "0x2ba6010fd77fc624970171c55647a13f75680122802f168fe16553a4bf251d33",
          "0xb8a2b7d9d041154028a82877bdc2b4adb76475d4797f3ac586d319c76644309e",
          "0xfb2f06c2b4c43f7252844db5fff60e0bfc207bdcecaae2fc53c37f1b9e03e50a",
          "0x32c59b5c8c804d2a3c4c72415f1afc3d0db5c80c0bd5a8e404150121ad340abe",
          "0x9a07eeffcc8578a939d457d107ec733bf3b121a7ff9f84e179931ee9237be7cb",
          "0xf302fc1c45667fe834ab5537774ae4679dd6d9d4fca3e0a6b6dc6d6dd84d48ba",
          "0xff6fa857e6a6b00c6f71ea4c5bf522535561ca25abd32389677b26c5a4b140df",
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
          "0x5e8d210000000000000000000000000000000000000000000000000000000000",
          "0xc6341f0000000000000000000000000000000000000000000000000000000000",
          "0x797d496cea42b783b4ada624d44fa8d0fd7ff09214509c1fab9dd7618dec8db3",
          "0xd492b2a4246027ef1a1fa848bbae345f077680e86b5fe0a394251b63da1f9381",
          "0x044cd392c78edc7bbda4544fa482c11effa29ac38ea4c87a4dd11bb0b4f5e0b5",
          "0x4db7cb7fae529d04f8c42467d5ab71190aba9ef6982e8c5aecfb682eaaf0024e",
          "0x79a3cf55bfd7c33308555b76aec5b6b6dfa1c4b628773cd0657a5bd00c9255d5",
          "0xa78bc2eae77405eb3badf1a31e7c5b46cf44e0fb90b25c1ac3e39d9368c73ac3",
          "0x4a4eb09f597003c58696430554b7154a878f31c09422870e70aa3b34c928e30c",
          "0x420db8b9116cae945235fb92dd224c30bda527f31b71e859e8be5ad8b33f83ba",
        ],
        pubkey: "0x80773a007f9e496a196b8f28fae04ddaa72fa65c0f8a98145a1e192082c3edcf7cee891ccf1d6b6fee0abe0045b9f61b",
        effectiveBalance: 0n,
        activationEligibilityEpoch: 0n,
        activationEpoch: 0n,
        exitEpoch: 400136n,
        withdrawableEpoch: 400392n,
        slashed: false,
      },
    },
    {
      index: 67890,
      witness: {
        proofValidator: [
          "0x48c9ab2d18314cc8b31d343abaf430e32165ffece1333c4b30598c3e653bb8c4",
          "0xe1150bdb10f20186ac2d48c874bcd8ee07201d1082351e56ad6b232b6ede0ed9",
          "0x0e51272c8f40696dd2a1af27f1b4941676e778bd015fe03aee65901ba576da74",
          "0x8ee28dca9c22ac9c0ffe72524012dde0e36ae3b421768fa08bcfb78231515aeb",
          "0x6ac30c0e3188ecdb2c7f7ad4c27e936bb449d0c2d89d43a6f0c4348b5d3f8da9",
          "0x2ef2d2287454ef3bb5066e139c4dfb3042b423c3c05e379d8885fd5feb205827",
          "0x9ac6b7bba6408f9e9be2f9a0fca03771d3a5f1c817314c90a0402b868319fb5f",
          "0x00acd7dfea9c4c686a6ccd697ddd9d3dbe44b771c6bc7fa73943b23256320b34",
          "0x88e66715b98a5621b58dc5d9baa5fb4a9c07cd8e28a2ff771e02d1ddc7b1af52",
          "0xc3c233aa48ac7d546942cd42a162e12276fe8a061df5bb07adc8c0d1f1e5f94a",
          "0xdc76934849f2b932a88326e3ff1aa140c042bc541a3453e5d0909c2f4378850a",
          "0x57455c42a8f749c6c849c9ba01b2279d192ab1e18ee8319ace30bd549c375349",
          "0x99276db9294041d58d89ce524a33a4d60bc2b5019bf6bc3d6de02e952f6e34bc",
          "0xfb73dc74945a6f29dd4b3f1b0fa938f77926e4a1256ea3407067cf66ff284af4",
          "0x19641f85d86a45b1bff5d9792c0a622328f645815e32184e1b0c13bd2eedd0f0",
          "0x261abd8edbccfb08a970621e9330115f97177619f9f657c091d6b05b2056a59d",
          "0x2f015c6b4fc7f03cbd3366bbbf96574901b81742af5e98b0f01cc50705b25ceb",
          "0xfb2f06c2b4c43f7252844db5fff60e0bfc207bdcecaae2fc53c37f1b9e03e50a",
          "0x32c59b5c8c804d2a3c4c72415f1afc3d0db5c80c0bd5a8e404150121ad340abe",
          "0x9a07eeffcc8578a939d457d107ec733bf3b121a7ff9f84e179931ee9237be7cb",
          "0xf302fc1c45667fe834ab5537774ae4679dd6d9d4fca3e0a6b6dc6d6dd84d48ba",
          "0xff6fa857e6a6b00c6f71ea4c5bf522535561ca25abd32389677b26c5a4b140df",
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
          "0x5e8d210000000000000000000000000000000000000000000000000000000000",
          "0xc6341f0000000000000000000000000000000000000000000000000000000000",
          "0x797d496cea42b783b4ada624d44fa8d0fd7ff09214509c1fab9dd7618dec8db3",
          "0xd492b2a4246027ef1a1fa848bbae345f077680e86b5fe0a394251b63da1f9381",
          "0x044cd392c78edc7bbda4544fa482c11effa29ac38ea4c87a4dd11bb0b4f5e0b5",
          "0x4db7cb7fae529d04f8c42467d5ab71190aba9ef6982e8c5aecfb682eaaf0024e",
          "0x79a3cf55bfd7c33308555b76aec5b6b6dfa1c4b628773cd0657a5bd00c9255d5",
          "0xa78bc2eae77405eb3badf1a31e7c5b46cf44e0fb90b25c1ac3e39d9368c73ac3",
          "0x4a4eb09f597003c58696430554b7154a878f31c09422870e70aa3b34c928e30c",
          "0x420db8b9116cae945235fb92dd224c30bda527f31b71e859e8be5ad8b33f83ba",
        ],
        pubkey: "0x85c12b9cd79c0fd7712db78245d14583c465e7c4cf4045b83ca34b1f148d85a1fe16dd2004f3332e8dc6312793f5db4a",
        effectiveBalance: 0n,
        activationEligibilityEpoch: 7074n,
        activationEpoch: 11751n,
        exitEpoch: 195058n,
        withdrawableEpoch: 195314n,
        slashed: false,
      },
    },
  ],
};

describe("CLTopUpProofVerifier", () => {
  const SLOT = 3200; // epoch 100
  const WRONG_WC = "0x" + "11".repeat(32);

  let baseValidators: ValidatorContainer[];
  let verifier: CLValidatorVerifier__Harness;

  before(async () => {
    // A populated registry so proven validators do not sit at index zero.
    baseValidators = Array.from({ length: 100 }, () => generateValidator().container);

    // MAX_UINT64 keeps this verifier on the pre-Gloas path for every slot.
    verifier = await ethers.deployContract("CLValidatorVerifier__Harness", [MAX_UINT64]);
  });

  /** A validator that passes every witness check at epoch(SLOT) = 100 unless overridden. */
  const activeValidator = (overrides: Partial<ValidatorContainer> = {}): ValidatorContainer => ({
    ...generateValidator().container,
    slashed: false,
    activationEligibilityEpoch: 1n,
    activationEpoch: 2n,
    exitEpoch: MAX_UINT64,
    withdrawableEpoch: MAX_UINT64,
    ...overrides,
  });

  /** The gateway's ValidatorWitness struct for a container and its combined Merkle proof. */
  const toWitness = (container: ValidatorContainer, proofValidator: string[]) => ({
    proofValidator,
    pubkey: container.pubkey,
    effectiveBalance: container.effectiveBalance,
    slashed: container.slashed,
    activationEligibilityEpoch: container.activationEligibilityEpoch,
    activationEpoch: container.activationEpoch,
    exitEpoch: container.exitEpoch,
    withdrawableEpoch: container.withdrawableEpoch,
  });

  /** Publishes a beacon header for the state root via EIP-4788 and returns the gateway inputs. */
  const anchorState = async (stateRoot: string, slot: number) => {
    const header = generateBeaconHeader(stateRoot, slot);
    const { root, proof } = await buildBeaconHeaderProof(header);
    const childBlockTimestamp = await setBeaconBlockRoot(root);
    return {
      headerProof: proof,
      beaconRootData: { childBlockTimestamp, slot: header.slot, proposerIndex: header.proposerIndex },
    };
  };

  /** Proves `container` as the last validator of a fresh pre-Gloas state anchored at `slot`. */
  const proveValidator = async (container: ValidatorContainer, slot = SLOT) => {
    const validators = [...baseValidators, container];
    const validatorIndex = validators.length - 1;
    const state = await buildValidatorStateProofs(validators);
    const { headerProof, beaconRootData } = await anchorState(state.root, slot);
    return {
      validatorIndex,
      beaconRootData,
      witness: toWitness(container, [...state.proofs[validatorIndex], ...headerProof]),
    };
  };

  it("verifies an active validator and rejects a wrong withdrawal credential", async () => {
    const container = activeValidator();
    const { validatorIndex, beaconRootData, witness } = await proveValidator(container);

    await verifier.TEST_verifyValidator(beaconRootData, witness, validatorIndex, container.withdrawalCredentials);

    await expect(verifier.TEST_verifyValidator(beaconRootData, witness, validatorIndex, WRONG_WC)).to.be.reverted;
  });

  // The verifier only authenticates the witness; these states are filtered (or allowed) elsewhere.
  for (const [name, overrides] of [
    ["a slashed validator", { slashed: true }],
    ["activationEpoch above the proven epoch", { activationEpoch: 101n }],
    ["activationEpoch equal to the proven epoch", { activationEpoch: 100n }],
    ["an exiting validator", { activationEligibilityEpoch: 70n, activationEpoch: 90n, exitEpoch: 101n }],
  ] as const) {
    it(`accepts a correct proof of ${name}`, async () => {
      const container = activeValidator(overrides);
      const { validatorIndex, beaconRootData, witness } = await proveValidator(container);

      await verifier.TEST_verifyValidator(beaconRootData, witness, validatorIndex, container.withdrawalCredentials);
    });
  }

  it("uses the same pre-Gloas validator paths as Lodestar's Electra BeaconState", async () => {
    const state = await buildValidatorStateProofs(baseValidators);

    for (const index of [0, 1, baseValidators.length - 1]) {
      expect(await verifier.TEST_getValidatorGI(index, SLOT)).to.equal(state.gindices[index]);
    }
  });

  // Proofs captured from a real mainnet block; they guard against regressions relative to production data.
  const staticBeaconRootData = async () => ({
    ...STATIC_VALIDATOR.beaconRootData,
    childBlockTimestamp: await setBeaconBlockRoot(STATIC_VALIDATOR.blockRoot),
  });

  const STATIC_WC = [
    "0x010000000000000000000000ddc6ed6e6a9c1e55c87b155b9a40bac4721a6dac",
    "0x010000000000000000000000210b3cb99fa1de0a64085fa80e18c22fe4722a1b",
  ];

  for (const [i, v] of STATIC_VALIDATOR.validators.entries()) {
    it(`verifies static mainnet validator ${v.index}`, async () => {
      await verifier.TEST_verifyValidator(await staticBeaconRootData(), v.witness, v.index, STATIC_WC[i]);
    });
  }

  it("rejects a static mainnet witness with wrong withdrawal credentials", async () => {
    const v = STATIC_VALIDATOR.validators[0];

    await expect(verifier.TEST_verifyValidator(await staticBeaconRootData(), v.witness, v.index, WRONG_WC)).to.be
      .reverted;
  });

  it("rejects a static mainnet witness with a tampered proof", async () => {
    const v = STATIC_VALIDATOR.validators[0];
    const tampered = { ...v.witness, proofValidator: [...v.witness.proofValidator] };
    tampered.proofValidator[0] = "0x" + "aa".repeat(32);

    await expect(verifier.TEST_verifyValidator(await staticBeaconRootData(), tampered, v.index, STATIC_WC[0])).to.be
      .reverted;
  });

  it("should change gIndex on Gloas slot", async () => {
    const gloasSlot = 1000;

    const proofVerifier = await ethers.deployContract("CLValidatorVerifier__Harness", [gloasSlot], {});
    expect(await proofVerifier.TEST_getValidatorGI(1n, gloasSlot - 1)).to.equal(0x960000000001n);
    expect(await proofVerifier.TEST_getValidatorGI(0n, gloasSlot)).to.equal(0x598n);
    expect(await proofVerifier.TEST_getValidatorGI(1n, gloasSlot + 1)).to.equal(0x2cc8n);
  });

  // The fork switch above only shows that the index moves. This proves real containers against the
  // progressive-list layout, where the proof depth varies per chunk — a layout mismatch surfaces as
  // an SSZ branch-length revert rather than a wrong index.
  it("verifies validators across Gloas progressive-list chunk boundaries", async () => {
    const GLOAS_SLOT = 1000;
    const slot = GLOAS_SLOT + 2200; // after the fork; epoch past activation
    const gloasVerifier = await ethers.deployContract("CLValidatorVerifier__Harness", [GLOAS_SLOT]);

    // 22 validators cover the 1-, 4- and 16-wide chunks plus the start of the 64-wide chunk.
    const containers = Array.from({ length: 22 }, () => activeValidator());
    const state = await buildValidatorStateProofs(containers, { gloas: true });

    const { headerProof, beaconRootData } = await anchorState(state.root, slot);

    // The first and last validator of each chunk.
    for (const index of [0, 1, 4, 5, 20, 21]) {
      expect(await gloasVerifier.TEST_getValidatorGI(index, slot)).to.equal(state.gindices[index]);

      const witness = toWitness(containers[index], [...state.proofs[index], ...headerProof]);
      await gloasVerifier.TEST_verifyValidator(beaconRootData, witness, index, containers[index].withdrawalCredentials);
    }

    // The same witness must not verify on the pre-Gloas layout: the path and depth differ.
    const witness = toWitness(containers[1], [...state.proofs[1], ...headerProof]);
    await expect(verifier.TEST_verifyValidator(beaconRootData, witness, 1, containers[1].withdrawalCredentials)).to.be
      .reverted;
  });
});
