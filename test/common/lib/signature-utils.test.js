const { artifacts, ethers, contract } = require('hardhat')

const { assert } = require('../../helpers/assert')
const { toBN, hex, hexConcat } = require('../../helpers/utils')
const { EvmSnapshot } = require('../../helpers/blockchain')
const { ecSign } = require('../../helpers/signatures')
const { ACCOUNTS_AND_KEYS } = require('../../helpers/constants')

const ERC1271SignerMock = artifacts.require('ERC1271SignerMock')
const ERC1271SignerDumbMock = artifacts.require('ERC1271SignerDumbMock')
const ERC1271MutatingSignerMock = artifacts.require('ERC1271MutatingSignerMock')
const SignatureUtilsConsumer_0_4_24 = artifacts.require('SignatureUtilsConsumer_0_4_24')
const SignatureUtilsConsumer_0_8_9 = artifacts.require('SignatureUtilsConsumer_0_8_9')

testWithConsumer(SignatureUtilsConsumer_0_4_24, 'Solidity 0.4.24')
testWithConsumer(SignatureUtilsConsumer_0_8_9, 'Solidity 0.8.9')

function testWithConsumer(SignatureUtilsConsumer, desc) {
  const ERC1271_MAGIC_VALUE = '0x1626ba7e'

  contract(`SignatureUtils.isValidSignature, ${desc}`, () => {
    const msgHash = `0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`
    let sigUtils, snapshot

    before(async () => {
      sigUtils = await SignatureUtilsConsumer.new()
      snapshot = new EvmSnapshot(ethers.provider)
      await snapshot.make()
    })

    afterEach(async () => {
      await snapshot.rollback()
    })

    context(`signer is a EOA`, () => {
      const [alice, bob] = ACCOUNTS_AND_KEYS

      it(`returns true given a valid ECDSA signature`, async () => {
        const sig = ecSign(msgHash, alice.key)
        assert.isTrue(await sigUtils.isValidSignature(alice.address, msgHash, sig.v, sig.r, sig.s))
      })

      it(`returns false given a valid ECDSA signature from another account`, async () => {
        const sig = ecSign(msgHash, bob.key)
        assert.isFalse(await sigUtils.isValidSignature(alice.address, msgHash, sig.v, sig.r, sig.s))
      })

      it(`reverts on an invalid ECDSA signature`, async () => {
        const sig = ecSign(msgHash, alice.key)

        const MAX_S = '0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0'
        const INVALID_S = '0x' + hex(toBN(MAX_S).addn(1), 32)

        await assert.reverts(
          sigUtils.isValidSignature(alice.address, msgHash, sig.v, sig.r, INVALID_S),
          `ECDSA: invalid signature 's' value`
        )

        const INVALID_V = 1

        await assert.reverts(
          sigUtils.isValidSignature(alice.address, msgHash, INVALID_V, sig.r, sig.s),
          `ECDSA: invalid signature 'v' value`
        )
      })
    })

    context(`signer is a contract (ERC1271)`, () => {
      const v = '0xff'
      const r = '0x8badf00d8badf00d8badf00d8badf00d8badf00d8badf00d8badf00d8badf00d'
      const s = '0xc00010ffc00010ffc00010ffc00010ffc00010ffc00010ffc00010ffc00010ff'

      context(`checks the signer.isValidSignature call result`, () => {
        let signerContract

        before(async () => {
          signerContract = await ERC1271SignerDumbMock.new()
          await snapshot.make()
        })

        it(`returns true when the call returns the magic value`, async () => {
          await signerContract.configure({ reverts: false, retval: ERC1271_MAGIC_VALUE })
          assert.isTrue(await sigUtils.isValidSignature(signerContract.address, msgHash, v, r, s))
        })

        it(`returns false when the call returns any other value`, async () => {
          await signerContract.configure({ reverts: false, retval: '0x' + hex(toBN(ERC1271_MAGIC_VALUE).addn(1), 4) })
          assert.isFalse(await sigUtils.isValidSignature(signerContract.address, msgHash, v, r, s))

          await signerContract.configure({ reverts: false, retval: '0x00000000' })
          assert.isFalse(await sigUtils.isValidSignature(signerContract.address, msgHash, v, r, s))

          await signerContract.configure({ reverts: false, retval: '0x12345678' })
          assert.isFalse(await sigUtils.isValidSignature(signerContract.address, msgHash, v, r, s))
        })

        it(`returns false when the call reverts`, async () => {
          await signerContract.configure({ reverts: true, retval: ERC1271_MAGIC_VALUE })
          assert.isFalse(await sigUtils.isValidSignature(signerContract.address, msgHash, v, r, s))
        })
      })

      context(`packs the signature when passing to signer.isValidSignature`, () => {
        //
        it(`the passed signature contains r, s, and then v`, async () => {
          const signerContract = await ERC1271SignerMock.new()

          await signerContract.configure({
            validHash: msgHash,
            validSig: hexConcat(r, s, v),
            retvalOnValid: ERC1271_MAGIC_VALUE,
            retvalOnInvalid: '0x00000000',
          })

          assert.isTrue(await sigUtils.isValidSignature(signerContract.address, msgHash, v, r, s))
        })
      })

      context(`returns false when the signer contract misbehaves`, () => {
        //
        it(`signer contract attempts to modify the state`, async () => {
          const signerContract = await ERC1271MutatingSignerMock.new()
          assert.isFalse(await sigUtils.isValidSignature(signerContract.address, msgHash, v, r, s))
          assert.equals(await signerContract.callCount_isValidSignature(), 0)
        })
      })
    })
  })
}
