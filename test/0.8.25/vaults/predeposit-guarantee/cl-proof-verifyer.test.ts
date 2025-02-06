import { hexlify, parseUnits, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { CLProofVerifier__Harness } from "typechain-types";
import { ValidatorStruct } from "typechain-types/contracts/0.8.25/predeposit_guarantee/PredepositGuarantee";
import { ValidatorWitnessStruct } from "typechain-types/contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee";

import { Tracing } from "test/suite";

export const generateValidator = (customWC?: string, customPukey?: string): ValidatorStruct => {
  const randomInt = (max: number): number => Math.floor(Math.random() * max);
  const randomBytes32 = (): string => hexlify(randomBytes(32));
  const randomValidatorPubkey = (): string => hexlify(randomBytes(96));

  return {
    pubkey: customPukey ?? randomValidatorPubkey(),
    withdrawalCredentials: customWC ?? randomBytes32(),
    effectiveBalance: parseUnits(randomInt(32).toString(), "gwei"),
    slashed: false,
    activationEligibilityEpoch: randomInt(343300),
    activationEpoch: randomInt(343300),
    exitEpoch: randomInt(343300),
    withdrawableEpoch: randomInt(343300),
  };
};

// CSM "borrowed" prefab validator object with mocked state root
const STATIC_VALIDATOR = {
  // state root mocked as block root because CSM proves against state and verifies block root separately
  root: "0x21205c716572ae05692c0f8a4c64fd84e504cbb1a16fa0371701adbab756dd72",
  witness: {
    validatorIndex: 1551477n,
    beaconBlockTimestamp: 42,
    validator: {
      pubkey: "0xa5b3dfbe60eb74b9224ec56bb253e18cf032c999818f10bc51fc13a9c5584eb66624796a400c2047ac248146f58a2d3d",
      withdrawalCredentials: "0x010000000000000000000000c93c3e1c11037f5bd50f21cfc1a02aba5427b2f3",
      effectiveBalance: 0n,
      activationEligibilityEpoch: 21860n,
      activationEpoch: 21866n,
      exitEpoch: 41672n,
      withdrawableEpoch: 41928n,
      // used from slashing test
      slashed: true,
    },
    proof: [
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
  } as ValidatorWitnessStruct,
};

// random number integer generator

describe("CLProofVerifier.sol", () => {
  let CLProofVerifier: CLProofVerifier__Harness;
  before(async () => {
    CLProofVerifier = await ethers.deployContract("CLProofVerifier__Harness", {});
  });

  it("should verify validator object in merkle tree", async () => {
    await CLProofVerifier.setRoot(STATIC_VALIDATOR.root);
    Tracing.enable();
    await CLProofVerifier.TEST_validateWCProof(STATIC_VALIDATOR.witness, { gasLimit: 100000000 });
    Tracing.disable();
  });
});
