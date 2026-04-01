import { expect } from "chai";
import { ethers } from "hardhat";

import { CLValidatorVerifier__Harness, SSZValidatorsMerkleTree } from "typechain-types";

import { generateBeaconHeader, generateValidator, randomBytes32, setBeaconBlockRoot } from "lib/pdg";
import { prepareLocalMerkleTree } from "lib/top-ups";

const STATIC_VALIDATOR = {
  blockRoot: "0xbe928e3a9fa76b916df79d78a8b67237f9b133269bb421f37490b7624abad452",
  gIFirstValidator: "0x0000000000000000000000000000000000000000000000000096000000000028",
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
  let sszMerkleTree: SSZValidatorsMerkleTree;
  let gIFirstValidator: string;
  let firstValidatorLeafIndex: bigint;
  let verifier: CLValidatorVerifier__Harness;

  before(async () => {
    // 1) Build a local SSZ tree once
    const localTree = await prepareLocalMerkleTree();
    sszMerkleTree = localTree.stateTree;
    gIFirstValidator = localTree.gIFirstValidator;
    firstValidatorLeafIndex = localTree.firstValidatorLeafIndex;

    // populate merkle tree with validators
    for (let i = 1; i < 100; i++) {
      const v = generateValidator().container;
      await sszMerkleTree.addValidatorsLeaf(v);
    }

    // 2) Deploy the verifier (same GI for prev/curr, no pivot)
    verifier = await ethers.deployContract("CLValidatorVerifier__Harness", [
      gIFirstValidator, // GI_FIRST_VALIDATOR_PREV
      gIFirstValidator, // GI_FIRST_VALIDATOR_CURR
      0, // PIVOT_SLOT
    ]);
  });

  it("verifies full Validator container at head under EIP-4788", async () => {
    // 1) Create an 'active' validator at the target epoch
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 2n;
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    // Insert validator into the local SSZ tree
    await sszMerkleTree.addValidatorsLeaf(v.container);

    // Compute its index in validators[i]
    const leafCount = await sszMerkleTree.validatorsLeafCount();
    // Index = (current leaves - 1) - firstValidatorLeafIndex
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    // Anchor the current state_root into EIP-4788 via a header at SLOT
    const SLOT = 3200; // epoch = 100 (greater than activationEpoch)
    const stateRoot = await sszMerkleTree.getStateRoot();
    const beaconBlockHeader = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(beaconBlockHeader);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    // Build proof:
    //    - stateProof: validators[i] → validators_root → state_root
    //    - headerProof: state_root → … → beacon_block_root (contains parent(slot, proposer) node)
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));

    // state_root -> beacon_block_root
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);
    const proofValidator = [...validator_proofs, ...headerMerkle.proof];

    const beaconRootData = {
      childBlockTimestamp,
      slot: beaconBlockHeader.slot,
      proposerIndex: beaconBlockHeader.proposerIndex,
    };

    // 2) Validator witness (validator container only)
    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    // 4) Call harness
    await verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC);

    // 5) Negative: wrong WC must fail
    const wrongWC = "0x" + "11".repeat(32);
    await expect(verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, wrongWC)).to.be
      .reverted;
  });

  it("don't revert with ValidatorIsSlashed when slashed = true", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = true;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 2n;
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    await sszMerkleTree.addValidatorsLeaf(v.container);

    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    const SLOT = 3200; // epoch = 100
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    // validator[i] -> validators_root -> state_root'
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));

    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];

    const beaconRootData = {
      childBlockTimestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    };

    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    await expect(verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC)).to.not.be
      .rejected;
  });

  it("don't revert when activationEpoch > epoch(slot)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 101n; // > epoch(slot=3200)=100
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    await sszMerkleTree.addValidatorsLeaf(v.container);

    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    const SLOT = 3200;
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];

    const beaconRootData = {
      childBlockTimestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    };

    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    await verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC);
  });

  it("don't reverts when activationEpoch == epoch(slot)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;
    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 100n; // == epoch(slot)
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;
    const expectedWC = v.container.withdrawalCredentials;
    await sszMerkleTree.addValidatorsLeaf(v.container);
    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);
    const SLOT = 3200; // epoch=100
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);
    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const beaconRootData = {
      childBlockTimestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    };
    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    await verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC);
  });

  it("don't revert when a validator with non-FAR_FUTURE exitEpoch (proof mismatch)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;
    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 70n;
    v.container.activationEpoch = 90n;
    const SLOT = 3200; // epoch(slot) = 100
    v.container.exitEpoch = 101n; //
    v.container.withdrawableEpoch = FAR_FUTURE;
    const expectedWC = v.container.withdrawalCredentials;
    await sszMerkleTree.addValidatorsLeaf(v.container);
    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);
    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const beaconRootData = {
      childBlockTimestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    };
    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    await verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC);
  });

  it("should verify static validator 12345 with real mainnet proof", async () => {
    const staticVerifier = await ethers.deployContract("CLValidatorVerifier__Harness", [
      STATIC_VALIDATOR.gIFirstValidator,
      STATIC_VALIDATOR.gIFirstValidator,
      0,
    ]);

    const timestamp = await setBeaconBlockRoot(STATIC_VALIDATOR.blockRoot);

    const v = STATIC_VALIDATOR.validators[0];
    const beaconRootData = {
      ...STATIC_VALIDATOR.beaconRootData,
      childBlockTimestamp: timestamp,
    };

    await staticVerifier.TEST_verifyValidator(
      beaconRootData,
      v.witness,
      v.index,
      "0x010000000000000000000000ddc6ed6e6a9c1e55c87b155b9a40bac4721a6dac",
    );
  });

  it("should verify static validator 67890 with real mainnet proof", async () => {
    const staticVerifier = await ethers.deployContract("CLValidatorVerifier__Harness", [
      STATIC_VALIDATOR.gIFirstValidator,
      STATIC_VALIDATOR.gIFirstValidator,
      0,
    ]);

    const timestamp = await setBeaconBlockRoot(STATIC_VALIDATOR.blockRoot);

    const v = STATIC_VALIDATOR.validators[1];
    const beaconRootData = {
      ...STATIC_VALIDATOR.beaconRootData,
      childBlockTimestamp: timestamp,
    };

    await staticVerifier.TEST_verifyValidator(
      beaconRootData,
      v.witness,
      v.index,
      "0x010000000000000000000000210b3cb99fa1de0a64085fa80e18c22fe4722a1b",
    );
  });

  it("should reject static validator with wrong withdrawal credentials", async () => {
    const staticVerifier = await ethers.deployContract("CLValidatorVerifier__Harness", [
      STATIC_VALIDATOR.gIFirstValidator,
      STATIC_VALIDATOR.gIFirstValidator,
      0,
    ]);

    const timestamp = await setBeaconBlockRoot(STATIC_VALIDATOR.blockRoot);

    const v = STATIC_VALIDATOR.validators[0];
    const beaconRootData = {
      ...STATIC_VALIDATOR.beaconRootData,
      childBlockTimestamp: timestamp,
    };

    const wrongWC = "0x" + "11".repeat(32);
    await expect(staticVerifier.TEST_verifyValidator(beaconRootData, v.witness, v.index, wrongWC)).to.be.reverted;
  });

  it("should reject static validator with fake proof", async () => {
    const staticVerifier = await ethers.deployContract("CLValidatorVerifier__Harness", [
      STATIC_VALIDATOR.gIFirstValidator,
      STATIC_VALIDATOR.gIFirstValidator,
      0,
    ]);

    const timestamp = await setBeaconBlockRoot(STATIC_VALIDATOR.blockRoot);

    const v = STATIC_VALIDATOR.validators[0];
    const beaconRootData = {
      ...STATIC_VALIDATOR.beaconRootData,
      childBlockTimestamp: timestamp,
    };

    const tamperedWitness = {
      ...v.witness,
      proofValidator: [...v.witness.proofValidator],
    };
    tamperedWitness.proofValidator[0] = "0x" + "aa".repeat(32);

    await expect(
      staticVerifier.TEST_verifyValidator(
        beaconRootData,
        tamperedWitness,
        v.index,
        "0x010000000000000000000000ddc6ed6e6a9c1e55c87b155b9a40bac4721a6dac",
      ),
    ).to.be.reverted;
  });

  it("should change gIndex on pivot slot", async () => {
    const pivotSlot = 1000;
    const giPrev = randomBytes32();
    const giCurr = randomBytes32();

    const proofVerifier = await ethers.deployContract("CLValidatorVerifier__Harness", [giPrev, giCurr, pivotSlot], {});
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot - 1)).to.equal(giPrev);
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot)).to.equal(giCurr);
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot + 1)).to.equal(giCurr);
  });
});
