const { contract, artifacts } = require('hardhat')
const { assert } = require('../helpers/assert')

async function deployBehindOssifiableProxy(artifactName, proxyOwner, constructorArgs = []) {
  const Contract = await artifacts.require(artifactName)
  const implementation = await Contract.new(...constructorArgs, { from: proxyOwner })
  const OssifiableProxy = await artifacts.require('OssifiableProxy')
  const proxy = await OssifiableProxy.new(implementation.address, proxyOwner, [], { from: proxyOwner })
  const proxied = await Contract.at(proxy.address)
  return { implementation, proxy, proxied }
}

contract('Versioned', ([admin, proxyOwner, account2, member1, member2]) => {
  let versionedImpl
  let versionedProxied
  const VERSION_INIT = 1
  const VERSION_ZERO = 0

  before('Deploy', async () => {
    const deployed = await deployBehindOssifiableProxy(
      'contracts/0.4.24/test_helpers/VersionedMock.sol:VersionedMock',
      proxyOwner,
      []
    )
    versionedImpl = deployed.implementation
    versionedProxied = deployed.proxied
  })

  describe('raw implementation', async () => {
    it('default version is petrified', async () => {
      const versionPetrified = await versionedImpl.getPetrifiedVersionMark()
      assert.equals(await versionedImpl.getContractVersion(), versionPetrified)
      await assert.reverts(versionedImpl.checkContractVersion(VERSION_ZERO), `UNEXPECTED_CONTRACT_VERSION`)
    })
  })

  describe('behind proxy', () => {
    it('default version is zero', async () => {
      const version = await versionedProxied.getContractVersion()
      console.log(+version)
      assert.equals(version, VERSION_ZERO)
      await assert.reverts(versionedProxied.checkContractVersion(VERSION_INIT), `UNEXPECTED_CONTRACT_VERSION`)
    })

    it('version can be set and event should be emitted', async () => {
      const prevVersion = +(await versionedProxied.getContractVersion())
      const nextVersion = prevVersion + 1
      const tx = await versionedProxied.setContractVersion(nextVersion)
      assert.emits(tx, 'ContractVersionSet', { version: nextVersion })
      await assert.reverts(versionedProxied.checkContractVersion(prevVersion), `UNEXPECTED_CONTRACT_VERSION`)
      const newVersion = +(await versionedProxied.getContractVersion())
      assert.equals(newVersion, nextVersion)
    })
  })
})
