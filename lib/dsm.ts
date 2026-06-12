import { type BigNumberish, solidityPackedKeccak256 } from "ethers";

import { DepositSecurityModule } from "typechain-types";

import { sign, toEip2098 } from "./ec";

class DSMMessage {
  static MESSAGE_PREFIX: string;

  contractVersion: BigNumberish;

  constructor(contractVersion: BigNumberish) {
    this.contractVersion = contractVersion;
  }

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

  get isVersionedHash(): boolean {
    return BigInt(this.contractVersion.toString()) >= 4n;
  }

  sign(signerPrivateKey: string): DepositSecurityModule.SignatureStruct {
    return toEip2098(sign(this.hash, signerPrivateKey));
  }
}

export class DSMAttestMessage extends DSMMessage {
  blockNumber: number;
  blockHash: string;
  depositRoot: string;
  stakingModule: number;
  nonce: number;

  constructor(
    contractVersion: BigNumberish,
    blockNumber: number,
    blockHash: string,
    depositRoot: string,
    stakingModule: number,
    nonce: number,
  ) {
    super(contractVersion);
    this.blockNumber = blockNumber;
    this.blockHash = blockHash;
    this.depositRoot = depositRoot;
    this.stakingModule = stakingModule;
    this.nonce = nonce;
  }

  get hash() {
    if (!this.isVersionedHash) {
      return solidityPackedKeccak256(
        ["bytes32", "uint256", "bytes32", "bytes32", "uint256", "uint256"],
        [this.messagePrefix, this.blockNumber, this.blockHash, this.depositRoot, this.stakingModule, this.nonce],
      );
    }

    return solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "bytes32", "bytes32", "uint256", "uint256"],
      [
        this.messagePrefix,
        this.contractVersion,
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
  blockNumber: number;

  constructor(contractVersion: BigNumberish, blockNumber: number) {
    super(contractVersion);
    this.blockNumber = blockNumber;
  }

  get hash() {
    if (!this.isVersionedHash) {
      return solidityPackedKeccak256(["bytes32", "uint256"], [this.messagePrefix, this.blockNumber]);
    }

    return solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256"],
      [this.messagePrefix, this.contractVersion, this.blockNumber],
    );
  }
}

export class DSMUnvetMessage extends DSMMessage {
  blockNumber: number;
  blockHash: string;
  stakingModule: number;
  nonce: number;
  nodeOperatorIds: string;
  vettedSigningKeysCounts: string;

  constructor(
    contractVersion: BigNumberish,
    blockNumber: number,
    blockHash: string,
    stakingModule: number,
    nonce: number,
    nodeOperatorIds: string,
    vettedSigningKeysCounts: string,
  ) {
    super(contractVersion);
    this.blockNumber = blockNumber;
    this.blockHash = blockHash;
    this.stakingModule = stakingModule;
    this.nonce = nonce;
    this.nodeOperatorIds = nodeOperatorIds;
    this.vettedSigningKeysCounts = vettedSigningKeysCounts;
  }

  get hash() {
    if (!this.isVersionedHash) {
      return solidityPackedKeccak256(
        ["bytes32", "uint256", "bytes32", "uint256", "uint256", "bytes", "bytes"],
        [
          this.messagePrefix,
          this.blockNumber,
          this.blockHash,
          this.stakingModule,
          this.nonce,
          this.nodeOperatorIds,
          this.vettedSigningKeysCounts,
        ],
      );
    }

    return solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "bytes32", "uint256", "uint256", "bytes", "bytes"],
      [
        this.messagePrefix,
        this.contractVersion,
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
