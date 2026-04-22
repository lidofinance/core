import readline from "node:readline";

import { artifacts, ethers, network } from "hardhat";

import { bl, ConvertibleToString, gr, gy, log, or, rd, yg, yl } from "lib";

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

export async function logScriptHeader(title: string, deployer?: string) {
  const { chainId } = await ethers.provider.getNetwork();

  log.splitter();
  log.header(title);
  log.splitter();

  log.info("Network", {
    "name": yl(network.name),
    "chain ID": yl(chainId.toString()),
  });

  if (deployer) {
    const deployerBalance = await ethers.provider.getBalance(deployer);
    log.info("Deployer", {
      address: bl(deployer),
      balance: `${gr(ethers.formatEther(deployerBalance))} ETH`,
    });
  }
}

export function logStartReview(msg?: string) {
  log.emptyLine();
  log.splitter();
  log.warning(" •", rd(msg || `Start review here ${or("↓↓↓")}`));
  log.splitter();
  log.emptyLine();
}
export async function logConfirmReview(msg?: string) {
  log.splitter();
  log.warning(" •", rd(msg || `Please review ${or("↑↑↑")} and confirm!`));
  log.splitter();
  await confirm(`Type ${gr("yes")} to confirm and start deployment: `);
  log.splitter();
  log.emptyLine();
}

export async function buildArgsLog(
  contract: string,
  args: readonly ConvertibleToString[],
  method: string = "constructor",
): Promise<Record<string, string>> {
  if (args.length === 0) {
    return { [`${method} args`]: yl("-") };
  }

  const artifact = await artifacts.readArtifact(contract);
  const constructorAbi = artifact.abi.find(
    (entry) => entry.type === method || (entry.type === "function" && entry.name === method),
  );
  const argNames =
    constructorAbi?.inputs?.map((input: { name?: string }, index: number) => input.name || `arg${index}`) ?? [];

  const data: Record<string, string> = {};
  args.forEach((arg, index) => {
    const name = argNames[index] || `arg${index}`;
    data[`${method} arg [${index}] ${or(name)}`] =
      typeof arg === "string" && ethers.isAddress(arg) ? bl(arg) : yl(arg.toString());
  });
  return data;
}

export async function logArgs(
  contract: string,
  args: readonly ConvertibleToString[],
  method: string = "constructor",
  note: string = "new impl.",
) {
  log.info(`${contract} ${note}`, {
    contract: `${yg(contract)}::${gy(method)}`,
    ...(await buildArgsLog(contract, args, method)),
  });
}
