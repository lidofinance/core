const { network, ethers } = require('hardhat')
const chalk = require('chalk')
const { Contract } = require('ethers')
const { encodeCallScript } = require('@aragon/contract-helpers-test/src/aragon-os')
const { getEventArgument } = require('@aragon/contract-helpers-test')
const runOrWrapScript = require('../helpers/run-or-wrap-script')
const { log, yl, gr } = require('../helpers/log')
// const { saveCallTxData } = require('../helpers/tx-data')
const { resolveLatestVersion } = require('../components/apm')
const {
  readNetworkState,
  assertRequiredNetworkState,
  persistNetworkState2,
} = require('../helpers/persisted-network-state')
const { resolveEnsAddress } = require('../components/ens')
const { hash: namehash } = require('eth-ens-namehash')
const { APP_NAMES, APP_ARTIFACTS } = require('../constants')
const {
  getDeployer,
  readStateAppAddress,
  getSignature,
  KERNEL_APP_BASES_NAMESPACE,
  MANAGE_SIGNING_KEYS,
  MANAGE_NODE_OPERATOR_ROLE,
  SET_NODE_OPERATOR_LIMIT_ROLE,
  STAKING_ROUTER_ROLE,
  STAKING_MODULE_MANAGE_ROLE,
  SIMPLE_DVT_IPFS_CID,
} = require('./helpers')

const APP_TRG = process.env.APP_TRG || APP_NAMES.SIMPLE_DVT
const APP_IPFS_CID = process.env.APP_IPFS_CID || SIMPLE_DVT_IPFS_CID
const DEPLOYER = process.env.DEPLOYER || ''

const SIMULATE = !!process.env.SIMULATE
const VOTE_ID = process.env.VOTE_ID || ''

const REQUIRED_NET_STATE = [
  'ensAddress',
  'lidoApmAddress',
  'lidoApmEnsName',
  'daoAddress',
  'lidoLocator',
  `app:${APP_NAMES.ARAGON_VOTING}`,
  `app:${APP_NAMES.ARAGON_TOKEN_MANAGER}`,
]

