import { summary } from "./report.ts";

export class Inventory {
  items: Map<string, number> = new Map();
  add(name: string, qty: number): void {
    this.items.set(name, (this.items.get(name) ?? 0) + qty);
  }
  count(): number {
    let total = 0;
    for (const qty of this.items.values()) total += qty;
    return total;
  }
}

export const stock = new Inventory();
stock.add("nut", 10);
console.log("inventory ready:", summary());
