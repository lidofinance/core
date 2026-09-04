import { expect } from "chai";
import hre from "hardhat";

import { SECONDS_PER_SLOT } from "./constants.js";

export function minutes(number: bigint): bigint {
  return number * 60n;
}

export function hours(number: bigint): bigint {
  return number * minutes(60n);
}

export function days(number: bigint): bigint {
  return number * hours(24n);
}

export async function getCurrentBlockTimestamp() {
  const { ethers } = await hre.network.getOrCreate();
  const blockNum = await ethers.provider.getBlockNumber();
  const block = await ethers.provider.getBlock(blockNum);
  return BigInt(block?.timestamp ?? 0);
}

export async function getNextBlockTimestamp() {
  const { networkHelpers } = await hre.network.getOrCreate();
  const latestBlockTimestamp = BigInt(await networkHelpers.time.latest());
  const nextBlockTimestamp = latestBlockTimestamp + SECONDS_PER_SLOT;
  await networkHelpers.time.setNextBlockTimestamp(nextBlockTimestamp);
  return nextBlockTimestamp;
}

export async function getCurrentBlockNumber() {
  const { ethers } = await hre.network.getOrCreate();
  return await ethers.provider.getBlockNumber();
}

export async function getNextBlockNumber() {
  const { networkHelpers } = await hre.network.getOrCreate();
  const latestBlock = BigInt(await networkHelpers.time.latestBlock());
  return latestBlock + 1n;
}

export async function getNextBlock() {
  const [timestamp, number] = await Promise.all([getNextBlockTimestamp(), getNextBlockNumber()]);

  return {
    timestamp,
    number,
  };
}

export async function advanceChainTime(seconds: bigint) {
  const { ethers } = await hre.network.getOrCreate();
  const currentTimestamp = await getCurrentBlockTimestamp();
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(currentTimestamp + seconds)]);
  await ethers.provider.send("evm_mine");

  expect(await getCurrentBlockTimestamp()).to.be.equal(
    currentTimestamp + seconds,
    "Chain time was not advanced correctly",
  );
}

export function formatTimeInterval(sec: number | bigint) {
  if (typeof sec === "bigint") {
    sec = parseInt(sec.toString());
  }

  function floor(n: number, multiplier: number) {
    return Math.floor(n * multiplier) / multiplier;
  }

  const HOUR = 60 * 60;
  const DAY = HOUR * 24;
  const MONTH = DAY * 30;
  const YEAR = DAY * 365;

  if (sec > YEAR) {
    return floor(sec / YEAR, 100) + " year(s)";
  }
  if (sec > MONTH) {
    return floor(sec / MONTH, 10) + " month(s)";
  }
  if (sec > DAY) {
    return floor(sec / DAY, 10) + " day(s)";
  }
  return `${sec} second(s)`;
}
