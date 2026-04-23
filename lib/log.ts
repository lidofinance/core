import chalk from "chalk";
import { isAddress } from "ethers";
import path from "path";

import { getTxLink } from "./explorer";

// @ts-expect-error TS2339: Property 'toJSON' does not exist on type 'BigInt'.
BigInt.prototype.toJSON = function () {
  return this.toString();
};

export type ConvertibleToString = string | number | boolean | { toString(): string };

export const rd = chalk.keyword("red"); // more intense than chalk.red
export const yl = chalk.yellow;
export const gr = chalk.green;
export const bl = chalk.keyword("dodgerblue"); //chalk.blue;
export const cy = chalk.cyan;
export const mg = chalk.keyword("violet"); // not so jarring
export const or = chalk.keyword("orange");
export const br = chalk.keyword("brown");
export const dp = chalk.keyword("deeppink");
export const gy = chalk.keyword("greenyellow");
export const yg = chalk.keyword("yellowgreen");
export const nv = chalk.keyword("navy");
export const bk = chalk.keyword("black");

export const log = (...args: ConvertibleToString[]) => {
  if (!shouldLog("info")) return;
  console.log(...args);
};

const MIN_LINE_LENGTH = 4;
const LINE_LENGTH = 20;
const LONG_LINE_LENGTH = 40;

export const OK = "✅";
export const NOT_OK = "🚨";
export const WARN = "⚠️";

const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// Log levels: error < warn < info < debug < all
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  all: 4,
} as const;

const shouldLog = (level: keyof typeof LOG_LEVELS): boolean => {
  const currentLevel = LOG_LEVELS[LOG_LEVEL as keyof typeof LOG_LEVELS] ?? LOG_LEVELS.info;
  const messageLevel = LOG_LEVELS[level];
  return messageLevel <= currentLevel;
};

const _line = (length = LINE_LENGTH, minLength = LINE_LENGTH): string => "=".repeat(Math.max(length, minLength));

const _splitter = (minLength = LINE_LENGTH, ...args: ConvertibleToString[]) => {
  if (!shouldLog("info")) return;

  if (minLength < MIN_LINE_LENGTH) minLength = MIN_LINE_LENGTH;

  console.error(bk(_line(0, minLength)));

  if (args.length) {
    console.error(...args);
  }
};

const _header = (minLength = 20, ...args: ConvertibleToString[]) => {
  if (!shouldLog("info")) return;

  if (minLength < MIN_LINE_LENGTH) minLength = MIN_LINE_LENGTH;

  const title = args[0]?.toString().trim() ?? "";
  const totalLength = Math.max(title.length + 4, minLength);

  const line = _line(totalLength + 4, minLength);
  const paddedTitle = title.padStart((totalLength + title.length) / 2).padEnd(totalLength);

  console.error(`${cy(line)}`);
  console.error(`${cy("=")} ${dp(paddedTitle)} ${cy("=")}`);
  console.error(`${cy(line)}`);

  if (args.length > 1) {
    console.error(...args.slice(1).map((s) => s.toString()));
  }

  log.emptyLine();
};

const _title = (title: string) => {
  if (!shouldLog("debug")) return;
  log(br(title));
};

const FORMAT_INDENT = 2;

const _indent = (depth: number) => " ".repeat(depth * FORMAT_INDENT);

