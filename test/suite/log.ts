import { bold, grey, magenta, yellow } from "chalk";

const DEFAULT_PADDING = 8;

const getPrefix = (padding: number) => " ".repeat(padding);

export const logTitle = (title: string, padding = DEFAULT_PADDING): void => {
  console.log(`${getPrefix(padding)}${magenta(bold(title))}`);
};

export const logMessage = (label: string, value: string, padding = DEFAULT_PADDING): void => {
  console.log(`${getPrefix(padding)}${grey(label)}: ${yellow(value)}`);
};

export const logBlock = (title: string, messages: Record<string, string>, padding = DEFAULT_PADDING): void => {
  logTitle(title, padding);
  Object.keys(messages).forEach((label) => logMessage(label, messages[label], padding + 2));
};
