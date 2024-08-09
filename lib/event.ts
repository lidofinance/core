import {
  ContractTransactionReceipt,
  EventLog,
  Interface,
  InterfaceAbi,
  Log,
  LogDescription,
  TransactionReceipt,
} from "ethers";

import { log } from "./log";

const parseEventLog = (entry: EventLog): LogDescription | null => {
  try {
    return entry.interface.parseLog(entry);
  } catch (error) {
    log.error(`Error parsing EventLog: ${(error as Error).message}`);
    return null;
  }
};

const parseWithInterfaces = (entry: Log, interfaces: Interface[]): LogDescription | null => {
  for (const iface of interfaces) {
    try {
      const logDescription = iface.parseLog(entry);
      if (logDescription) {
        return logDescription;
      }
    } catch (error) {
      log.error(`Error parsing log with interface: ${(error as Error).message}`);
    }
  }
  return null;
};

const parseLogEntry = (entry: Log, interfaces: Interface[]): LogDescription | null => {
  if (entry instanceof EventLog) {
    return parseEventLog(entry);
  } else if (interfaces) {
    return parseWithInterfaces(entry, interfaces);
  }
  return null;
};

export function findEventsWithInterfaces(receipt: ContractTransactionReceipt, eventName: string, interfaces: Interface[]): LogDescription[] {
  const events: LogDescription[] = [];
  const notParsedLogs: Log[] = [];

  receipt.logs.forEach(entry => {
    const logDescription = parseLogEntry(entry, interfaces);
    if (logDescription) {
      events.push(logDescription);
    } else {
      notParsedLogs.push(entry);
    }
  });

  if (notParsedLogs.length > 0) {
    // log.warning("The following logs could not be parsed:", notParsedLogs);
  }

  return events.filter(e => e.name === eventName);
}

export function findEvents(receipt: ContractTransactionReceipt, eventName: string) {
  const events = [];

  for (const entry of receipt.logs) {
    if (entry instanceof EventLog && entry.fragment.name === eventName) {
      events.push(entry);
    }
  }

  return events;
}

export function findEventsWithAbi(receipt: TransactionReceipt, eventName: string, abi: InterfaceAbi): LogDescription[] {
  const iface = new Interface(abi);
  const foundEvents = [];

  for (const entry of receipt.logs) {
    try {
      const event = iface.parseLog(entry);
      if (event && event.name == eventName) {
        foundEvents.push(event);
      }
    } catch (error) {
      throw new Error(`Failed to find event ${eventName}, error: ${error}`);
    }
  }

  return foundEvents;
}
