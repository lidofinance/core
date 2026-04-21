import readline from "node:readline";

import { artifacts, ethers } from "hardhat";

import { bl, ConvertibleToString, cy, gr, log, rd, yl } from "lib";

export async function confirm(question: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question(question, (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "yes") {
        resolve();
      } else {
        reject(new Error(`Aborted by user (got "${answer.trim()}")`));
      }
    });
  });
}

export async function checkConfirm(msg?: string) {
  log.splitter();
  log(rd(msg || "Please review the parameters above carefully before proceeding."));
  log.splitter();
  await confirm(`Type ${gr("yes")} to confirm and start deployment: `);
  log.splitter();
}

export async function buildArgsLog(
  contractName: string,
  argVals: readonly ConvertibleToString[],
  method: string = "constructor",
): Promise<Record<string, string>> {
  if (argVals.length === 0) {
    return { [`${method} args`]: yl("-") };
  }

  const artifact = await artifacts.readArtifact(contractName);
  const constructorAbi = artifact.abi.find(
    (entry) => entry.type === method || (entry.type === "function" && entry.name === method),
  );
  const argNames =
    constructorAbi?.inputs?.map((input: { name?: string }, index: number) => input.name || `arg${index}`) ?? [];

  const data: Record<string, string> = {};
  argVals.forEach((arg, index) => {
    const name = argNames[index] || `arg${index}`;
    data[`${method} arg [${index}] ${name}`] =
      typeof arg === "string" && ethers.isAddress(arg) ? bl(arg) : yl(arg.toString());
  });
  return data;
}

export async function logArgs(
  contractName: string,
  argVals: readonly ConvertibleToString[],
  method: string = "constructor",
  note: string = "new impl.",
) {
  log.info(`${contractName} ${note}`, {
    contract: `${yl(contractName)}::${cy(method)}`,
    ...(await buildArgsLog(contractName, argVals, method)),
  });
}
