import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { cy, log, yl } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";

const MAX_HOLDERS_IN_ONE_TX = 30;

function formatDate(unixTimestamp: number) {
  return new Date(unixTimestamp * 1000).toUTCString();
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const vesting = state[Sk.vestingParams];
  const pairs = Object.entries(vesting.holders);
  const holders = pairs.map((p) => p[0]);
  const amounts = pairs.map((p) => BigInt(p[1] as string));

  // Log vesting settings
  log(`Using vesting settings:`);
  log(` Start:`, yl(formatDate(vesting.start as number)));
  log(` Cliff:`, yl(formatDate(vesting.cliff as number)));
  log(` End:`, yl(formatDate(vesting.end as number)));
  log(` Revokable:`, yl(vesting.revokable));

  // Calculate and log total supply
  const totalSupply = amounts.reduce((acc, v) => acc + v, BigInt(vesting.unvestedTokensAmount));
  log(` Total supply:`, yl(ethers.formatEther(totalSupply.toString())));
  log(` Unvested tokens amount:`, yl(ethers.formatEther(vesting.unvestedTokensAmount)));
  log(` Token receivers (total ${yl(holders.length)}):`);

  // Log individual holder amounts and percentages
  holders.forEach((addr, i) => {
    const amount = amounts[i];
    const percentage = (amount * 10000n) / totalSupply / 100n;
    log(`  ${cy(addr)}: ${yl(ethers.formatEther(amount))} (${percentage}%)`);
  });

  // Calculate number of transactions needed
  const holdersInOneTx = Math.min(MAX_HOLDERS_IN_ONE_TX, holders.length);
  const totalTransactions = Math.ceil(holders.length / holdersInOneTx);

  log(` Total batches:`, yl(totalTransactions));
  log.emptyLine();

  const template = await getContractAt("LidoTemplate", state[Sk.lidoTemplate].address);
  let endTotalSupply = 0n;

  // Issue tokens in batches
  for (let i = 0; i < totalTransactions; ++i) {
    const startIndex = i * holdersInOneTx;
    const iHolders = holders.slice(startIndex, startIndex + holdersInOneTx);
    const iAmounts = amounts.slice(startIndex, startIndex + holdersInOneTx);

    endTotalSupply = iAmounts.reduce((acc, v) => acc + v, endTotalSupply);

    await makeTx(
      template,
      "issueTokens",
      [
        iHolders,
        iAmounts,
        vesting.start,
        vesting.cliff,
        vesting.end,
        vesting.revokable,
        "0x" + endTotalSupply.toString(16),
      ],
      { from: deployer },
    );
  }
}
