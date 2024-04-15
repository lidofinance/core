import chalk from "chalk";
import path from "path";

export type ConvertibleToString = string | number | boolean | { toString(): string };

export const rd = (s: ConvertibleToString) => chalk.red(s);
export const yl = (s: ConvertibleToString) => chalk.yellow(s);
export const gr = (s: ConvertibleToString) => chalk.green(s);
export const bl = (s: ConvertibleToString) => chalk.blue(s);
export const cy = (s: ConvertibleToString) => chalk.cyan(s);
export const mg = (s: ConvertibleToString) => chalk.magenta(s);

export const log = (...args: ConvertibleToString[]) => console.log(...args);

export const OK = gr("[✓]");
export const NOT_OK = rd("[×]");
const INDENT = "    ";

log.noEOL = (...args: ConvertibleToString[]) => {
  process.stdout.write(args.toString() + " ");
};

// TODO: add logging to file
log.success = (...args: ConvertibleToString[]) => {
  console.log(OK, ...args);
};

log.error = (...args: ConvertibleToString[]) => {
  console.error(NOT_OK, ...args);
};

log.emptyLine = () => {
  console.log();
};

log.scriptStart = (filename: string) => {
  log.emptyLine();
  logWideSplitter();
  log(`Started script ${bl(path.basename(filename))}`);
  logWideSplitter();
};

log.scriptFinish = (filename: string) => {
  log(`Finished running script ${bl(path.basename(filename))}`);
};

log.lineWithArguments = (firstLine: string, args: ConvertibleToString[]) => {
  log.noEOL(`${firstLine}(`);
  if (args.length > 0) {
    log.emptyLine();
  }
  for (const arg of args) {
    log(`${INDENT}${arg}`);
  }
  log(`)... `);
};

const _line = (length = 0, minLength = 20) => "".padStart(Math.max(length, minLength), "=");

const _header = (minLength = 20, args: ConvertibleToString[]) => {
  if (minLength < 4) minLength = 4;
  const msg = "";
  if (args.length > 0 && typeof args[0] === "string") {
    args[0].toString().padEnd(minLength - 4, " ");
    args.shift();
  }
  const line = _line(msg.length + 4, minLength);
  console.error(`\n${cy(line)}\n${cy("=")} ${mg(msg)} ${cy("=")}\n${cy(line)}\n`);
  if (args.length) {
    console.error(...args);
  }
};

const _splitter = (minLength = 20, ...args: ConvertibleToString[]) => {
  if (minLength < 4) minLength = 4;
  console.error(cy(_line(0, minLength)));
  if (args.length) {
    console.error(...args);
  }
};

export function logSplitter(...args: ConvertibleToString[]) {
  _splitter(20, ...args);
}

log.splitter = logSplitter;

export function logWideSplitter(...args: ConvertibleToString[]) {
  _splitter(40, ...args);
}

log.wideSplitter = logWideSplitter;

function logHeader(...args: ConvertibleToString[]) {
  _header(40, args);
}

log.header = logHeader;

function logTable(...args: ConvertibleToString[]) {
  console.table(...args);
}

log.table = logTable;
