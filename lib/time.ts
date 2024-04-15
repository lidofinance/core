import { ethers } from "hardhat";

import { time } from "@nomicfoundation/hardhat-network-helpers";

import { SECONDS_PER_SLOT } from "./constants";

export function minutes(number: bigint): bigint {
  return number * 60n;
}

export function hours(number: bigint): bigint {
  return number * minutes(60n);
}

export function days(number: bigint): bigint {
  return number * hours(24n);
}

export async function getNextBlockTimestamp() {
  const latestBlockTimestamp = BigInt(await time.latest());
  const nextBlockTimestamp = latestBlockTimestamp + SECONDS_PER_SLOT;
  await time.setNextBlockTimestamp(nextBlockTimestamp);
  return nextBlockTimestamp;
}

export async function getNextBlockNumber() {
  const latestBlock = BigInt(await time.latestBlock());
  return latestBlock + 1n;
}

export async function getNextBlock() {
  const [timestamp, number] = await Promise.all([getNextBlockTimestamp(), getNextBlockNumber()]);

  return {
    timestamp,
    number,
  };
}

export async function advanceChainTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
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
