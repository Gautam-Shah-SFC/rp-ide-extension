import * as fs from "fs";
import { InteractionRecord } from "../class/InteractionRecord";
import { logger } from "../utils/logger";

function ensureFile(queueFilePath: string): void {
  if (!fs.existsSync(queueFilePath)) {
    fs.writeFileSync(queueFilePath, "");
  }
}

export function appendRecords(queueFilePath: string, records: InteractionRecord[]): void {
  ensureFile(queueFilePath);
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(queueFilePath, lines);
}

export function readAll(queueFilePath: string): InteractionRecord[] {
  ensureFile(queueFilePath);
  const raw = fs.readFileSync(queueFilePath, "utf8").trim();
  if (!raw) {
    return [];
  }
  const records: InteractionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      logger.warn(`bufferService: skipping unparsable queue line: ${String(err)}`);
    }
  }
  return records;
}

export function peekBatch(queueFilePath: string, batchSize: number): InteractionRecord[] {
  return readAll(queueFilePath).slice(0, batchSize);
}

export function removeRecords(queueFilePath: string, sentIds: Set<string>): void {
  const remaining = readAll(queueFilePath).filter((r) => !sentIds.has(r.id));
  const lines = remaining.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(queueFilePath, remaining.length ? lines + "\n" : "");
}

export function queueLength(queueFilePath: string): number {
  return readAll(queueFilePath).length;
}