const _formatRecordValue = (value: unknown, depth = 0, seen = new WeakSet<object>()): string => {
  if (value === null) return chalk.gray("null");
  if (value === undefined) return chalk.gray("undefined");

  if (typeof value === "string") {
    return isAddress(value) ? bl(value) : yl(value);
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return gr(value.toString());
  }

  if (typeof value === "boolean") {
    return mg(value.toString());
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return chalk.gray("[Circular]");
    if (value.length === 0) return chalk.gray("[]");

    seen.add(value);
    const lines = value.map((item) => `${_indent(depth + 1)}${_formatRecordValue(item, depth + 1, seen)}`);
    seen.delete(value);
    return `[\n${lines.join(",\n")}\n${_indent(depth)}]`;
  }

  if (typeof value === "object") {
    if (seen.has(value)) return chalk.gray("{Circular}");
    const entries = Object.entries(value);
    if (entries.length === 0) return chalk.gray("{}");

    seen.add(value);
    const lines = entries.map(
      ([key, nested]) => `${_indent(depth + 1)}${or(key)}: ${_formatRecordValue(nested, depth + 1, seen)}`,
    );
    seen.delete(value);
    return `{\n${lines.join(",\n")}\n${_indent(depth)}}`;
  }

  return yl(String(value));
};

const _record = (label: string, value: ConvertibleToString) => {
  const formattedValue = _formatRecordValue(value, 2);
  // if (formattedValue.includes("\n")) {
  //   log(`${nv(label)}:`);
  //   log(formattedValue.replace(/^/gm, _indent(2)));
  //   return;
  // }

  log(`${nv(label)}: ${formattedValue}`);
};

// TODO: add logging to file

// TODO: fix log levels

log.noEOL = (...args: ConvertibleToString[]) => {
  if (!shouldLog("info")) return;
  process.stdout.write(args.toString());
};

log.success = (...args: ConvertibleToString[]) => {
  if (!shouldLog("info")) return;
  console.log(OK, ...args);
};

log.error = (...args: ConvertibleToString[]) => {
  if (!shouldLog("error")) return;
  console.error(NOT_OK, ...args);
};

log.warning = (...args: ConvertibleToString[]) => {
  if (!shouldLog("warn")) return;
  console.error(WARN, ...args);
};

log.splitter = (...args: ConvertibleToString[]) => _splitter(LONG_LINE_LENGTH, ...args);

log.table = (...args: ConvertibleToString[]) => {
  if (!shouldLog("info")) return;
  console.table(...args);
};

log.emptyLine = () => {
  if (!shouldLog("info")) return;
  console.log();
};

log.header = (...args: ConvertibleToString[]) => _header(LINE_LENGTH, ...args);

log.withArguments = (firstLine: string, args: ConvertibleToString[]) => {
  if (!shouldLog("info")) return;

  log.noEOL(`${firstLine}(`);

  if (args.length === 0) {
    log(`)`);
    return;
  }

  if (args.length === 1) {
    log(`${or(JSON.stringify(args[0]))})`);
    return;
  }

  log.emptyLine();
  args.forEach((arg) => log(` ${or(JSON.stringify(arg))},`));
  log(`)`);
};

log.scriptStart = (filename: string) => {
  if (!shouldLog("info")) return;

  log.splitter();
  log(`Started script: ${bl(path.basename(filename))}`);
  log.splitter();
  log.emptyLine();
};

log.scriptFinish = (filename: string) => {
  if (!shouldLog("info")) return;

  log.success(`Finished script: ${bl(path.basename(filename))}`);
  log.emptyLine();
};

log.done = (message: string) => {
  if (!shouldLog("info")) return;

  log.success(message);
  log.emptyLine();
};

log.debug = (title: string, records: Record<string, ConvertibleToString> = {}) => {
  if (!shouldLog("debug")) return;

  _title(title);
  Object.keys(records).forEach((label) => _record(`${_indent(1)}${label}`, records[label]));
  log.emptyLine();
};

log.info = (title: string, records: Record<string, ConvertibleToString> = {}) => {
  if (!shouldLog("info")) return;

  _title(title);
  Object.keys(records).forEach((label) => _record(`${_indent(1)}${label}`, records[label]));
  log.emptyLine();
};

log.txLink = async (txHash: string) => {
  const link = await getTxLink(txHash);
  if (link) {
    log.info("🔗 Transaction", {
      Link: chalk.blue.underline(link),
    });
  }
};
