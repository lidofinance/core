export type BlockHeader = {
  slot: number;
  proposerIndex: string;
  parentRoot: string;
  stateRoot: string;
  bodyRoot: string;
};

export type ValidatorState = {
  pubkey: string;
  index: number;
  withdrawalCredentials: string;
  effectiveBalance: bigint;
  activationEligibilityEpoch: bigint;
  activationEpoch: bigint;
  exitEpoch: bigint;
  withdrawableEpoch: bigint;
  slashed: boolean;
};

export type ValidatorStateProof = {
  beaconBlockHeaderRoot: string;
  beaconBlockHeader: BlockHeader;
  futureBeaconBlockHeaderRoot: string;
  futureBeaconBlockHeader: BlockHeader;
  validator: ValidatorState;
  validatorProof: string[];
  historicalSummariesGI: string;
  historicalRootProof: string[];
};

export const ACTIVE_VALIDATOR_PROOF: ValidatorStateProof = {
  beaconBlockHeaderRoot: "0xa7f100995b35584c670fe25aa97ae23a8305f5eba8eee3532dedfcc8cf934dca",
  beaconBlockHeader: {
    slot: 10080800,
    proposerIndex: "1337",
    parentRoot: "0x03aa03b69bedd0e423ba545d38e216c4bf2f423e6f5a308477501b9a31ff8d8f",
    stateRoot: "0x508ee9ba052583d9cae510e7333d9776514d42cd10b853395dc24c275a95bc1d",
    bodyRoot: "0x8db50db3356352a01197abd32a52f97c2bb9b48bdbfb045ea4a7f67c9b84be0b",
  },
  futureBeaconBlockHeaderRoot: "0xca237c523d507a91b2b91389d517c0d4b03e66732984b5d56c74a47a06eb7ef4",
  futureBeaconBlockHeader: {
    slot: 14411095,
    proposerIndex: "31415",
    parentRoot: "0x391127160b857e9cdec243ea70f42082d28135c75880c2b5c505b98dec726c79",
    stateRoot: "0x972b36a298aa6bc1d205d115f0384fe1e3a301625907c07f5344b26337d5f494",
    bodyRoot: "0x8db50db3356352a01197abd32a52f97c2bb9b48bdbfb045ea4a7f67c9b84be0b",
  },
  validator: {
    pubkey: "0x800000c8a5364c1d1e3c4cdb65a28fd21daff4e1fb426c0fb09808105467e4a490d8b3507e7efffbd71024129f1a6b8d",
    withdrawalCredentials: "0x0100000000000000000000007cd73ab82e3a8e74a3fdfd6a41fed60536b8e501",
    effectiveBalance: 32000000000n,
    activationEligibilityEpoch: 207905n,
    activationEpoch: 217838n,
    exitEpoch: 18446744073709551615n,
    withdrawableEpoch: 18446744073709551615n,
    slashed: false,
    index: 773833,
  },
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
  historicalSummariesGI: "0x000000000000000000000000000000000000000000000000000000ec00000000",
  historicalRootProof: [
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
};
