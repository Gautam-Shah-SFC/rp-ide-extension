import * as crypto from "crypto";

export function generateId(): string {
  return crypto.randomUUID();
}
