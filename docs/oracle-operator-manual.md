# Oracle Operator Manual

This document is intended for those who wish to participate in the Lido protocol as Oracle—an entity who runs a daemon synchronizing state from ETH2 to ETH1 part of the protocol. To be precise, the daemon fetches the number of validators participating in the protocol, as well as their combined balance, from the Beacon chain and submits this data to the `LidoOracle` ETH1 smart contract.

## TL;DR

1. Generate an Ethereum address and propose it as an oracle address via the "Add Member" button [in the app UI].
2. Facilitate the DAO members to approve your oracle address.
3. Launch and sync an Ethereum 1.0 node pointed to Görli with JSON-RPC endpoint enabled.
4. Launch and sync a Lighthouse node pointed to Pyrmont with RPC endpoint enabled (Prysm is not yet supported).
5. Launch the oracle daemon as a docker container:

    ```sh
    export ETH1_NODE=http://localhost:8545
    export BEACON_NODE=http://lighthouse:5052
    export POOL_CONTRACT=0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84
    export DAEMON=1
    export MEMBER_PRIV_KEY=$ORACLE_PRIVATE_KEY_0X_PREFIXED
    export ORACLE_FROM_BLOCK=11595281
    docker run -d --name lido-oracle -e ETH1_NODE -e BEACON_NODE -e POOL_CONTRACT -e DAEMON -e MEMBER_PRIV_KEY -e ORACLE_FROM_BLOCK -it lidofinance/oracle:0.1.4
    ```

Here, `ORACLE_PRIVATE_KEY_0X_PREFIXED` environment variable should be populated with the private key of the address from step 1.

[in the app UI]: https://goerli.lido.fi/#/lido-dao-testnet/0x8aa931352fedc2a5a5b3e20ed3a546414e40d86c

## Intro

Total supply of the StETH token always corresponds to the amount of Ether in control of the protocol. It increases on user deposits and Beacon chain staking rewards, and decreases on Beacon chain penalties and slashings. Since the Beacon chain is a separate chain, Lido ETH1 smart contracts can’t get direct access to its data.

Communication between Ethereum 1.0 part of the system and the Beacon network is performed by the DAO-assigned oracles. They monitor staking providers’ Beacon chain accounts and submit corresponding data to the `LidoOracle` contract. The latter takes care of making sure that quorum about the data being pushed is reached within the oracles and enforcing data submission order (so that oracle contract never pushes data that is older than the already pushed one).

Upon every update submitted by the `LidoOracle` contract, the system recalculates the total StETH token balance. If the overall staking rewards are bigger than the slashing penalties, the system registers profit, and fee is taken from the profit and distributed between the insurance fund, the treasury, and node operators.

## Prerequisites

In order to launch oracle daemon on your machine, you need to have several things:

1. A synced Ethereum 1.0 client pointed to the Görli testnet and with JSON-RPC endpoint enabled.
2. A synced Lighthouse client pointed to Pyrmont testnet and with RPC endpoint enabled (Prysm client not yet supported).
3) An address that’s added to the approved oracles list here: https://goerli.lido.fi/#/lido-dao-testnet/0x8aa931352fedc2a5a5b3e20ed3a546414e40d86c. You have to initiate the DAO voting on adding your address there by pressing the "Add Member" button.

## The oracle daemon

The oracle daemon is a simple Python app that watches the Beacon chain and pushes the data to the [`LidoOracle` Smart Contract](https://goerli.etherscan.io/address/0x8aA931352fEdC2A5a5b3E20ed3A546414E40D86C).

The oracle source code is available at https://github.com/lidofinance/lido-oracle. The docker image is available in the public Docker Hub registry: https://hub.docker.com/r/lidofinance/oracle.

The algorithm of the above oracle implementation is simple: at each step of an infinite loop, the daemon fetches the reportable epoch from the `LidoOracle` contract, and if this epoch is finalized on the Beacon chain, pushes the data to the `LidoOracle` contract by submitting a transaction. The transaction contains a tuple:

```text
(
  epoch,
  sum_of_balances_of_lido_validators,
  number_of_lido_validators_on_beacon
)
```

Keep in mind that some of these transactions may revert. This happens when a transaction finalizing the current frame gets included in a block before your oracle's transaction. For example, such a transaction might had already been submitted by another oracle (but not yet included in a block) when your oracle fetched the current reportable epoch.

#### Environment variables

The oracle daemon requires the following environment variables:

* `ETH1_NODE` the ETH1 JSON-RPC endpoint.
* `BEACON_NODE` the Lighthouse RPC endpoint.
* `POOL_CONTRACT` the address of the Lido contract (`0xA5d26F68130c989ef3e063c9bdE33BC50a86629D` in Görli/Pyrmont).
* `MANAGER_PRIV_KEY` 0x-prefixed private key of the address used by the oracle (should be in the DAO-approved list).

#### Running the daemon

You can use the public Docker image to launch the daemon:

```sh
export ETH1_NODE=$ETH1_NODE_RPC_ADDRESS
export BEACON_NODE=$BEACON_NODE_RPC_ADDRESS
export POOL_CONTRACT=0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84
export DAEMON=1
export MEMBER_PRIV_KEY=$ORACLE_PRIVATE_KEY_0X_PREFIXED
export ORACLE_FROM_BLOCK=11595281
docker run -d --name lido-oracle -e ETH1_NODE -e BEACON_NODE -e POOL_CONTRACT -e DAEMON -e MEMBER_PRIV_KEY -e ORACLE_FROM_BLOCK -it lidofinance/oracle:0.1.4
```

This will start the oracle in daemon mode. You can also run it in a one-off mode, for example if you’d prefer to trigger oracle execution as a `cron` job. In this case, skip passing the `--daemon` flag to the oracle and the `-d` flag to `docker run`.

To skip sending the transaction and just see what oracle is going to report, don’t pass the `DAEMON` flag:

```sh
export ETH1_NODE=$ETH1_NODE_RPC_ADDRESS
export BEACON_NODE=$BEACON_NODE_RPC_ADDRESS
export POOL_CONTRACT=0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84
export ORACLE_FROM_BLOCK=11595281
docker run --rm -e ETH1_NODE -e BEACON_NODE -e POOL_CONTRACT -e ORACLE_FROM_BLOCK -it lidofinance/oracle:0.1.4
```
