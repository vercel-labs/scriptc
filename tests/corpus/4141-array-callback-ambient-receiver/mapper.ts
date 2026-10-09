import { peek } from "./peek.mjs";

function viaHelper(value: number): string {
  return `${value}:${peek()}`;
}

// Inline callbacks are called directly. Those that reach a receiver read
// must still run with an undefined receiver, whatever binding is active
// around the array call.
export function mapPeek(): string {
  const values = [1, 2, 3];
  const direct = values.map((value) => `${value}:${peek()}`).join(",");
  const nested = values.map((value) => viaHelper(value)).join(",");
  const kept = values.filter((value) => peek() === "undefined" && value > 1).join(",");
  const any = values.some((value) => peek() !== "undefined" && value > 0);
  const total = values.reduce((sum, value) => sum + (peek() === "undefined" ? value : 100), 0);
  return [direct, nested, kept, String(any), String(total)].join(" | ");
}
