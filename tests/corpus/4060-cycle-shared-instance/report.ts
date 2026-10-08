import { stock } from "./inventory.ts";

export function summary(): string {
  const parts: string[] = [];
  for (const [name, qty] of stock.items) parts.push(`${name}=${qty}`);
  return parts.join(", ") + ` (total ${stock.count()})`;
}
