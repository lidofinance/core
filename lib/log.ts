import chalk from "chalk";
import path from "path";

// @ts-expect-error TS2339: Property 'toJSON' does not exist on type 'BigInt'.
BigInt.prototype.toJSON = function () {
  return this.toString();
};

export type ConvertibleToString = string | number | boolean | { toString(): string };

export const rd = (s: ConvertibleToString) => chalk.red(s);
export const yl = (s: ConvertibleToString) => chalk.yellow(s);
export const gr = (s: ConvertibleToString) => chalk.green(s);
export const bl = (s: ConvertibleToString) => chalk.blue(s);
export const cy = (s: ConvertibleToString) => chalk.cyan(s);
export const mg = (s: ConvertibleToString) => chalk.magenta(s);

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

  console.error(cy(_line(0, minLength)));

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
  console.error(`${cy("=")} ${mg(paddedTitle)} ${cy("=")}`);
  console.error(`${cy(line)}`);

  if (args.length > 1) {
    console.error(...args.slice(1).map((s) => s.toString()));
  }

  log.emptyLine();
};

const _title = (title: string) => {
  if (!shouldLog("debug")) return;
  log(mg(title));
};

const _record = (label: string, value: ConvertibleToString) => {
  log(`${chalk.grey(label)}: ${yl(value.toString())}`);
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
    log(`${mg(JSON.stringify(args[0]))})`);
    return;
  }

  log.emptyLine();
  args.forEach((arg) => log(` ${mg(JSON.stringify(arg))},`));
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
  Object.keys(records).forEach((label) => _record(`  ${label}`, records[label]));
  log.emptyLine();
};

log.info = (title: string, records: Record<string, ConvertibleToString> = {}) => {
  if (!shouldLog("info")) return;

  _title(title);
  Object.keys(records).forEach((label) => _record(`  ${label}`, records[label]));
  log.emptyLine();
};