async function deployNORClone({ web3, artifacts, trgAppName = APP_TRG, ipfsCid = APP_IPFS_CID }) {
  const netId = await web3.eth.net.getId()

  const srcAppName = APP_NAMES.NODE_OPERATORS_REGISTRY

  log.splitter()
  log(`Network ID: ${chalk.yellow(netId)}`)

  const deployer = await getDeployer(web3, DEPLOYER)
  const state = readNetworkState(network.name, netId)
  assertRequiredNetworkState(state, REQUIRED_NET_STATE.concat([`app:${srcAppName}`, `app:${trgAppName}`]))

  log.splitter()

  log(`Using ENS:`, yl(state.ensAddress))
  const ens = await artifacts.require('ENS').at(state.ensAddress)
  const lidoLocatorAddress = readStateAppAddress(state, `lidoLocator`)
  log(`Lido Locator:`, yl(lidoLocatorAddress))
  log.splitter()

  const srcAppFullName = `${srcAppName}.${state.lidoApmEnsName}`
  const srcAppId = namehash(srcAppFullName)
  const { semanticVersion, contractAddress } = await resolveLatestVersion(srcAppId, ens, artifacts)
  const srcVersion = semanticVersion.map((n) => n.toNumber())

  log(`Source App:`, yl(srcAppName))
  log(`Source App ENS:`, yl(srcAppFullName))
  log(`Source App ID:`, yl(srcAppId))
  log(`Source Contract implementation:`, yl(contractAddress))
  log(`Source App version:`, yl(srcVersion.join('.')))
  log.splitter()

  const trgAppFullName = `${trgAppName}.${state.lidoApmEnsName}`
  const trgAppId = namehash(trgAppFullName)
  const trgProxyAddress = readStateAppAddress(state, `app:${trgAppName}`)
  const trgAppArtifact = APP_ARTIFACTS[srcAppName] // get source app artifact
  const trgApp = await artifacts.require(trgAppArtifact).at(trgProxyAddress)

  // set new version to 1.0.0
  const trgVersion = [1, 0, 0]
  const contentURI = '0x' + Buffer.from(`ipfs:${ipfsCid}`, 'utf8').toString('hex')

  log(`Target App:`, yl(trgAppName))
  log(`Target App ENS:`, yl(trgAppFullName))
  log(`Target App ID:`, yl(trgAppId))
  log(`Target App proxy`, yl(trgProxyAddress))
  log(`Target Contract implementation:`, yl(contractAddress))
  log(`Target Content IPFS CID:`, yl(ipfsCid))
  log(`Target Content URI:`, yl(contentURI))
  log(`Target App version:`, yl(trgVersion.join('.')))

  log.splitter()
  const {
    moduleName,
    moduleType = 'curated',
    targetShare = 1000,
    moduleFee = 500,
    treasuryFee = 500,
    penaltyDelay,
    easyTrackAddress,
    easyTrackEVMScriptExecutor,
    easyTrackFactories = {},
  } = state[`app:${trgAppName}`].stakingRouterModuleParams
  log(`Target SR Module name`, yl(moduleName))
  log(`Target SR Module type`, yl(moduleType))
  log(`Target SR Module fee`, yl(moduleFee))
  log(`Target SR Module targetShare`, yl(targetShare))
  log(`Target SR Module treasuryFee`, yl(treasuryFee))
  log(`Target SR Module penaltyDelay`, yl(penaltyDelay))

  if (!trgProxyAddress || (await web3.eth.getCode(trgProxyAddress)) === '0x') {
    log.error(`Target app proxy is not yet deployed!`)
    return
  }

  const trgRepoAddress = await resolveEnsAddress(artifacts, ens, trgAppId)

  if (trgRepoAddress && (await web3.eth.getCode(trgProxyAddress)) !== '0x') {
    log(`Target App APM repo:`, yl(trgRepoAddress))
    log.error(`Target app is already deployed!`)
    return
  }

  // preload voting and stakingRouter addresses
  const votingAddress = readStateAppAddress(state, `app:${APP_NAMES.ARAGON_VOTING}`)
  const tokenManagerAddress = readStateAppAddress(state, `app:${APP_NAMES.ARAGON_TOKEN_MANAGER}`)
  const srAddress = readStateAppAddress(state, 'stakingRouter')

  const kernel = await artifacts.require('Kernel').at(state.daoAddress)
  const aclAddress = await kernel.acl()
  const acl = await artifacts.require('ACL').at(aclAddress)
  const stakingRouter = await artifacts.require('StakingRouter').at(srAddress)
  const apmRegistry = await artifacts.require('APMRegistry').at(state.lidoApmAddress)

  const voteDesc = `Clone app '${srcAppName}' to '${trgAppName}'`
  const voting = await artifacts.require('Voting').at(votingAddress)
  const tokenManager = await artifacts.require('TokenManager').at(tokenManagerAddress)
  const agentAddress = readStateAppAddress(state, `app:${APP_NAMES.ARAGON_AGENT}`)
  const agent = await artifacts.require('Agent').at(agentAddress)

  const easytrackABI = [
    {
      inputs: [
        {
          internalType: 'address',
          name: '_evmScriptFactory',
          type: 'address',
        },
        {
          internalType: 'bytes',
          name: '_permissions',
          type: 'bytes',
        },
      ],
      name: 'addEVMScriptFactory',
      outputs: [],
      stateMutability: 'nonpayable',
      type: 'function',
    },
  ]

  // use ethers.js Contract instance
  const easytrack = new Contract(easyTrackAddress, easytrackABI)
  const evmScriptCalls = [
    // create app repo
    {
      to: apmRegistry.address,
      calldata: await apmRegistry.contract.methods
        .newRepoWithVersion(trgAppName, votingAddress, trgVersion, contractAddress, contentURI)
        .encodeABI(),
    },
    // link appId with implementations
    {
      to: kernel.address,
      calldata: await kernel.contract.methods.setApp(KERNEL_APP_BASES_NAMESPACE, trgAppId, contractAddress).encodeABI(),
    },
    // initialize module
    {
      to: trgApp.address,
      calldata: await trgApp.contract.methods
        .initialize(lidoLocatorAddress, '0x' + Buffer.from(moduleType).toString('hex').padEnd(64, '0'), penaltyDelay)
        .encodeABI(),
    },
  ]

  // set permissions

  // grant perm for staking router
  evmScriptCalls.push({
    to: acl.address,
    calldata: await acl.contract.methods
      .createPermission(srAddress, trgProxyAddress, STAKING_ROUTER_ROLE, votingAddress)
      .encodeABI(),
  })

  // grant perms to easytrack evm script executor
  evmScriptCalls.push({
    to: acl.address,
    calldata: await acl.contract.methods
      .grantPermission(easyTrackEVMScriptExecutor, trgProxyAddress, STAKING_ROUTER_ROLE)
      .encodeABI(),
  })

  evmScriptCalls.push({
    to: acl.address,
    calldata: await acl.contract.methods
      .createPermission(easyTrackEVMScriptExecutor, trgProxyAddress, MANAGE_NODE_OPERATOR_ROLE, votingAddress)
      .encodeABI(),
  })
  evmScriptCalls.push({
    to: acl.address,
    calldata: await acl.contract.methods
      .createPermission(easyTrackEVMScriptExecutor, trgProxyAddress, SET_NODE_OPERATOR_LIMIT_ROLE, votingAddress)
      .encodeABI(),
  })

  // grant manager to easytrack evm script executor
  evmScriptCalls.push({
    to: acl.address,
    calldata: await acl.contract.methods
      .createPermission(easyTrackEVMScriptExecutor, trgProxyAddress, MANAGE_SIGNING_KEYS, easyTrackEVMScriptExecutor)
      .encodeABI(),
  })

  // grant perms to easytrack factories
  evmScriptCalls.push({
    to: easytrack.address,
    calldata: await easytrack.interface.encodeFunctionData('addEVMScriptFactory', [
      easyTrackFactories.AddNodeOperators,
      trgProxyAddress +
        getSignature(trgApp, 'addNodeOperator').substring(2) +
        aclAddress.substring(2) +
        getSignature(acl, 'grantPermissionP').substring(2),
    ]),
  })
  evmScriptCalls.push({
    to: easytrack.address,
    calldata: await easytrack.interface.encodeFunctionData('addEVMScriptFactory', [
      easyTrackFactories.ActivateNodeOperators,
      trgProxyAddress +
        getSignature(trgApp, 'activateNodeOperator').substring(2) +
        aclAddress.substring(2) +
        getSignature(acl, 'grantPermissionP').substring(2),
    ]),
  })
  evmScriptCalls.push({
    to: easytrack.address,
    calldata: await easytrack.interface.encodeFunctionData('addEVMScriptFactory', [
      easyTrackFactories.DeactivateNodeOperators,
      trgProxyAddress +
        getSignature(trgApp, 'deactivateNodeOperator').substring(2) +
        aclAddress.substring(2) +
        getSignature(acl, 'revokePermission').substring(2),
    ]),
  })
  evmScriptCalls.push({
    to: easytrack.address,
    calldata: await easytrack.interface.encodeFunctionData('addEVMScriptFactory', [
      easyTrackFactories.SetVettedValidatorsLimits,
      trgProxyAddress + getSignature(trgApp, 'setNodeOperatorStakingLimit').substring(2),
    ]),
  })
  evmScriptCalls.push({
    to: easytrack.address,
    calldata: await easytrack.interface.encodeFunctionData('addEVMScriptFactory', [
      easyTrackFactories.UpdateTargetValidatorLimits,
      trgProxyAddress + getSignature(trgApp, 'updateTargetValidatorsLimits').substring(2),
    ]),
  })
  evmScriptCalls.push({
    to: easytrack.address,
    calldata: await easytrack.interface.encodeFunctionData('addEVMScriptFactory', [
      easyTrackFactories.SetNodeOperatorNames,
      trgProxyAddress + getSignature(trgApp, 'setNodeOperatorName').substring(2),
    ]),
  })
  evmScriptCalls.push({
    to: easytrack.address,
    calldata: await easytrack.interface.encodeFunctionData('addEVMScriptFactory', [
      easyTrackFactories.SetNodeOperatorRewardAddresses,
      trgProxyAddress + getSignature(trgApp, 'setNodeOperatorRewardAddress').substring(2),
    ]),
  })
  evmScriptCalls.push({
    to: easytrack.address,
    calldata: await easytrack.interface.encodeFunctionData('addEVMScriptFactory', [
      easyTrackFactories.TransferNodeOperatorManager,
      aclAddress +
        getSignature(acl, 'revokePermission').substring(2) +
        aclAddress.substring(2) +
        getSignature(acl, 'grantPermissionP').substring(2),
    ]),
  })

  // check missed STAKING_MODULE_MANAGE_ROLE role on Agent
  if (!(await stakingRouter.hasRole(STAKING_MODULE_MANAGE_ROLE, voting.address))) {
    const grantRoleCallData = await stakingRouter.contract.methods
      .grantRole(STAKING_MODULE_MANAGE_ROLE, agent.address)
      .encodeABI()
    evmScriptCalls.push({
      to: agent.address,
      calldata: await agent.contract.methods.execute(stakingRouter.address, 0, grantRoleCallData).encodeABI(),
    })
  }

  // add module to SR
  const addModuleCallData = await stakingRouter.contract.methods
    .addStakingModule(
      moduleName, // name
      trgProxyAddress, // module address
      targetShare,
      moduleFee,
      treasuryFee
    )
    .encodeABI()
  evmScriptCalls.push({
    to: agent.address,
    calldata: await agent.contract.methods.execute(stakingRouter.address, 0, addModuleCallData).encodeABI(),
  })

  const newVoteEvmScript = encodeCallScript([
    {
      to: voting.address,
      calldata: await voting.contract.methods
        .newVote(encodeCallScript(evmScriptCalls), voteDesc, false, false)
        .encodeABI(),
    },
  ])

  // skip update if VOTE_ID set
  if (!VOTE_ID) {
    // save app info
    persistNetworkState2(network.name, netId, state, {
      [`app:${trgAppName}`]: {
        fullName: trgAppFullName,
        name: trgAppName,
        id: trgAppId,
        ipfsCid,
        contentURI,
        implementation: contractAddress,
        contract: trgAppArtifact,
      },
    })
  }

  if (SIMULATE) {
    log.splitter()
    log(gr(`Simulating voting creation and enact!`))
    // create voting on behalf of dao agent
    await ethers.getImpersonatedSigner(agentAddress)

    let voteId
    if (!VOTE_ID) {
      const result = await tokenManager.forward(newVoteEvmScript, { from: agentAddress, gasPrice: 0 })
      voteId = getEventArgument(result, 'StartVote', 'voteId', { decodeForAbi: voting.abi })
      log(`Voting created, id`, yl(voteId))
    } else {
      voteId = VOTE_ID
    }

    // vote
    log(`Enacting voting, id`, yl(voteId))
    await voting.vote(voteId, true, true, { from: agentAddress, gasPrice: 0 })
    const voteTime = (await voting.voteTime()).toNumber()
    // pass time and enact
    await ethers.provider.send('evm_increaseTime', [voteTime])
    await ethers.provider.send('evm_mine')
    await voting.executeVote(voteId, { from: deployer, gasPrice: 0 })

    log(`Target App initialized`, yl(await trgApp.hasInitialized()))
  } else {
    const tx = await log.tx(
      `Voting: Clone app '${srcAppName}' to '${trgAppName}'`,
      tokenManager.forward(newVoteEvmScript, { from: deployer })
    )

    const voteId = getEventArgument(tx, 'StartVote', 'voteId', { decodeForAbi: voting.abi })
    log(`Voting created, id`, yl(voteId))
  }
  // else {
  //   await saveCallTxData(
  //     `Voting: Clone app '${srcAppName}' to '${trgAppName}'`,
  //     tokenManager,
  //     'forward',
  //     `clone-tx-02-create-voting.json`,
  //     {
  //       arguments: [newVoteEvmScript],
  //       from: deployer,
  //     }
  //   )
  //   // console.log({ txData })

  //   log.splitter()
  //   log(gr(`Before continuing the cloning, please send voting creation transactions`))
  //   log(gr(`that you can find in the file listed above. You may use a multisig address`))
  //   log(gr(`if it supports sending arbitrary tx.`))
  // }

  log.splitter()
}

module.exports = runOrWrapScript(deployNORClone, module)