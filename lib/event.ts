import { ContractTransactionReceipt, EventLog, Interface, Log, LogDescription } from "ethers";

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

export function findEventsWithInterfaces(
  receipt: ContractTransactionReceipt,
  eventName: string,
  interfaces: Interface[],
  numberOfIndexedParams?: number,
): LogDescription[] {
  const events: LogDescription[] = [];
  const notParsedLogs: Log[] = [];

  const topics0OfInterest = interfaces.map((iface) => {
    return iface.getEvent(eventName)?.topicHash;
  });

  receipt.logs.forEach((entry) => {
    if (
      !topics0OfInterest.includes(entry.topics[0]) ||
      (numberOfIndexedParams !== undefined && entry.topics.length !== numberOfIndexedParams + 1)
    ) {
      // We do preliminary filtering here to avoid unnecessary parsing
      // and possible 'Error parsing log with interface "data out-of-bounds"'
      // errors in iface.parseLog used inside of parseLogEntry if parseLog
      // called upon log not matching the interface
      // We also filter out logs with different number of indexed params
      // to distinguish cases like Transfer of ERC20 and NFT which have
      // the same signature but different number of indexed params:
      //   event Transfer(address indexed from, address indexed to, uint256 value);
      //   event Transfer(address indexed from, address indexed to, uint256 indexed requestId);
      return;
    }

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

  return events.filter((e) => e.name === eventName);
}

// NB: This function might mislead because receipt.logs might be Log[]
//     instead of EventLog[] and no event would be found
export function findEvents(receipt: ContractTransactionReceipt, eventName: string) {
  const events = [];

  for (const entry of receipt.logs) {
    if (entry instanceof EventLog && entry.fragment.name === eventName) {
      events.push(entry);
    }
  }

  return events;
}
