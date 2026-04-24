import readline from "node:readline";

import { artifacts, ethers, network } from "hardhat";

import { bl, ConvertibleToString, cy, gr, gy, log, or, rd, toBool, yg, yl } from "lib";

export async function confirm(question: string): Promise<void> {
  const AUTO_CONFIRM = toBool(process.env.AUTO_CONFIRM);
  if (AUTO_CONFIRM) {
    log.warning(" •", rd(`Auto-confirming!`));
    return;
  }

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

export async function buildArgRecords(
  contract: string,
  args: readonly ConvertibleToString[],
  method: string = "constructor",
) {
  if (args.length === 0) return { [`${method} args`]: args };

  const constructorAbi = (await artifacts.readArtifact(contract)).abi.find(
    (entry) => entry.type === method || (entry.type === "function" && entry.name === method),
  );
  const argNames =
    constructorAbi?.inputs?.map((input: { name?: string }, index: number) => input.name || `arg${index}`) ?? [];

  return args.reduce<Record<string, ConvertibleToString>>(
    (r, a, i) => ((r[`${method} arg [${i}] ${or(argNames[i] || `arg${i}`)}`] = a), r),
    {},
  );
}

export async function logArgs(
  contract: string,
  args: readonly ConvertibleToString[],
  method: string = "constructor",
  note: string = "new impl.",
) {
  log.info(`${contract} ${note}`, {
    [cy("call method")]: `${yg(contract)}::${gy(method)}`,
    ...(await buildArgRecords(contract, args, method)),
  });
}
