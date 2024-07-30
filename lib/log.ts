import chalk from "chalk";
import path from "path";

import { TraceableTransaction } from "./type";

export type ConvertibleToString = string | number | boolean | { toString(): string };

export const rd = (s: ConvertibleToString) => chalk.red(s);
export const yl = (s: ConvertibleToString) => chalk.yellow(s);
export const gr = (s: ConvertibleToString) => chalk.green(s);
export const bl = (s: ConvertibleToString) => chalk.blue(s);
export const cy = (s: ConvertibleToString) => chalk.cyan(s);
export const mg = (s: ConvertibleToString) => chalk.magenta(s);

export const log = (...args: ConvertibleToString[]) => console.log(...args);

const INDENT = "    ";

const MIN_LINE_LENGTH = 4;
const LINE_LENGTH = 20;
const LONG_LINE_LENGTH = 40;

export const OK = gr("[✓]");
export const NOT_OK = rd("[×]");

const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const _line = (length = LINE_LENGTH, minLength = LINE_LENGTH): string => "=".repeat(Math.max(length, minLength));

const _splitter = (minLength = LINE_LENGTH, ...args: ConvertibleToString[]) => {
  if (minLength < MIN_LINE_LENGTH) minLength = MIN_LINE_LENGTH;

  console.error(cy(_line(0, minLength)));

  if (args.length) {
    console.error(...args);
  }
};

const _header = (minLength = 20, ...args: ConvertibleToString[]) => {
  if (minLength < MIN_LINE_LENGTH) minLength = MIN_LINE_LENGTH;

  const title = args[0]?.toString().trim() ?? "";
  const totalLength = Math.max(title.length + 4, minLength);

  const line = _line(totalLength + 4, minLength);
  const paddedTitle = title.padStart((totalLength + title.length) / 2).padEnd(totalLength);

  console.error(`\n${cy(line)}`);
  console.error(`${cy("=")} ${mg(paddedTitle)} ${cy("=")}`);
  console.error(`${cy(line)}`);

  if (args.length > 1) {
    console.error(...args.slice(1).map((s) => s.toString()));
  }
};

const _title = (title: string) => log(mg(title));

const _record = (label: string, value: ConvertibleToString) => log(`${chalk.grey(label)}: ${yl(value.toString())}`);

// TODO: add logging to file

// TODO: fix log levels

log.noEOL = (...args: ConvertibleToString[]) => process.stdout.write(args.toString() + " ");

log.success = (...args: ConvertibleToString[]) => console.log(OK, ...args);

log.error = (...args: ConvertibleToString[]) => console.error(NOT_OK, ...args);

log.splitter = (...args: ConvertibleToString[]) => _splitter(LINE_LENGTH, ...args);

log.wideSplitter = (...args: ConvertibleToString[]) => _splitter(LONG_LINE_LENGTH, ...args);

log.table = (...args: ConvertibleToString[]) => console.table(...args);

log.emptyLine = () => console.log();

log.header = (...args: ConvertibleToString[]) => _header(LINE_LENGTH, ...args);

log.withArguments = (firstLine: string, args: ConvertibleToString[]) => {
  log.noEOL(`${firstLine.trim()} (`);
  if (args.length > 0) {
    log.emptyLine();
  }
  for (const arg of args) {
    log(`${INDENT}${arg}`);
  }
  log(`)... `);
};

log.scriptStart = (filename: string) => {
  log.emptyLine();
  log.wideSplitter();
  log(`Started script ${bl(path.basename(filename))}`);
  log.wideSplitter();
};

log.scriptFinish = (filename: string) => {
  log(`Finished running script ${bl(path.basename(filename))}`);
};

log.done = (message: string) => {
  log.success(message);
  log.emptyLine();
};

log.debug = (title: string, records: Record<string, ConvertibleToString>) => {
  if (LOG_LEVEL != "debug" && LOG_LEVEL != "all") return;

  _title(title);
  Object.keys(records).forEach((label) => _record(`  ${label}`, records[label]));
  log.emptyLine();
};

log.warning = (title: string, ...args: ConvertibleToString[]): void => {
  log(chalk.bold.yellow(title));
  args.forEach((arg) => log(arg));
  log.emptyLine();
};

log.traceTransaction = (name: string, tx: TraceableTransaction) => {
  const value = tx.value === "0.0" ? "" : `Value: ${yl(tx.value)} ETH`;
  const from = `From: ${yl(tx.from)}`;
  const to = `To: ${yl(tx.to)}`;
  const gasPrice = `Gas price: ${yl(tx.gasPrice)} gwei`;
  const gasLimit = `Gas limit: ${yl(tx.gasLimit)}`;
  const gasUsed = `Gas used: ${yl(tx.gasUsed)} (${yl(tx.gasUsedPercent)})`;
  const block = `Block: ${yl(tx.blockNumber)}`;
  const nonce = `Nonce: ${yl(tx.nonce)}`;

  const color = tx.status ? gr : rd;
  const status = `${color(name)} ${color(tx.status ? "confirmed" : "failed")}`;

  log(`Transaction sent:`, yl(tx.hash));
  log(`   ${from}   ${to}   ${value}`);
  log(`   ${gasPrice}   ${gasLimit}   ${gasUsed}`);
  log(`   ${block}   ${nonce}`);
  log(`   ${status}`);
  log.emptyLine();
};
