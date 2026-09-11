import { BigNumberish, concat, solidityPackedKeccak256, toBeHex } from "ethers";

import { DepositSecurityModule } from "typechain-types";

import { sign } from "./ec";

class DSMMessage {
  static MESSAGE_PREFIX: string;

  constructor(public readonly guardian: string) {}

  static setMessagePrefix(newMessagePrefix: string) {
    this.MESSAGE_PREFIX = newMessagePrefix;
  }

  get messagePrefix(): string {
    const messagePrefix = (this.constructor as typeof DSMMessage).MESSAGE_PREFIX;
    if (messagePrefix === undefined) {
      throw new Error(`MESSAGE_PREFIX isn't set`);
    }
    return messagePrefix;
  }

  get hash(): string {
    throw new Error("Unimplemented");
  }

  sign(signerPrivateKey: string): DepositSecurityModule.GuardianSignatureStruct {
    const signature = sign(this.hash, signerPrivateKey);
    return {
      guardian: this.guardian,
      signature: concat([signature.r, signature.s, toBeHex(signature.v, 1)]),
    };
  }
}

export class DSMAttestMessage extends DSMMessage {
  blockNumber: BigNumberish;
  blockHash: string;
  depositRoot: string;
  stakingModule: BigNumberish;
  nonce: BigNumberish;

  constructor(
    guardian: string,
    blockNumber: BigNumberish,
    blockHash: string,
    depositRoot: string,
    stakingModule: BigNumberish,
    nonce: BigNumberish,
  ) {
    super(guardian);
    this.blockNumber = blockNumber;
    this.blockHash = blockHash;
    this.depositRoot = depositRoot;
    this.stakingModule = stakingModule;
    this.nonce = nonce;
  }

  get hash() {
    return solidityPackedKeccak256(
      ["bytes32", "address", "uint256", "bytes32", "bytes32", "uint256", "uint256"],
      [
        this.messagePrefix,
        this.guardian,
        this.blockNumber,
        this.blockHash,
        this.depositRoot,
        this.stakingModule,
        this.nonce,
      ],
    );
  }
}

export class DSMPauseMessage extends DSMMessage {
  blockNumber: BigNumberish;

  constructor(guardian: string, blockNumber: BigNumberish) {
    super(guardian);
    this.blockNumber = blockNumber;
  }

  get hash() {
    return solidityPackedKeccak256(
      ["bytes32", "address", "uint256"],
      [this.messagePrefix, this.guardian, this.blockNumber],
    );
  }
}

export class DSMUnvetMessage extends DSMMessage {
  blockNumber: BigNumberish;
  blockHash: string;
  stakingModule: BigNumberish;
  nonce: BigNumberish;
  nodeOperatorIds: string;
  vettedSigningKeysCounts: string;

  constructor(
    guardian: string,
    blockNumber: BigNumberish,
    blockHash: string,
    stakingModule: BigNumberish,
    nonce: BigNumberish,
    nodeOperatorIds: string,
    vettedSigningKeysCounts: string,
  ) {
    super(guardian);
    this.blockNumber = blockNumber;
    this.blockHash = blockHash;
    this.stakingModule = stakingModule;
    this.nonce = nonce;
    this.nodeOperatorIds = nodeOperatorIds;
    this.vettedSigningKeysCounts = vettedSigningKeysCounts;
  }

  get hash() {
    return solidityPackedKeccak256(
      ["bytes32", "address", "uint256", "bytes32", "uint256", "uint256", "bytes", "bytes"],
      [
        this.messagePrefix,
        this.guardian,
        this.blockNumber,
        this.blockHash,
        this.stakingModule,
        this.nonce,
        this.nodeOperatorIds,
        this.vettedSigningKeysCounts,
      ],
    );
  }
}
