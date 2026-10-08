import { validate } from "./rules.ts";

console.log("ledger body");
export const total: number = validate([3, 4, -1]);
console.log("ledger never finishes", total);
