import { randomBytes } from "node:crypto";

export function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
