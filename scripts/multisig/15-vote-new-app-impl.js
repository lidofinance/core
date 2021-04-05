const { hash: namehash } = require('eth-ens-namehash')
const { encodeCallScript } = require('@aragon/contract-helpers-test/src/aragon-os')

const runOrWrapScript = require('../helpers/run-or-wrap-script')
const { log, logSplitter, logWideSplitter, yl, gr } = require('../helpers/log')
const { saveCallTxData } = require('../helpers/tx-data')
const { readNetworkState, assertRequiredNetworkState, persistNetworkState } = require('../helpers/persisted-network-state')
const { resolveEnsAddress } = require('../components/ens')

// this is needed for the following `require`s to work, some kind of typescript path magic
require('@aragon/buidler-aragon/dist/bootstrap-paths')
const { toContentUri } = require('@aragon/buidler-aragon/dist/src/utils/apm/utils')

const { APP_NAMES } = require('./constants')
const VALID_APP_NAMES = Object.entries(APP_NAMES).map((e) => e[1])

const APP = process.env.APP || ''
const BUMP = process.env.BUMP || 'major'
const HOLDER = process.env.HOLDER || ''
const CONTENT_CID = process.env.CONTENT_CID
const REQUIRED_NET_STATE = [
  'lidoApmEnsName',
  'ensAddress',
  'daoAddress',
  `app:${APP_NAMES.ARAGON_VOTING}`,
  `app:${APP_NAMES.ARAGON_TOKEN_MANAGER}`
]

async function upgradeAppImpl({ web3, artifacts, appName = APP }) {
  if (!appName || !VALID_APP_NAMES.includes(appName)) {
    throw new Error('Wrong app name')
  }

  const netId = await web3.eth.net.getId()

  logWideSplitter()
  log(`Network ID:`, yl(netId))

  const state = readNetworkState(network.name, netId)
  assertRequiredNetworkState(state, REQUIRED_NET_STATE.concat([`app:${appName}`]))

  logSplitter()

  log(`Using ENS:`, yl(state.ensAddress))
  const ens = await artifacts.require('ENS').at(state.ensAddress)
  log.splitter()

  const appId = namehash(`${appName}.${state.lidoApmEnsName}`)
  const repoAddress = await resolveEnsAddress(artifacts, ens, appId)
  const votingAddress = state[`app:${APP_NAMES.ARAGON_VOTING}`].proxyAddress
  const tokenManagerAddress = state[`app:${APP_NAMES.ARAGON_TOKEN_MANAGER}`].proxyAddress
  const appBaseAddress = state[`app:${appName}`].baseAddress
  const oracleAddress = state[`app:${APP}`].proxyAddress

  const oracle = await artifacts.require('LidoOracle').at(oracleAddress)
  const kernel = await artifacts.require('Kernel').at(state.daoAddress)
  const repo = await artifacts.require('Repo').at(repoAddress)
  const voting = await artifacts.require('Voting').at(votingAddress)
  const tokenManager = await artifacts.require('TokenManager').at(tokenManagerAddress)
  const newContentURI = toContentUri('ipfs', CONTENT_CID)

  const aclAddress = await kernel.acl()
  const APP_BASES_NAMESPACE = await kernel.APP_BASES_NAMESPACE()

  const SET_REPORT_BOUNDARIES = '0x44adaee26c92733e57241cb0b26ffaa2d182ed7120ba3ecd7e0dce3635c01dc1'
  const SET_BEACON_REPORT_RECEIVER = '0xe22a455f1bfbaf705ac3e891a64e156da92cb0b42cfc389158e6e82bd57f37be'

  const acl = await artifacts.require('ACL').at(aclAddress)

  const { semanticVersion, contractAddress, contentURI } = await repo.getLatest()
  const versionFrom = semanticVersion.map((n) => n.toNumber())
  switch (BUMP) {
    case 'patch':
      semanticVersion[2] = semanticVersion[2].addn(1)
      break
    case 'minor':
      semanticVersion[1] = semanticVersion[1].addn(1)
      break
    case 'major':
    default:
      semanticVersion[0] = semanticVersion[0].addn(1)
  }
  const versionTo = semanticVersion.map((n) => n.toNumber())

  log(`Upgrading app:`, yl(appName))
  log(`appId:`, appId)
  log(`Contract implementation:`, yl(contractAddress), `->`, yl(appBaseAddress))
  log(`Bump version:`, yl(versionFrom), `->`, yl(versionTo))
  log(`Content URI:`, yl(contentURI), `->`, yl(newContentURI))
  log(`Oracle proxy address:`, yl(oracleAddress))
  log(`Voting address:`, yl(votingAddress))
  log(`ACL address:`, yl(aclAddress))
  log.splitter()
  if (contractAddress === appBaseAddress) {
    throw new Error('No new implementation found')
  }

  // encode call to Repo app for newVersion
  const callData1 = encodeCallScript([
    {
      // repo.newVersion(versionTo, address oracle_impl, newContentURI)
      to: repoAddress,
      calldata: await repo.contract.methods.newVersion(versionTo, appBaseAddress, newContentURI).encodeABI()
    },
    {
      // kernel.setApp(APP_BASES_NAMESPACE, appId, oracle)
      to: state.daoAddress,
      calldata: await kernel.contract.methods.setApp(APP_BASES_NAMESPACE, appId, appBaseAddress).encodeABI()
    },
    {
      // acl.createPermission(voting, oracle, SET_REPORT_BOUNDARIES, voting)
      to: aclAddress,
      calldata: await acl.contract.methods.createPermission(votingAddress, oracleAddress, SET_REPORT_BOUNDARIES, votingAddress).encodeABI()
    },
    {
      // acl.createPermission(voting, oracle, SET_BEACON_REPORT_RECEIVER, voting)
      to: aclAddress,
      calldata: await acl.contract.methods
        .createPermission(votingAddress, oracleAddress, SET_BEACON_REPORT_RECEIVER, votingAddress)
        .encodeABI()
    },
    {
      // oracle.initialize_v2(...)
      to: oracleAddress,
      calldata: await oracle.contract.methods.initialize_v2(1000, 500).encodeABI()
    }
  ])
  // encode forwarding call from Voting app to app Repo (new Vote will be created under the hood)
  const callData2 = encodeCallScript([
    {
      to: votingAddress,
      calldata: await voting.contract.methods.forward(callData1).encodeABI()
    }
  ])
  // finally forwarding call from TokenManager app to Voting
  await saveCallTxData(`New voting: ${appName} new impl`, tokenManager, 'forward', `tx-15-1-create-vote-new-${appName}-version.json`, {
    arguments: [callData2],
    from: HOLDER || state.multisigAddress
  })

  log.splitter()
  log(gr(`Before continuing the deployment, please send all transactions listed above.`))
  log(gr(`A new voting will be created to add a new "${appName}" implementation to Lido APM.`))
  log(gr(`You must complete it positively and execute before continuing with the deployment!`))
  log.splitter()

  // persistNetworkState(network.name, netId, state)
}

module.exports = runOrWrapScript(upgradeAppImpl, module)
