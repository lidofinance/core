import {
  ContractTransactionReceipt,
  EventLog,
  Interface,
  InterfaceAbi,
  LogDescription,
  TransactionReceipt,
} from "ethers";

export function findEvents(receipt: ContractTransactionReceipt, eventName: string) {
  const events = [];

  for (const log of receipt.logs) {
    if (log instanceof EventLog && log.fragment.name === eventName) {
      events.push(log);
    }
  }

  return events;
}

export function findEventsWithAbi(receipt: TransactionReceipt, eventName: string, abi: InterfaceAbi): LogDescription[] {
  const iface = new Interface(abi);
  const foundEvents = [];

  for (const log of receipt.logs) {
    try {
      const event = iface.parseLog(log);
      if (event && event.name == eventName) {
        foundEvents.push(event);
      }
    } catch (error) {
      throw new Error(`Failed to find event ${eventName}, error: ${error}`);
    }
  }

  return foundEvents;
}
